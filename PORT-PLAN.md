# Clew iOS — Port Plan

Porting **Clew** (Electron + plain-JS web components + CodeMirror 6 + the
jmarkdown engine) to iOS/iPadOS. Upstream is `../Clew-app` (the golden
master for app code) and its `vendor/jmarkdown` (mirror of the engine).
This repo vendors both (`npm run sync-upstream`) and adds only
iOS-specific code. GPL-3.0-or-later, same as upstream.

## What cannot be ported (accepted losses)

Everything that shells out to external toolchains dies with `child_process`:

- **TikZ, MetaPost, Mathematica blocks** (lualatex/dvisvgm/mpost/
  wolframscript). The engine reaches `execSync` only inside those features'
  tokenizers — a shim that throws turns them into per-block build errors,
  and every other document renders untouched.
- **LaTeX/PDF export** (`jmarkdown --to latex` + compile). `.tex` emission
  itself is portable but useless without TeX; deferred.
- **Electron-isms**: multi-window (one vault open at a time on iOS),
  native menu bar (replaced by touch UI + command palette), `<webview>`
  canvas web nodes (replaced with the sandboxed `<iframe>` variant the
  preview client already ships), reveal-in-Finder (dropped), HEIC→JPEG via
  `sips` (replaced natively — Image I/O reads HEIC on iOS anyway).
- **mermaid-CLI PDF path** — HTML mermaid is client-side and ports fine.

## What ports, and how

Architecture mapping (desktop → iOS):

| Desktop | iOS |
|---|---|
| Electron main process (`src/main/*`) | JS "platform layer" in the app WebView (`src/shim/`) + a thin Swift FS bridge |
| `preload.cjs` → `window.clew.invoke/on` | Same API, implemented by `src/shim/clew-bridge.js` — the renderer is unmodified |
| chokidar vault watcher | Swift rescan on foreground/timer + diff events; the app itself is the only writer in steady state |
| jmarkdown forked one-shot node worker | jmarkdown bundled into a **Web Worker** (`dist/engine-worker.js`), same one-shot + pre-warmed-standby discipline, Node builtins shimmed onto an in-memory vfs (`src/worker/shims/`) |
| `clew-preview://` Electron protocol | `WKURLSchemeHandler` in Swift, same URL space (`/__clew_assets__/`, `/__clew_preview__/`, `/<sid>/<path>`), incl. Range for media |
| Renderer (`src/renderer`, ~14k lines) | Reused verbatim from `vendor/clew/renderer` + iOS override modules and `ios.css` (viewport, touch, safe areas) |
| Vault on disk | App Documents (seeded demo vault) + folders picked via `UIDocumentPicker` (security-scoped bookmarks); Obsidian compat rules unchanged |

### The engine in a Web Worker (audited, empirically bundled)

esbuild bundles `vendor/jmarkdown/src/index.js` for the browser cleanly —
every third-party dep resolves (cheerio picks its browser build; citation-js
is behind `createRequire` and degrades to a no-op; sync-request is dead
code; @octokit unreferenced). The shim layer supplies `fs` (in-memory vfs
loaded per build with the vault's text files), `path`, `process`
(`exit` throws, `stdin.isTTY` truthy, bare `argv` so the CLI guard stays
off), `vm.runInThisContext` = indirect eval (worker CSP must allow it),
`global = globalThis`, and stubs for commander/watch.js/chokidar.

Two engine facts shape the host protocol (`src/shim/render-service.js`):

1. **One-shot workers.** A build dirties the marked singleton, `global`,
   and `String.prototype`; desktop forks a fresh process per build with a
   pre-warmed standby. iOS mirrors this: terminate the Worker after each
   build, keep one standby warming (the 2.8 MB parse + mathjs init happens
   off the critical path).
2. **Extensions load via runtime `import()`** of config paths — fatal in a
   bundle. The build patches `metadata-header.js`'s spec loaders to consult
   `globalThis.__jmdExtensionRegistry` first; the worker pre-bundles
   Clew's engine assets (wikilinks, obsidian-fences, query-fences) and
   registers them under the exact paths the generated config names.
   (Upstream candidate: a registry hook in the engine itself.)

Renders stay file-mode full documents (`data-source-line` needs it), so the
vfs carries the template + `jmarkdown.css` + `Biblify.js.mustache` under a
fixed `Jmarkdown app directory`, and the config is generated per vault just
like `render-service.js#writeEngineConfig` does on desktop.

### Services layer (`src/shim/`)

`indexer.js`, `search.js`, `kv-store.js`, `rename-links.js`, `plugins.js`,
`bib.js` and the whole `shared/` are pure fs+path code — they bundle
verbatim from vendor with `node:fs` aliased to a **MirrorFS**: an in-memory
mirror of the vault's text files, bulk-loaded from Swift at vault-open,
updated synchronously on every write, flushed to disk through the bridge,
and patched by Swift-side rescans (external edits via Files/iCloud).
iOS-specific rewrites: `vault-manager.js` (bridge-backed file ops, tree),
`settings.js` (app settings via bridge file), `render-service.js` (worker
pool), `ipc.js` (channel registry — the 35 invoke channels + 9 events the
renderer actually uses, per audit).

### Swift side (`ios/`)

- `ClewApp` / `ContentView`: SwiftUI shell around one `WKWebView`.
- `SchemeHandler`: serves `clew-app://` (app bundle WebRoot) and
  `clew-preview://` (vault files with Range support; rendered notes by
  asking the JS RenderService via `evaluateJavaScript` and completing the
  URL task when the promise resolves; `__clew_fragment__` POST for canvas
  cards — WKWebView drops POST bodies for custom schemes, so the client
  will pass the markdown in a header/URL-safe form if needed).
- `FSBridge` (`WKScriptMessageHandlerWithReply`): list/stat/read/readBulk/
  write/mkdir/rename/trash/attachment-save, vault registry (Documents +
  bookmarked external folders), rescan-and-diff.
- `WKUIDelegate`/`WKNavigationDelegate`: deny popups, pin main-frame
  navigation, route http(s) to Safari — replaces Electron's guards that the
  unsandboxed preview iframe depends on.
- Seeds `seed-vault/` (the demo vault) into Documents on first run.
  `UIFileSharingEnabled` + `LSSupportsOpeningDocumentsInPlace` so vaults
  are visible in the Files app.

### Touch/layout adaptation (from the renderer audit)

Ranked; items 1–5 are in scope for the first working build, 6–10 tracked:

1. Viewport meta + `ios.css`: safe-area insets, kill the 38px titlebar,
   compact-width layout (sidebars become overlay drawers; workspace
   collapses to the active tab group on phones), 44pt hit targets.
2. `window.clew` shim with exact preload semantics (`on` returns an
   unsubscribe fn; payload-only handlers; promises for invoke).
3. Command access without menu/keyboard: toolbar (sidebar toggles, new
   note, search, palette button); the `MENU_STATE` payload already carries
   the live command context.
4. Long-press → `contextmenu` synthesis (file explorer, tabs, bookmarks,
   canvas), `touch-action` fixes on drag surfaces.
5. Editor: tap-to-follow wikilinks (Cmd-click today), save flush on
   `visibilitychange`/background, attachment paste fallback + photo
   library import.
6. Canvas: two-finger pan/pinch zoom, toolbar undo/redo/delete.
7. Graph view: pinch zoom, tap threshold fix.
8. Kanban drag: pointer-based rewrite of the HTML5 DnD.
9. PDF embeds: WKWebView renders PDFs natively in iframes only partially —
   evaluate, else link out to QuickLook.
10. Hotkey editor hidden without hardware keyboard; chord display via
    `navigator.maxTouchPoints`-aware platform detection.

## Milestones

- **M1 — engine renders under Node** ✅ worker bundle renders demo-vault
  notes via the vfs in `node --test` (wikilinks, dialect, queries, embeds,
  fragments).
- **M2 — services layer green under Node** ✅ vault mirror + channel
  registry against a real on-disk vault (tree, index, search, writes,
  rename propagation, kv, workspace state).
- **M3 — app boots in simulator** ✅ iPad + iPhone: vault auto-open,
  explorer, CodeMirror editing with dialect overlay, engine-rendered
  reading mode, live edit→preview morphs, queries table, MathJax +
  theorems, mermaid, media embeds, backlinks/unlinked mentions, canvas
  view, external-change rescan, desktop-cached MetaPost SVG display.
- **M4 — touch usability pass** ✅ (first pass) viewport/safe areas, iOS
  toolbar, compact overlay sidebars, long-press context menus, no editor
  autofocus, second-tap/long-press wikilink follow in the editor.
- **M5 — QA + TestFlight**: study-vault walkthrough, kanban touch drag,
  PDF embeds, device testing, signing. ⬜ next.
- **Sync Phase 1 — vault ingestion** ✅ three routes into the app, one
  machinery: (1) Documents vaults (Files app / Finder sharing, seeded
  demo); (2) folders picked anywhere Files reaches — iCloud Drive,
  Working Copy, other providers — opened in place under security-scoped
  bookmarks that survive relaunches and follow moved folders; (3) recents
  re-opens. iCloud eviction handled: text placeholders download within a
  deadline at snapshot (stragglers arrive by rescan), media materializes
  on demand in the scheme handler. Writes are NSFileCoordinator-
  coordinated; a 20s foreground rescan surfaces external writers
  mid-session. The Swift walk now skips dot-directories except `.clew`
  (a Working Copy vault's .git never enters the snapshot). Verified in
  simulator: external vault opened in place, dot-dirs excluded, links
  resolve + render, write-back, external-edit rescan, mid-session vault
  switching, bootstrap to last vault. The picker UI and real iCloud
  placeholder flows need device testing.
  Landed early from device feedback: canvas two-finger pan + pinch zoom
  (translated onto the existing wheel handler), canvas web nodes as
  sandboxed iframes (Electron's <webview> was a dead element on iOS),
  state-aware read/edit toggle in the toolbar (👁/✎). Apple Pencil drawing
  confirmed working on a real iPad.

### WebKit findings worth keeping

- Moved custom-scheme iframes get a stale window proxy: the document
  loads and runs but postMessage drops silently both ways. Fixed by
  rebuilding the preview iframe when the client never reports ready
  (build-time patch to clew-preview-view; upstream candidate).
- Upstream bug found: `workspaceStore.restore()` replaces sidebar state
  but emits only `layout-changed`, which `clew-app` never re-applies to
  the sidebar DOM — desktop reload with a closed-sidebar workspace shows
  open sidebars with closed state.
- `message` listeners registered from `callAsyncJavaScript` closures do
  not fire in WKWebView — instrument via real page code, not smoke
  closures.
- TikZ cache keys hash the LaTeX preamble config: cross-device SVG reuse
  works only when desktop and iOS resolve the same preamble (MetaPost
  hashes source only and reuses cleanly).

## Risks

- **Worker CSP / eval**: `vm.runInThisContext` → eval must be allowed in
  the worker context (we control CSP via the scheme handler; verified
  empirically in M3). Script blocks in notes already imply vault-authored
  code execution — same trust model as desktop.
- **POST bodies to custom schemes** are unreliable in WKWebView — canvas
  fragment endpoint may need a GET-with-body-in-query fallback.
- **Cold-start cost** of the 2.8 MB worker on older phones — standby
  warming hides it; measure on device.
- **App Review**: vault plugins/scripts execute vault-authored JS.
  Ship with plugins default-off (they already are per-vault opt-in).
