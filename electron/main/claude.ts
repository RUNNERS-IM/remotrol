// Claude's way in (plan stage 4): resources/mcp/remote-mcp.mjs, the MCP server Claude starts, talks to this file over
// a socket only this user can open (claude.sock in the user data folder; a named pipe on Windows). One JSON request per
// line: { id, method, params } -> { id, result } or { id, error }.
//
// Looking (computers, displays, screenshot) needs no approval: the computer being looked at decides that itself with
// its "Let Other Computers See This" switch, as for a person. Doing (click, type, key) follows decision 5B: in an app
// on the allowed list Claude acts at once; in any other app a person on this computer approves first (and can add
// the app to the list); in a macOS security window a person approves every single time.
//
// Every Claude session on the eight office Macs has these tools (decision 2026-11-19 3B), and many run with nobody at
// the Mac. So a question nobody can answer is not left open: when this computer has had no keyboard or mouse use for a
// while Claude is refused at once, and a question still open after a minute is refused too.
import { app, dialog, powerMonitor } from "electron";
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Socket } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import type { ClaudeState, Display, Input } from "../preload/api";
import { t } from "./i18n";
import * as link from "./link";
import { native } from "./native";
import * as screens from "./screens";
import { readSettings, writeSettings } from "./settings";
import * as status from "./status";

/** The name Claude uses for this computer; every other computer is its network name. */
const HERE = "this";

/** Windows where a person must say yes every time: password and permission prompts, and the settings that grant
 *  permissions. A click Claude makes there could hand out access, so it is never on the allowed list. */
const SECURITY_APPS = new Set([
  "com.apple.SecurityAgent",
  "com.apple.systempreferences",
  "com.apple.Settings",
  "com.apple.LocalAuthentication.UIAgent",
  "com.apple.coreservices.uiagent",
  "com.apple.UserNotificationCenter",
  "com.apple.keychainaccess",
  "com.apple.Passwords",
]);

/** No keyboard or mouse use for this long means nobody is at this computer to answer. */
const NOBODY_IDLE_S = 120;
/** A question nobody answers is closed after this long, as a no. */
const ASK_WAIT_MS = 60_000;
const LOG_KEEP = 200;
const LOG_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

type Front = { bundleId: string; name: string } | null;
type Done = ClaudeState["log"][number];

/** What Claude on this computer did, newest first, kept seven days like the connection log. */
const done: Done[] = [];
let doneLoaded = false;

function doneFile(): string {
  return join(app.getPath("userData"), "claude-log.json");
}

function remember(computer: string, what: Done["what"]): void {
  loadDone();
  // Why: Claude takes a screenshot after almost every step; one line a minute per computer says enough.
  const last = done[0];
  if (what === "view" && last?.what === "view" && last.computer === computer && Date.now() - last.at < 60_000) return;
  done.unshift({ at: Date.now(), computer, what });
  done.length = Math.min(done.length, LOG_KEEP);
  try {
    writeFileSync(doneFile(), JSON.stringify(done.filter((entry) => entry.at > Date.now() - LOG_DAYS_MS)));
  } catch (error) {
    console.error("claude log:", error instanceof Error ? error.message : error);
  }
}

function loadDone(): void {
  if (doneLoaded) return;
  doneLoaded = true;
  try {
    const since = Date.now() - LOG_DAYS_MS;
    done.push(...(JSON.parse(readFileSync(doneFile(), "utf8")) as Done[]).filter((entry) => entry.at > since));
  } catch {
    // Nothing done yet.
  }
}

function doneKind(input: Input): Done["what"] {
  if (input.kind === "key") return "key";
  if (input.kind === "text") return "text";
  return "click";
}

/** The line that gives Claude Code these tools for every project of this user. */
function addCommand(): string {
  const script = app.isPackaged
    ? join(process.resourcesPath, "mcp", "remote-mcp.mjs")
    : join(app.getAppPath(), "resources", "mcp", "remote-mcp.mjs");
  return `claude mcp add --scope user remote -- env ELECTRON_RUN_AS_NODE=1 "${process.execPath}" "${script}"`;
}

/** Whether Claude Code lists Remotrol's tools: its settings file names the script (user or project scope). */
function registered(): boolean {
  // Debug runs only: REMOTE_FAKE_CLAUDE=1 shows Claude Code as set up, for store and site pictures.
  if (!app.isPackaged && process.env.REMOTE_FAKE_CLAUDE === "1") return true;
  try {
    return readFileSync(join(homedir(), ".claude.json"), "utf8").includes("remote-mcp.mjs");
  } catch {
    return false;
  }
}

export function claudeState(): ClaudeState {
  loadDone();
  const settings = readSettings();
  return {
    registered: registered(),
    command: addCommand(),
    apps: settings.claudeApps.map((id) => ({ id, name: settings.claudeAppNames[id] ?? id })),
    log: done.slice(0, 30),
  };
}

export function removeClaudeApp(id: string): ClaudeState {
  const settings = readSettings();
  const names = { ...settings.claudeAppNames };
  delete names[id];
  writeSettings({ claudeApps: settings.claudeApps.filter((app) => app !== id), claudeAppNames: names });
  return claudeState();
}
type Request = { id: number; method: string; params?: Record<string, unknown> };

/** The size of the last screenshot of each display, so Claude can click in the picture's pixels. */
const shotSize = new Map<string, { width: number; height: number }>();

export function socketPath(): string {
  if (process.platform === "win32") return `\\\\.\\pipe\\remote-claude-${process.env.USERNAME ?? "user"}`;
  return join(app.getPath("userData"), "claude.sock");
}

/** Width and height from a JPEG's frame header. */
function jpegSize(jpeg: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < jpeg.length) {
    if (jpeg[at] !== 0xff) return null;
    const marker = jpeg[at + 1];
    const length = jpeg.readUInt16BE(at + 2);
    // SOF0 – SOF15 except DHT (C4), JPG (C8) and DAC (CC) hold the size.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: jpeg.readUInt16BE(at + 5), width: jpeg.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  return null;
}

function computerOf(params: Record<string, unknown>): string {
  const name = String(params.computer ?? HERE);
  return name === "" ? HERE : name;
}

async function displaysOf(computer: string): Promise<Display[]> {
  if (computer === HERE) return status.SUPPORTED ? (screens.displays() as Display[]) : [];
  return (await link.peerInfo(computer)).displays;
}

async function front(computer: string): Promise<Front> {
  if (computer === HERE) return status.SUPPORTED ? (JSON.parse(native.frontApp()) as Front) : null;
  return link.peerFront(computer);
}

async function computerName(computer: string): Promise<string> {
  if (computer === HERE) return status.current().computer;
  return link.peerInfo(computer).then((info) => info.computer, () => computer);
}

function describe(input: Input): string {
  if (input.kind === "click") return t("claude.doClick");
  if (input.kind === "key") return t("claude.doKey");
  if (input.kind === "text") return t("claude.doText", { text: input.text.length > 40 ? `${input.text.slice(0, 40)}…` : input.text });
  return t("claude.doClick");
}

/** Decision 5B: act at once, or ask the person at this computer. Resolves to whether Claude may go ahead. */
async function approved(computer: string, input: Input): Promise<boolean> {
  const app = await front(computer);
  const id = app?.bundleId ?? "";
  const security = SECURITY_APPS.has(id);
  if (!security && id && readSettings().claudeApps.includes(id)) return true;
  // Why: a question with nobody here would hold the Claude session until someone came back.
  if (powerMonitor.getSystemIdleTime() >= NOBODY_IDLE_S) throw new Error(NOBODY);
  const where = await computerName(computer);
  const waited = new AbortController();
  const timer = setTimeout(() => waited.abort(), ASK_WAIT_MS);
  const buttons = security ? [t("claude.allowOnce"), t("claude.deny")] : [t("claude.allowOnce"), t("claude.allowApp"), t("claude.deny")];
  const { response } = await dialog.showMessageBox({
    type: security ? "warning" : "question",
    title: "Remotrol",
    message: t("claude.ask", { computer: where, app: app?.name || t("claude.unknownApp") }),
    detail: `${describe(input)}${security ? `\n\n${t("claude.security")}` : ""}`,
    buttons,
    defaultId: buttons.length - 1,
    cancelId: buttons.length - 1,
    noLink: true,
    signal: waited.signal,
  });
  clearTimeout(timer);
  if (waited.signal.aborted) throw new Error(NOBODY);
  if (!security && response === 1 && id) {
    const settings = readSettings();
    writeSettings({
      claudeApps: [...new Set([...settings.claudeApps, id])],
      claudeAppNames: { ...settings.claudeAppNames, [id]: app?.name || id },
    });
  }
  return response === 0 || (!security && response === 1);
}

const NOBODY =
  "denied: nobody is at this computer to approve. Clicks and typing in apps outside the list in Remotrol Settings > Claude need a person here";

async function send(computer: string, input: Input): Promise<void> {
  try {
    await sendNow(computer, input);
    remember(await computerName(computer), doneKind(input));
  } catch (error) {
    remember(await computerName(computer), "refused");
    throw error;
  }
}

async function sendNow(computer: string, input: Input): Promise<void> {
  // Why first: nobody should be asked to approve something the other computer would refuse anyway.
  if (computer !== HERE && !(await link.peerInfo(computer)).control) {
    throw new Error("control: that computer does not allow clicks and typing (seeing is off, or Accessibility is not allowed there)");
  }
  if (!(await approved(computer, input))) throw new Error("denied: the person at this computer said no");
  if (computer !== HERE) return link.peerInput(computer, input);
  if (!status.SUPPORTED) throw new Error("unsupported");
  if (!status.permissions().accessibility) throw new Error("accessibility: allow Remotrol in Accessibility first");
  screens.sendInput(input);
}

/** Turns Claude's pixel point in the last screenshot into the fraction of the display the input format takes. */
function fraction(computer: string, display: number, x: number, y: number): { x: number; y: number } {
  const size = shotSize.get(`${computer}/${display}`);
  if (!size) throw new Error("take a screenshot of this display first, then click in its pixels");
  return { x: x / size.width, y: y / size.height };
}

async function run(method: string, params: Record<string, unknown>): Promise<unknown> {
  const computer = computerOf(params);
  switch (method) {
    case "computers": {
      const now = await link.current();
      return [
        { computer: HERE, name: status.current().computer, online: true },
        ...now.computers.map((c) => ({ computer: c.host, name: c.name, online: c.online })),
      ];
    }
    case "displays":
      return displaysOf(computer);
    case "screenshot": {
      const list = await displaysOf(computer);
      const display = params.display === undefined ? list[0]?.id : Number(params.display);
      if (display === undefined) throw new Error("no display");
      const jpeg = computer === HERE ? await screens.capture(display) : await link.peerCapture(computer, display);
      const size = jpegSize(jpeg);
      if (size) shotSize.set(`${computer}/${display}`, size);
      remember(await computerName(computer), "view");
      return { display, width: size?.width ?? 0, height: size?.height ?? 0, jpeg: jpeg.toString("base64") };
    }
    case "click": {
      const display = Number(params.display);
      const at = fraction(computer, display, Number(params.x), Number(params.y));
      const button = params.button === "right" ? "right" : "left";
      const count = Math.min(Math.max(Number(params.count ?? 1), 1), 3);
      await send(computer, { kind: "click", display, x: at.x, y: at.y, button, count });
      return "clicked";
    }
    case "type":
      await send(computer, { kind: "text", text: String(params.text ?? "") });
      return "typed";
    case "key": {
      const modifiers = (Array.isArray(params.modifiers) ? params.modifiers : []).filter((m): m is "shift" | "control" | "option" | "command" =>
        ["shift", "control", "option", "command"].includes(String(m)),
      );
      await send(computer, { kind: "key", code: Number(params.code), modifiers });
      return "pressed";
    }
    default:
      throw new Error(`unknown method ${method}`);
  }
}

function serve(socket: Socket): void {
  createInterface({ input: socket }).on("line", (line) => {
    let request: Request;
    try {
      request = JSON.parse(line) as Request;
    } catch {
      return;
    }
    run(request.method, request.params ?? {}).then(
      (result) => socket.write(`${JSON.stringify({ id: request.id, result })}\n`),
      (e) => socket.write(`${JSON.stringify({ id: request.id, error: e instanceof Error ? e.message : String(e) })}\n`),
    );
  });
  socket.on("error", () => undefined);
}

export function startClaude(): void {
  const path = socketPath();
  if (process.platform !== "win32") {
    mkdirSync(app.getPath("userData"), { recursive: true });
    // Why: a socket file left by a crash would block listening; only one Remote runs per user (single instance lock).
    if (existsSync(path)) unlinkSync(path);
  }
  const server = createServer(serve);
  server.on("error", (e) => console.error("claude socket:", e.message));
  server.listen(path, () => {
    if (process.platform !== "win32") chmodSync(path, 0o600);
  });
  app.on("before-quit", () => server.close());
}
