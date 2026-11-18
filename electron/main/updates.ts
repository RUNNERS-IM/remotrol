// Keeps Remotrol up to date from the GitHub release (electron-updater, RUNNERS-IM/remotrol) with runners-app-kit's
// createUpdates: checks once a day, first about a minute after launch, and downloads a new version at once. With
// automatic updates on (the default) it installs without asking after 10 minutes with no keyboard or mouse use, or
// when Remotrol quits, and says so once at the next launch (shared decision 2026-11-19 1A 2A). While another computer
// or phone is watching this screen it waits, so nobody's remote session is cut off by a restart. With them off it
// asks after downloading, as before. Release builds only: a dev run is not a signed build, so it has nothing to
// compare with or install.
import { app, dialog, powerMonitor } from "electron";
import { autoUpdater } from "electron-updater";
import { currentLocale, t } from "./i18n";
import { createUpdates } from "./runners/updates";
import { readSettings, writeSettings } from "./settings";
import * as keepAlive from "./keepAlive";
import * as status from "./status";
import { allowClose, askUpdate } from "./windows";

const updates = createUpdates({
  isPackaged: app.isPackaged,
  autoUpdater,
  onResume: (listener) => powerMonitor.on("resume", listener),
  readSettings,
  writeSettings,
  locale: currentLocale,
  t: (key, args) => t(key as Parameters<typeof t>[0], args),
  askUpdate,
  // Why allowClose: macOS closes every window before before-quit fires, and the Remotrol window only hides when
  // closed, so without this the app never quits and the new build is never put in place. Why quitAsked: the
  // installer starts the new build itself; Remotrol must not also be started again by keepAlive.
  beforeInstall: () => {
    allowClose();
    keepAlive.quitAsked();
  },
  tell: async (message) => {
    app.focus({ steal: true });
    await dialog.showMessageBox({ type: "info", message, buttons: ["OK"] });
  },
  appVersion: () => app.getVersion(),
  idleSeconds: () => powerMonitor.getSystemIdleTime(),
  // Why: a restart would cut off whoever is looking at or clicking on this screen from another computer or phone.
  isBusy: () => status.viewers().length > 0,
});

export function startUpdates(): void {
  updates.start();
}

/** "Check for Updates…" in the menu: same check, but also says when Remotrol is already up to date. */
export function checkNow(): void {
  void updates.checkNow();
}

/** Version as people see it: a same-day build `2.6.1030+2` reads `2.6.1030.2`, like its release tag. */
export function displayVersion(): string {
  return app.getVersion().replace("+", ".");
}
