// Remote's few settings, kept in settings.json in the user data folder.
import { app } from "electron";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type Settings = {
  /** Install new releases without asking, while nobody uses the computer or at quit. On by default; off asks first. */
  autoUpdate: boolean;
  /** The day (`2026-10-30`) "Later" was chosen in the update dialog, so the daily check does not ask again that day. */
  updateLaterOn: string | null;
  /** When a check last reached GitHub (milliseconds since 1970), so a wake from sleep checks only when one is due. */
  updateCheckedAt?: number;
  /** A version downloaded to install by itself; at the next launch on that version Remotrol says so once. */
  updateReady?: { version: string; notes: string[] | null } | null;
  /** Other computers and phones of the same account may see this one, and click and type in it. "Disconnect" turns it off. */
  allowViewing: boolean;
  /** Apps (bundle ids) Claude may click in without a person approving each time (decision 5B). */
  claudeApps: string[];
  /** The names of those apps, for the Claude tab in Settings; apps added before names were kept show their id. */
  claudeAppNames: Record<string, string>;
  /** This computer's id on the relay, made at first start (account.ts). */
  deviceId: string | null;
  /** The picture in the menu bar. macOS only; other systems always keep it, or nothing would lead back to Remote. */
  showTrayIcon: boolean;
};

const DEFAULTS: Settings = {
  autoUpdate: true,
  updateLaterOn: null,
  allowViewing: true,
  claudeApps: [],
  claudeAppNames: {},
  deviceId: null,
  showTrayIcon: true,
};

function file(): string {
  return join(app.getPath("userData"), "settings.json");
}

export function readSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(file(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function writeSettings(change: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...change };
  mkdirSync(app.getPath("userData"), { recursive: true });
  writeFileSync(file(), JSON.stringify(next, null, 2));
  return next;
}
