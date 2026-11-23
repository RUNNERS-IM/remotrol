# Developing Remotrol

[Back to README](../README.md)

## Building from source

Requires macOS 14 or later, [Rust](https://rustup.rs), Node.js 20 or later and pnpm.

```sh
pnpm install
pnpm native         # build the native module (native/) for this computer
pnpm dev            # run with live reload
pnpm dist           # build the app for this OS into dist.noindex/
pnpm check:locales  # check every locale against ko.json
```

For an Intel Mac build on Apple silicon, also run `pnpm native --target x86_64-apple-darwin` (after `rustup target add x86_64-apple-darwin`).

- `electron/main/` is the main process (tray, panel, viewer and Settings windows, status, updates), `electron/preload/` the bridge the page talks through, `src/` the panel, viewer and Settings pages.
- `native/` is the one native module (napi-rs): display capture, posted clicks, the app in front, permission checks and the tray picture.
- `electron/main/account.ts` signs in and keeps the tokens, `electron/main/relay.ts` keeps the relay connection, and `src/peer.ts` (in the Remotrol window, made hidden at launch) holds the WebRTC connections. `electron/main/link.ts` answers other devices and asks them for Claude; `electron/main/claude.ts` serves the MCP script.
- Screen text lives in `locales/`, with `ko.json` as the source; the page and the main process read the same files.
- Debug runs take `REMOTE_OPEN=panel|viewer|settings[:tab]` `REMOTE_THEME=dark|light`. A packaged app ignores them.
- `RUNNERS_TEST_SHOTS=<folder>` (debug runs) opens every window by itself, saves a picture of each in Korean and English, light and dark, writes `shots.json` and quits. `RUNNERS_TEST_ACCOUNT=signed-in` with `REMOTE_API_URL` pointing at `scripts/relay-dev.mjs` adds the signed-in screens. The shared rule is in the RUNNERS app kit (`desktop/README.md`, test shots).
- To try two computers on one Mac without the server: `node scripts/relay-dev.mjs` (a stand-in relay and login on 127.0.0.1:8790 that takes any email), then start each copy with `REMOTE_API_URL=http://127.0.0.1:8790`, its own `--user-data-dir`, and `REMOTE_FAKE_SCREEN=1` to send a drawn test screen instead of the real one.

When run with `pnpm dev`, macOS asks for permissions on behalf of the terminal app that started Remotrol, not Remotrol itself.

So far Remotrol has been built and checked on macOS (Apple silicon) only. On Windows and Linux it only says that Remotrol works on macOS for now.

## Releasing

Merging into the `release` branch builds and publishes a release (`.github/workflows/release.yml`). Before that, write
this release's changes in `RELEASE_NOTES.md`. It becomes the GitHub release text, and the update window shows its list
under "What's new":

```md
## 한국어

- 한 줄에 바뀐 점 하나씩, 합니다체로 씁니다.

## English

- One change per line.
```

Korean screens read the `## 한국어` list, every other language the `## English` one. The version bump
(`scripts/bump-release.sh`) stops when either list is empty or the file is the same as the last release's.
