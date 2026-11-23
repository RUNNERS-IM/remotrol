// The test-shot run (`RUNNERS_TEST_SHOTS=<folder>`, shared rule `_docs/[PROGRAM] 시험 촬영 규약.md`): Remote opens each of
// its windows by itself, the kit (runners/test-shots.ts) saves one picture per window for every language in light and dark,
// writes shots.json and quits. Debug runs only, like the REMOTE_* hooks.
import { app, BrowserWindow, nativeTheme } from "electron";
import type { SettingsTab } from "../preload/api";
import { API_URL } from "./account";
import { currentLocale, setLocale } from "./i18n";
import * as link from "./link";
import * as status from "./status";
import { keepHidden, prepareTestShots, readTestShots, runTestShots, type TestShotPass } from "./runners/test-shots";
import { askUpdate, reloadPage, setPageLang } from "./windows";

/** Made-up "What's new" lines for the update window in the debug hooks and the test shots, in the app's language. */
export function sampleUpdateNotes(): string[] {
  return currentLocale() === "ko"
    ? ["메뉴 막대 그림이 꺼짐 · 대기 중 · 보는 중을 보여 줍니다.", "업데이트를 받은 뒤 설치할지 묻고, 바뀐 점을 함께 보여 줍니다.", "20개 언어를 지원합니다.", "로그인할 때 이름과 아이콘이 보이게 열립니다.", "화면 보기 창의 간격을 다른 앱과 맞췄습니다.", "다섯 줄이 넘으면 이 칸 안에서 스크롤됩니다."]
    : ["The menu-bar picture shows off, waiting and being viewed.", "Updates download first, then Remote asks and shows what changed.", "20 languages.", "Opens at login with its name and icon.", "The viewer window uses the same spacing as the other apps.", "Past five lines this box scrolls."];
}

/** What the run needs from index.ts, which owns the panel, the tray and the Remote window. */
export type ShotApp = {
  panel: () => BrowserWindow | null;
  showPanel: () => void;
  /** The Remote window, made but not shown. */
  viewer: () => BrowserWindow;
  showViewer: () => BrowserWindow;
  openSettings: (tab: SettingsTab) => void;
};

const config = app.isPackaged ? null : readTestShots();

/** Debug runs only: `REMOTE_SHOT_ACCOUNT=<email>` signs in to that relay-dev account in every pass instead of one per
 *  theme, so made-up computers started beside the run (REMOTE_FAKE_NAME · REMOTE_FAKE_SCREEN=<picture>, signed in to the
 *  same account) are on the list. Then the run also opens `REMOTE_SHOT_OPEN=<computer name>` and takes the site
 *  pictures: the list while another computer looks at this one, the menu bar window saying so, the computer's screen
 *  with its display and shortcut menus, and the Claude tab. */
const SHOT_ACCOUNT = process.env.REMOTE_SHOT_ACCOUNT?.trim() || null;
const SHOT_OPEN = process.env.REMOTE_SHOT_OPEN?.trim() || null;

/** Whether this run only takes the test shots. */
export const TEST_SHOTS = config !== null;

/** Before app.whenReady: a mock keychain, and every window kept see-through and never focused, so the run does not
 *  cover or take over the screen of whoever works at this Mac. */
export function prepareShots(): void {
  if (!config) return;
  prepareTestShots(config, app.commandLine);
  app.focus = () => undefined;
  app.on("browser-window-created", (_event, window) => {
    keepHidden(window);
    window.show = () => window.showInactive();
    window.focus = () => undefined;
  });
}

const pageWindow = (page: string) => BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w.webContents.getURL().includes(`#${page}`));

const loaded = (window: BrowserWindow) =>
  new Promise<void>((done) => {
    if (!window.webContents.isLoading()) done();
    else window.webContents.once("did-finish-load", () => done());
  });

/** Presses the element `selector` names in `window`'s page. */
const press = (window: BrowserWindow, selector: string) =>
  window.webContents.executeJavaScript(`document.querySelector(${JSON.stringify(selector)})?.click(), 1`);

/** Pages read their language when they load, so a new language loads the panel and the Remote window again and closes
 *  the rest. */
async function setLanguage(lang: string, shotApp: ShotApp): Promise<void> {
  setLocale(lang);
  setPageLang(lang);
  const panel = shotApp.panel();
  const viewer = shotApp.viewer();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && window !== panel && window !== viewer) window.destroy();
  }
  await Promise.all([panel && reloadPage(panel, "panel"), reloadPage(viewer, "viewer")]);
}

/** One language and theme. Screens that need a signed-in account come last, so the others keep their numbers whether or
 *  not the run signs in. */
async function scenes(pass: TestShotPass, shotApp: ShotApp): Promise<void> {
  const viewer = shotApp.showViewer();
  await loaded(viewer);
  await pass.wait(1500);
  await pass.shot(viewer, "main", "모든-컴퓨터");
  await press(viewer, ".rw-button.default");
  await pass.wait(800);
  await pass.shot(viewer, "account", "로그인-창");
  await press(viewer, ".ra-submit");
  await pass.wait(800);
  await pass.shot(viewer, "account", "로그인-오류");
  await press(viewer, ".ra-close");

  const tabs: [SettingsTab, string][] = [["mac", "이-컴퓨터"], ["log", "연결-기록"], ["claude", "Claude"], ["general", "일반"], ["account", "계정"], ["about", "정보"]];
  for (const [tab, screen] of tabs) {
    shotApp.openSettings(tab);
    await pass.wait(1200);
    const settings = pageWindow("settings");
    if (!settings) throw new Error("settings window did not open");
    await loaded(settings);
    await pass.wait(400);
    await pass.shot(settings, "settings", screen);
    if (tab === "general") {
      // Why the third switch: Show in Menu Bar, whose turning off asks first.
      await settings.webContents.executeJavaScript(`document.querySelectorAll(".switch")[2]?.click(), 1`);
      await pass.wait(800);
      await pass.shot(settings, "popups", "메뉴-막대-숨김-묻기");
      await press(settings, ".s-ask .rw-button:not(.default):not(.danger)");
    }
  }
  pageWindow("settings")?.destroy();

  const panel = shotApp.panel();
  if (panel) {
    shotApp.showPanel();
    await pass.wait(800);
    await pass.shot(panel, "menu", "메뉴-막대-창");
    panel.hide();
  }

  for (const downloading of [false, true]) {
    const prompt = askUpdate({ version: "2.6.1102", notes: sampleUpdateNotes(), downloading, percent: downloading ? 42 : 100 }, false);
    await pass.wait(1500);
    const window = pageWindow("update");
    if (window) await pass.shot(window, "popups", downloading ? "업데이트-받는-중" : "업데이트");
    prompt.close();
  }
  // The note at the first launch after installing by itself (kit 0.1.46).
  {
    const prompt = askUpdate({ version: "2.6.1102", notes: sampleUpdateNotes(), downloading: false, percent: 100, installed: true }, false);
    await pass.wait(1500);
    const window = pageWindow("update");
    if (window) await pass.shot(window, "popups", "업데이트-했음");
    prompt.close();
  }

  if (pass.account !== "signed-in") return;
  // Why only a local server: signing in makes an account, which must happen on scripts/relay-dev.mjs and never on the
  // real server.
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(API_URL)) {
    pass.note("로그인 뒤 화면은 건너뜀: REMOTE_API_URL 이 이 맥의 relay-dev 가 아님");
    return;
  }
  const email = SHOT_ACCOUNT ?? `test-shots-${pass.theme}@runners.im`;
  try {
    await link.signIn("signup", email, "test1234");
  } catch {
    await link.signIn("login", email, "test1234");
  }
  await pass.wait(3000);
  await pass.shot(viewer, "main", "모든-컴퓨터-로그인");
  await press(viewer, ".ra-badge");
  await pass.wait(800);
  await pass.shot(viewer, "account", "계정-메뉴");
  await viewer.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), 1`);
  shotApp.openSettings("account");
  await pass.wait(1500);
  const settings = pageWindow("settings");
  if (settings) await pass.shot(settings, "settings", "계정-로그인");
  settings?.destroy();
  if (SHOT_ACCOUNT) await peerScenes(pass, shotApp, viewer);
  await link.signOut();
  await pass.wait(1000);
}

/** Waits up to `ms` for `check`, looking every half second. */
async function until(pass: TestShotPass, check: () => boolean | Promise<boolean>, ms: number): Promise<boolean> {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await check()) return true;
    await pass.wait(500);
  }
  return false;
}

/** The site pictures (see REMOTE_SHOT_ACCOUNT), signed in with the made-up computers online. */
async function peerScenes(pass: TestShotPass, shotApp: ShotApp, viewer: BrowserWindow): Promise<void> {
  const tiles = () => viewer.webContents.executeJavaScript(`[...document.querySelectorAll(".tile img")].filter((i) => i.complete && i.naturalWidth > 0).length`) as Promise<number>;
  if (!(await until(pass, async () => (await tiles()) > 0, 20000))) pass.note("다른 컴퓨터의 작은 화면이 20초 안에 안 보임");
  if (!(await until(pass, () => status.current().viewers.length > 0, 20000))) pass.note("이 컴퓨터를 보는 컴퓨터가 20초 안에 없음");
  await pass.wait(2500);
  await pass.shot(viewer, "main", "모든-컴퓨터-보는-중");
  const panel = shotApp.panel();
  if (panel) {
    shotApp.showPanel();
    await pass.wait(800);
    await pass.shot(panel, "menu", "메뉴-막대-창-보는-중");
    panel.hide();
  }
  shotApp.openSettings("claude");
  await pass.wait(1500);
  const settings = pageWindow("settings");
  if (settings) {
    await loaded(settings);
    await pass.wait(400);
    await pass.shot(settings, "settings", "Claude-로그인");
    settings.destroy();
  }
  if (!SHOT_OPEN) return;
  const opened = await viewer.webContents.executeJavaScript(
    `(() => { const tile = [...document.querySelectorAll(".tile")].find((t) => t.querySelector(".tile-name")?.textContent === ${JSON.stringify(SHOT_OPEN)}); tile?.click(); return Boolean(tile); })()`,
  );
  if (!opened) {
    pass.note(`목록에 ${SHOT_OPEN} 없음`);
    return;
  }
  const playing = () => viewer.webContents.executeJavaScript(`[...document.querySelectorAll("video")].some((v) => v.videoWidth > 0 && !v.paused)`) as Promise<boolean>;
  if (!(await until(pass, playing, 20000))) pass.note(`${SHOT_OPEN} 화면이 20초 안에 안 나옴`);
  await pass.wait(2000);
  await pass.shot(viewer, "main", "화면-보기");
  const menus = [
    ["화면-보기-모니터-메뉴", `document.querySelectorAll(".bar-menu-box")[0]?.querySelector(".bar-button")?.click(), 1`],
    ["화면-보기-단축키-메뉴", `document.querySelectorAll(".bar-menu-box")[1]?.querySelector(".bar-button")?.click(), 1`],
  ] as const;
  for (const [screen, open] of menus) {
    await viewer.webContents.executeJavaScript(open);
    await pass.wait(800);
    await pass.shot(viewer, "main", screen);
    await viewer.webContents.executeJavaScript(`document.body.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })), 1`);
    await pass.wait(400);
  }
  await viewer.webContents.executeJavaScript(`document.querySelector(".window-bar .bar-button, .bar-button")?.click(), 1`);
  await pass.wait(1000);
}

/** Runs the shots once the app has started, then quits. */
export function runShots(shotApp: ShotApp): void {
  if (!config) return;
  void runTestShots({
    config,
    app,
    nativeTheme,
    setLanguage: (lang) => setLanguage(lang, shotApp),
    scenes: (pass) => scenes(pass, shotApp),
  });
}
