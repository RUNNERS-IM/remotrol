// The connection (2026-11-03 decision 「네 앱 컴퓨터판 · 휴대폰판 개발 방식」, Remote: WebRTC): computers and phones of
// the same RUNNERS account see and click each other.
//   - The relay (relay.ts) lists who is online and carries the WebRTC signals.
//   - The WebRTC connections live in the Remote window's page (src/peer.ts), which is made at launch and only hidden,
//     so this computer can be seen while nobody has the window open. Screens go there as video; questions (info,
//     a still picture, a click) go over a data channel.
//   - Whatever another device asks of this computer comes here (hostRequest), where the See This and Click and Type
//     switches and the permissions decide. The name in the log is the one the relay lists for that device.
//   - Claude's questions about other computers go the other way (peerInfo …): from here to the page, which asks over
//     its connection to that computer.
//
// Why seeing and clicking are separate switches: seeing is what a coworker asks for most ("look at this error"), and
// clicking is a bigger trust step, so it starts off. Disconnect turns seeing off, which also stops clicking.
import { app, clipboard, desktopCapturer, ipcMain, nativeImage, type WebContents } from "electron";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Allow, Computer, Display, Input, Link, LogEntry, PeerInfo } from "../preload/api";
import * as account from "./account";
import { native } from "./native";
import * as screens from "./screens";
import * as relay from "./relay";
import { readSettings, writeSettings } from "./settings";
import * as status from "./status";

const DEV = !app.isPackaged;
const LOG_KEEP = 200;
/** How long the connection log is kept on disk (decision 2026-11-19 4D), so it is still there after a restart. */
const LOG_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const LOG_SAVE_MS = 2000;
/** A computer not seen for this long leaves the grid's grey tiles. */
const KNOWN_DAYS_MS = 30 * 24 * 60 * 60 * 1000;
/** A still picture asked this narrow is a grid tile, not someone looking: it does not count as viewing, so the
 *  "seen by" line does not blink on and off while another computer only has the grid open (decision 2026-11-19 1B). */
const TILE_MAX_WIDTH = 640;
const ASK_TIMEOUT_MS = 15_000;
/** Narrowest and widest still picture a caller may ask for with `width`; the grid asks for small ones. */
const MIN_WIDTH = 160;
const MAX_WIDTH = 1280;
/** Debug runs only: REMOTE_FAKE_SCREEN=1 sends a drawn test picture instead of the screen, so two copies on one Mac can
 *  be tried without the Screen Recording permission and without anyone's screen leaving the window. */
/** REMOTE_FAKE_SCREEN=<path to a PNG or JPEG> sends that picture instead of the drawn one, for store and site pictures
 *  that need a tidy made-up desktop. */
const FAKE_PICTURE = DEV && process.env.REMOTE_FAKE_SCREEN && process.env.REMOTE_FAKE_SCREEN !== "1" ? process.env.REMOTE_FAKE_SCREEN : null;
const FAKE_SCREEN = DEV && (process.env.REMOTE_FAKE_SCREEN === "1" || FAKE_PICTURE !== null);
/** With REMOTE_FAKE_SCREEN, REMOTE_FAKE_DISPLAYS=3 says this computer has that many displays, to try side by side
 *  viewing on a Mac with one. */
const FAKE_DISPLAYS = FAKE_SCREEN ? Math.min(4, Number(process.env.REMOTE_FAKE_DISPLAYS) || 0) : 0;

function fakeDisplays(): Display[] {
  return Array.from({ length: FAKE_DISPLAYS }, (_, i) => {
    // Why the picture's own size: another size would show the picture with black bars.
    const picture = FAKE_PICTURE ? nativeImage.createFromPath(FAKE_PICTURE).getSize() : null;
    const [width, height] = picture ? [picture.width / 2, picture.height / 2] : i === 1 ? [1496, 967] : [2560, 1440];
    // Why ordinary names with a picture: those runs make store and site pictures, where "Test 1" would show.
    const name = FAKE_PICTURE ? (["Studio Display", "Built-in Retina Display"][i] ?? `Display ${i + 1}`) : `Test ${i + 1}`;
    return { id: i + 1, name, main: i === 0, x: i * 2560, y: 0, width, height, pixelWidth: width * 2, pixelHeight: height * 2 };
  });
}
/** Debug runs only: `REMOTE_FAKE_INPUT=1` prints each input from another computer instead of posting it, and keeps
 *  copied text in memory instead of this computer's clipboard, so two test copies on one Mac never click or paste in it. */
export const FAKE_INPUT = DEV && process.env.REMOTE_FAKE_INPUT === "1";
let fakeClipboard = "";

const log: LogEntry[] = [];
let page: () => WebContents | null = () => null;
let saveTimer: NodeJS.Timeout | null = null;

function logFile(): string {
  return join(app.getPath("userData"), "connection-log.json");
}

function loadLog(): void {
  try {
    const since = Date.now() - LOG_DAYS_MS;
    const saved = JSON.parse(readFileSync(logFile(), "utf8")) as LogEntry[];
    log.push(...saved.filter((entry) => entry.at > since).slice(0, LOG_KEEP));
  } catch {
    // No log yet, or an unreadable one: start empty.
  }
}

function saveLog(): void {
  saveTimer = null;
  const since = Date.now() - LOG_DAYS_MS;
  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(logFile(), JSON.stringify(log.filter((entry) => entry.at > since)));
  } catch (error) {
    console.error("connection log:", error instanceof Error ? error.message : error);
  }
}

function note(peer: string, what: LogEntry["what"], by?: LogEntry["by"]): void {
  log.unshift({ at: Date.now(), peer, what, ...(by ? { by } : {}) });
  log.length = Math.min(log.length, LOG_KEEP);
  saveTimer ??= setTimeout(saveLog, LOG_SAVE_MS);
}

/** Who on the asking device: phones join the relay only as viewers; a Claude session there marks its requests. */
function byOf(peer: relay.Device, params: Record<string, unknown>): LogEntry["by"] {
  if (params.by === "claude") return "claude";
  return peer.role === "viewer" ? "phone" : "computer";
}

/** Computers seen before, by device id, kept for the grid's grey tiles. Saved only when one comes or goes. */
type Known = { account: string | null; computers: Record<string, { name: string; lastSeen: number }> };
let known: Known | null = null;
let onlineBefore = "";

function knownFile(): string {
  return join(app.getPath("userData"), "computers.json");
}

function knownFor(email: string | null): Known {
  if (!known) {
    try {
      known = JSON.parse(readFileSync(knownFile(), "utf8")) as Known;
    } catch {
      known = { account: email, computers: {} };
    }
  }
  // Why: another account's computers are not this account's; signing in with another one starts over.
  if (known.account !== email) known = { account: email, computers: {} };
  return known;
}

// ---- What other devices ask of this computer ----

function info(): PeerInfo {
  const now = status.current();
  const settings = readSettings();
  const shown = settings.allowViewing && (now.supported || FAKE_SCREEN);
  return {
    computer: now.computer,
    // Why: with seeing off, even the monitor names stay private.
    displays: !shown ? [] : FAKE_DISPLAYS ? fakeDisplays() : screens.displays(),
    viewing: settings.allowViewing && (now.reason === null || FAKE_SCREEN),
    control: settings.allowViewing && now.permissions.accessibility,
    reason: FAKE_SCREEN ? null : now.reason,
    system: status.SYSTEM,
  };
}

/** The still picture made narrower when the caller asks for a width (the grid shows each screen small, and a full
 *  picture is about 300 KB). Without one, or when it is not narrower, the picture is sent as taken. */
function shrink(jpeg: Buffer, asked: unknown): Buffer {
  const width = Math.round(Number(asked));
  if (asked === undefined || asked === null || !Number.isFinite(width)) return jpeg;
  const image = nativeImage.createFromBuffer(jpeg);
  const target = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
  if (image.isEmpty() || image.getSize().width <= target) return jpeg;
  return image.resize({ width: target, quality: "good" }).toJPEG(70);
}

/** The debug test picture: a colour that changes every second, so a still picture visibly moves, under speckles that
 *  make the JPEG large enough (over 100 KB) to be sent in parts like a real screen. */
let fakeJpeg: Buffer | null = null;

function fakePicture(): Buffer {
  if (FAKE_PICTURE) return (fakeJpeg ??= nativeImage.createFromPath(FAKE_PICTURE).toJPEG(90));
  const width = 1280;
  const height = 800;
  const pixels = Buffer.alloc(width * height * 4);
  const shade = (Math.floor(Date.now() / 1000) * 40) % 256;
  for (let i = 0; i < pixels.length; i += 4) {
    const speck = (i * 2654435761) >>> 24;
    pixels[i] = (shade + speck) & 255;
    pixels[i + 1] = 120;
    pixels[i + 2] = (255 - shade + speck) & 255;
    pixels[i + 3] = 255;
  }
  return nativeImage.createFromBitmap(pixels, { width, height }).toJPEG(70);
}

function logKind(input: Input): LogEntry["what"] | null {
  if (input.kind === "click") return "click";
  if (input.kind === "press") return input.down ? "click" : null;
  if (input.kind === "key") return "key";
  if (input.kind === "text") return "text";
  return null;
}

/** Every computer with the grid open asks for a tile every 2 seconds. Why one shared picture: each capture is a
 *  ScreenCaptureKit request served by macOS's replayd, which was found holding 1 to 2.5 GB on Macs that had Remotrol
 *  open for days, so seven askers make one capture instead of seven. A tile a second old looks the same; a large
 *  picture (the screen view, Claude) is always taken new. */
const TILE_SHARE_MS = 1500;
const tileShots = new Map<number, { at: number; jpeg: Promise<Buffer> }>();

function tilePicture(display: number): Promise<Buffer> {
  const now = Date.now();
  const last = tileShots.get(display);
  if (last && now - last.at < TILE_SHARE_MS) return last.jpeg;
  const jpeg = screens.capture(display);
  tileShots.set(display, { at: now, jpeg });
  // Why: a failed capture (permission off, display gone) is not shared, so the next ask tries again.
  jpeg.catch(() => {
    if (tileShots.get(display)?.jpeg === jpeg) tileShots.delete(display);
  });
  return jpeg;
}

/** The capture source Chromium needs for a display (macOS gives both the same display id). */
async function sourceFor(display: number): Promise<string> {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 0, height: 0 } });
  const source = sources.find((s) => s.display_id === String(display)) ?? (display === 0 ? sources[0] : undefined);
  if (!source) throw new Error("display");
  return source.id;
}

/** One question from another device. Throws a short code the asking side turns into text: forbidden, off, control,
 *  accessibility, unsupported, permission, display, or a message. */
async function hostRequest(peerId: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const peer = relay.device(peerId);
  if (!peer) throw new Error("forbidden");
  const settings = readSettings();
  const now = status.current();

  if (method === "info") return info();
  const by = byOf(peer, params);
  if (!settings.allowViewing) {
    if (method === "frame" || method === "watch" || method === "input") note(peer.name, "refused", by);
    throw new Error("off");
  }
  if (method === "front") return status.SUPPORTED ? JSON.parse(native.frontApp()) : null;
  if (method === "viewing") {
    if (status.remoteFrameSent(peer.name)) note(peer.name, "view", by);
    return true;
  }
  if (method === "frame") {
    if (FAKE_SCREEN) return shrink(fakePicture(), params.width);
    if (!status.SUPPORTED) throw new Error("unsupported");
    const tile = typeof params.width === "number" && params.width <= TILE_MAX_WIDTH;
    const jpeg = tile ? await tilePicture(Number(params.display)) : await screens.capture(Number(params.display));
    if (!tile && status.remoteFrameSent(peer.name)) note(peer.name, "view", by);
    return shrink(jpeg, params.width);
  }
  if (method === "watch") {
    if (FAKE_SCREEN) return FAKE_PICTURE ? { fake: true, picture: `data:image/jpeg;base64,${fakePicture().toString("base64")}` } : { fake: true };
    if (!status.SUPPORTED) throw new Error("unsupported");
    if (!now.permissions.screenRecording) throw new Error("permission");
    if (status.remoteFrameSent(peer.name)) note(peer.name, "view", by);
    return { sourceId: await sourceFor(Number(params.display)) };
  }
  if (method === "input") {
    if (!settings.allowViewing) {
      note(peer.name, "refused", by);
      throw new Error("control");
    }
    const input = params.input as Input;
    if (FAKE_INPUT) console.log("input:", JSON.stringify(input));
    else {
      if (!status.SUPPORTED) throw new Error("unsupported");
      if (!now.permissions.accessibility) throw new Error("accessibility");
      screens.sendInput(input);
    }
    const kind = logKind(input);
    if (kind) note(peer.name, kind, by);
    return "sent";
  }
  // Copy and paste with the computer on screen: only while it lets others see it, like the keys that copy.
  if (method === "clipboardGet" || method === "clipboardSet") {
    if (!settings.allowViewing) {
      note(peer.name, "refused", by);
      throw new Error("control");
    }
    if (method === "clipboardSet") {
      const text = String(params.text ?? "");
      if (FAKE_INPUT) {
        fakeClipboard = text;
        console.log("clipboard set:", text);
      } else clipboard.writeText(text);
      note(peer.name, "paste", by);
      return "sent";
    }
    note(peer.name, "copy", by);
    return FAKE_INPUT ? fakeClipboard || "fake copied text" : clipboard.readText();
  }
  throw new Error(`unknown method ${method}`);
}

// ---- Asking other computers (for Claude), through the page ----

const waiting = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

function askPage(host: string, method: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const target = page();
  if (!target) return Promise.reject(new Error("unreachable"));
  if (relay.device(host)?.role !== "host") return Promise.reject(new Error("unreachable"));
  const rid = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      waiting.delete(rid);
      reject(new Error("unreachable"));
    }, ASK_TIMEOUT_MS);
    waiting.set(rid, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    target.send("remote:clientRequest", { rid, device: host, method, params });
  });
}

export async function peerInfo(host: string): Promise<PeerInfo> {
  return (await askPage(host, "info")) as PeerInfo;
}

export async function peerCapture(host: string, display: number, width?: number): Promise<Buffer> {
  // Why `by`: the other computer's connection log says it was Claude, not the person at this computer.
  const bytes = (await askPage(host, "frame", { display, width, by: "claude" })) as Uint8Array;
  return Buffer.from(bytes);
}

export async function peerFront(host: string): Promise<{ bundleId: string; name: string } | null> {
  return (await askPage(host, "front")) as { bundleId: string; name: string } | null;
}

export async function peerInput(host: string, input: Input): Promise<void> {
  await askPage(host, "input", { input, by: "claude" });
}

// ---- State for the window and the menu ----

/** Whether this computer is on the relay, so the Allow switches mean something. */
export function hasServer(): boolean {
  return relay.current().state === "running";
}

export async function current(): Promise<Link> {
  const now = relay.current();
  const settings = readSettings();
  const online: Computer[] = now.devices
    .filter((d) => d.role === "host")
    .map((d) => ({ name: d.name, host: d.deviceId, online: true, os: "" }));
  const computers = withKnown(online, account.email(), now.state === "running");
  return {
    state: now.state,
    error: now.error,
    account: account.email(),
    nickname: account.nickname(),
    customNickname: account.customNickname(),
    computers,
    allowViewing: settings.allowViewing,
    log: log.slice(0, 50),
  };
}

/** Adds the computers seen before that are off now, as grey tiles with when they were last seen. While the relay is
 *  not running, nobody is known to be on or off, so nothing is added and nothing is marked as gone. */
function withKnown(online: Computer[], email: string | null, running: boolean): Computer[] {
  if (!email || !running) return online;
  const book = knownFor(email);
  const now = Date.now();
  for (const c of online) book.computers[c.host] = { name: c.name, lastSeen: now };
  const here = online.map((c) => c.host).sort().join(",");
  if (here !== onlineBefore) {
    onlineBefore = here;
    for (const [host, seen] of Object.entries(book.computers)) if (now - seen.lastSeen > KNOWN_DAYS_MS) delete book.computers[host];
    try {
      writeFileSync(knownFile(), JSON.stringify(book));
    } catch (error) {
      console.error("known computers:", error instanceof Error ? error.message : error);
    }
  }
  const on = new Set(online.map((c) => c.host));
  const off = Object.entries(book.computers)
    .filter(([host]) => !on.has(host))
    .map(([host, seen]) => ({ name: seen.name, host, online: false, os: "", lastSeen: seen.lastSeen }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [...online, ...off];
}

export function setAllow(what: Allow, on: boolean): void {
  writeSettings({ [what]: on });
  if (what === "allowViewing" && !on) {
    status.forgetViewers();
    // Why: turning seeing off must also end the video already going out, not only refuse new questions.
    page()?.send("remote:dropHosted");
  }
}

/** Disconnect: nobody sees or clicks this computer until seeing is turned on again. */
export function disconnect(): void {
  setAllow("allowViewing", false);
}

export async function signIn(mode: "login" | "signup", email: string, password: string, code?: string): Promise<Link> {
  await account.signIn(mode, email, password, code);
  relay.connect();
  return current();
}

export function sendCode(purpose: "signup" | "reset", email: string, locale: string): Promise<void> {
  return account.sendCode(purpose, email, locale);
}

export async function resetPassword(email: string, code: string, password: string): Promise<Link> {
  await account.resetPassword(email, code, password);
  relay.connect();
  return current();
}

/** Decision 2026-11-19 2B: the nickname lives on the account server, so every RUNNERS app shows the same one. */
export async function setNickname(name: string): Promise<Link> {
  await account.setNickname(name);
  return current();
}

export async function signOut(): Promise<Link> {
  page()?.send("remote:dropAll");
  await account.signOut();
  relay.connect();
  return current();
}

/** `contents` gives the page that holds the WebRTC connections (the Remote window, made hidden at launch). */
export function startConnection(contents: () => WebContents | null): void {
  page = contents;
  loadLog();
  // Why: a nickname changed in another RUNNERS app or on another computer shows here after the next launch. Signing
  // in loads it by itself.
  if (account.email()) void account.loadProfile().catch(() => {});
  app.on("before-quit", () => {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveLog();
    }
  });
  ipcMain.handle("remote:hostRequest", async (_event, peerId: string, method: string, params: Record<string, unknown>) =>
    hostRequest(String(peerId), String(method), params ?? {}),
  );
  ipcMain.on("remote:sendSignal", (_event, to: string, payload: Record<string, unknown>) => {
    // Why: only devices the relay listed for this account are signalled, and only an offer, answer or candidate.
    if (!relay.device(String(to))) return;
    relay.send({ type: "signal", to: String(to), sdp: payload?.sdp, candidate: payload?.candidate });
  });
  ipcMain.on("remote:clientReply", (_event, rid: string, ok: boolean, value: unknown) => {
    const pending = waiting.get(String(rid));
    if (!pending) return;
    waiting.delete(String(rid));
    if (ok) pending.resolve(value);
    else pending.reject(new Error(String(value)));
  });
  ipcMain.handle("remote:deviceId", () => account.deviceId());
  relay.start({
    signal: (signal) => page()?.send("remote:signal", signal),
    left: (deviceId) => page()?.send("remote:peerLeft", deviceId),
  });
}
