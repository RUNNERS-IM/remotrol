// Values electron-vite puts into the main process at build time. MAIN_VITE_SENTRY_DSN is empty unless the release
// build is given the Sentry address (.github/workflows/build.yml).
interface ImportMetaEnv {
  readonly MAIN_VITE_SENTRY_DSN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
