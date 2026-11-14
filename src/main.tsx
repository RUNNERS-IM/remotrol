import * as Sentry from "@sentry/electron/renderer";
import { startErrorReport } from "./runners-account/error-report";
import React from "react";
import ReactDOM from "react-dom/client";
import Panel from "./Panel";
import Settings from "./Settings";
import Update from "./Update";
import Viewer from "./Viewer";
import { applyWindowLook, page } from "./native";

// Why: errors in the windows go through the main process, which adds the app version; no DSN means nothing is sent.
startErrorReport(Sentry, { dsn: import.meta.env.VITE_SENTRY_DSN });

// Why: every window loads the same page; the address (#viewer, #panel, #settings or #update) picks what it shows.
document.documentElement.dataset.window = page;
applyWindowLook();
const Page = page === "panel" ? Panel : page === "settings" ? Settings : page === "update" ? Update : Viewer;

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Page />
  </React.StrictMode>,
);
