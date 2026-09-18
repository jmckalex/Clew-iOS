# Clew iOS — Port Plan

Porting **Clew** (Electron + plain-JS web components + CodeMirror 6 + the
jmarkdown engine) to iOS/iPadOS. Upstream is `../Clew-app` (the golden
master for app code) and its `vendor/jmarkdown` (mirror of the engine).
This repo vendors both (`npm run sync-upstream`) and adds only
iOS-specific code. GPL-3.0-or-later, same as upstream.

## What cannot be ported (accepted losses)

Everything that shells out to external toolchains dies with `child_process`:

- **Mathematica blocks** (wolframscript). The engine reaches `execSync`
  only inside that tokenizer — a shim that throws turns each block into a
  per-block build error, and every other document renders untouched.
  (TikZ, MetaPost, LaTeX and plain TeX figures stopped being a loss in the
  0.11 sync: upstream typesets them IN the preview document with
  mp-tikz-wasm, and the engines ship in the app bundle — see the milestone
  and `scripts/stage-mptikz.js`.)
- **LaTeX export, and the PDF via LaTeX** (`jmarkdown --to latex` +
  compile). `.tex` emission itself is portable but useless without TeX;
  deferred. (The OTHER PDF — "Export as PDF (reading view)", upstream
  6f3be17 — ports fine: see the 0.11 decisions.)
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
8. Kanban drag: pointer-based rewrite of the HTML5 DnD. (Clew's own
   ```kanban fence only — 0.9's Obsidian-Kanban board notes are
   read-only in reading mode, so they do not add to this.)
9. PDF embeds: WKWebView renders an `<embed>` PDF as one static page. ✅
   Solved by EmbedPDF (Pdfium-in-wasm) in clew-preview documents — note
   embeds, file tabs, canvas nodes and canvas-embed scenes all use it, and
   annotations autosave into the vault file through `CH.PDF_WRITE`.
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
- **Upstream 0.8 sync** ✅ vendored at `ed35ba8`, 43 commits on from the
  previous sync point. Brought over: EmbedPDF as the single PDF stack
  (retiring the iOS-built parallel surface and PDF.js entirely), Excalidraw
  (React quarantined in one iframe page), Dataview/dataviewjs/Bases,
  Obsidian callouts, block references, markdown table editing, `@image`/
  `@video` directives and pandoc citations. Six new IPC channels: three
  implemented (`PDF_WRITE`, `EXCALIDRAW_LIB_GET`/`SET`), three honestly
  stubbed (`PDF_FONTS_*`). Simulator-verified across every arc; tests
  19 → 160. Device verification (Pencil feel, Excalidraw with Pencil,
  per-scene Pdfium memory) still outstanding.
- **Upstream 0.9 sync** ✅ vendored at `8422a45`, 18 commits on. No new
  IPC channels, no new npm deps. Brought over: Obsidian Kanban boards
  (read-only render; the card checkbox writes through its true source
  line), the Tasks dialect and search embeds, DQL FLATTEN / real GROUP BY
  / lambdas, admonitions, Meta Bind widgets (a toggle verified writing
  `done: false → true` into frontmatter on disk from the simulator),
  Bases map views on the existing leaflet machinery, `obsidian://` link
  planning, Back-able anchor jumps, full chord forwarding from reading
  mode, images in Excalidraw drawings (verified: an Embedded Files
  wikilink rehydrated into the editor over the preview protocol), and the
  demo vault's Charts plugin. **Engine-surface vault plugins now load on
  iOS**: the config names them by absolute vault path, the worker
  snapshot carries exactly those files, and the build's `__jmdImport`
  helper falls back to `__jmdImportSource` — vfs text imported as a blob
  module (data:-URL fallback for Node) — so the app worker, the
  render-note harness and `node --test` all run the same path. Surfaces
  must be SELF-CONTAINED modules (a blob import has no base for relative
  siblings; noted in engine-config.js). The harness now defaults
  vaultOptions to the vault's own `.clew/vault-settings.json`. Two iOS
  bugs surfaced: esbuild's injected `global` was invisible to
  runtime-imported modules (now a real global in the worker), and the
  Swift manifest parser's whole-dictionary `[String: String]` cast
  silently dropped every surface of any plugin with a dict-form surface.
  Tests 160 → 240.
- **On-disk contract parity** ✅ (2026-09-02, before the 0.10 sync —
  both apps write the same iCloud vaults). Three things desktop changed
  about what a vault looks like on disk, matched exactly: (1) **atomic
  writes** — every Swift write path goes temp + `F_FULLFSYNC` + rename
  with desktop's own temp name, `.<basename>.clew-tmp` beside the
  target, so each app's walks skip the other's temps and a crash-orphaned
  temp is swept by the next save (`AtomicFile.swift`; proven standalone
  on macOS incl. orphan sweep, mode preservation, through-symlink, and the
  failure path). (2) **Note history** — `.clew/history/<note path>/
  <stamp><ext>` snapshots, produced by upstream's `history.js` run
  VERBATIM over the vault mirror like the indexer and kv-store, so the
  format is identical by construction and upstream's nine unit tests port
  with a path rewrite. The mirror grew what that needed: Buffer-returning
  encoding-less reads (`shims/buffer.js`, with `.equals`), `utimes` and a
  real directory-capable `rename` in the vfs with write-through hooks,
  and two bridge ops — `setMtime` (snapshots are mtime'd for their
  content time) and `remove` (pruning; `.clew/history/` only, refused
  elsewhere on both sides). `HISTORY_LIST/READ/RESTORE` take upstream's
  ipc shape; restore ripples `fileChanged` because on iOS a write is
  renderer-originated. Simulator-verified by content: interval gate,
  pre-image, forced restore, rename carrying the directory, pruning with
  `-N` counters, snapshot mtime = content time on disk, zero temps.
  (3) **Welcome.md on first open** — upstream's rule lives in the
  `EV_VAULT_OPENED` handler, which iOS's boot never fires (it takes the
  VAULT_CURRENT "reload" branch), so `ios-ui.js` applies it after each
  restore commit; a clean install now opens on Welcome. Tests 240 → 255.
- **Upstream 0.10 sync (minus ZetaOffice)** ✅ vendored at `e64cf06`, 39
  commits on. One new npm dep (`@awesome.me/webawesome`) and two new
  preview bundles (`wa.{js,css}`, lazily fetched through the scheme
  handler's now-closed `__clew_preview__/` set) for Meta Bind widgets as
  Web Awesome components; note-history modal + settings toggle riding
  onto the contract arc's channels; fill-paragraph / auto-fill; explorer
  folder anchoring; the demo vault's Dashboards and Widgets guides;
  first-run Create/Demo channels (native name sheet; the seeded vault);
  the openWikilink URL guard; engine re-sync (MetaPost glyph labels).
  Vendored modules now save through `writeFileAtomic`: the fs shim grew
  fd APIs, `Buffer` is injected into the app bundle, and VaultManager
  collapses temp-write + rename into the one bridge write Swift already
  makes atomic. The ZetaOffice runtime is deliberately unported — its
  surfaces are backed by Quick Look (see Decisions). Simulator-verified
  across every arc on a clean install; tests 255 → 291.
- **Upstream 0.11 sync** ✅ (2026-09-17) vendored at `da5f68a` plus the
  two owner-requested uncommitted items in upstream's working tree (the
  LibreOffice icon revert; `\nopagenumbers` gone from ```tex), 29
  commits on. No new npm deps. **Figures without a TeX install**:
  TikZ, MetaPost, LaTeX and plain TeX typeset IN the preview document by
  mp-tikz-wasm — `figures.js` registered in the worker (Extensions + a
  new `Environments` key through the same `__jmdImport` registry), a
  `require('highlight.js')` registry so MetaPost highlights, the 74 MB
  engine tree staged by `scripts/stage-mptikz.js` (upstream's tree, the
  master build, or the SHA256-pinned release) into the app bundle and
  served as the `mptikz` asset root, immutable. Measured on a clean
  simulator install: seven figures cold in 2.3 s (LuaLaTeX included),
  an edited figure re-typeset alone in 0.5 s with the other six SVGs
  kept, a reopened note from IndexedDB in 251 ms; the library's
  in-worker synchronous XHR reaches the scheme handler. Embeds that fold
  (`|collapsed`/`|open`, written back), `|quiet`/`|bare`, and embedded
  notes refreshing when their target changes (the shim render service
  gained upstream's `embeddersOf` + `#restale`). Open in the OS default
  app = Quick Look after upstream's `planOpen` over the mirror; global
  plugins in `Documents/Plugins`; Export as PDF (reading view) from a
  hidden `WKWebView` (see Decisions for all three). Closed folders,
  reading position → editor, path-ranked wikilink completion, fence
  grammars in the editor, Avenir Next, `::` as a description list,
  `class()` on widgets, `!= null` — all ride the drop. Two pre-existing
  iOS gaps closed on the way: `alert()` shows (own window on the app's
  scene) and the share sheet actually presents on iPad. Upstream's demo
  note used `\frac` in plain TeX (the engine's honest error found it;
  fixed, now upstream's f92c7ea). Tests 291 → 388.
- **`font=note`** ✅ (2026-09-17 evening, `fontnote-p1…p3`) vendored at
  upstream `4eae005`. Figures set in the note's own face (upstream
  3339969): the engines restaged from the mp-tikz-wasm master build,
  which carries the `opentype` bundle (fontspec, luaotfload, 13.9 MB)
  and the plain-LuaTeX patch — unreleased upstream, so the CI build
  still gets v0.2.1 and refuses such figures by name until a release is
  pinned; the face → file map through the worker env; and
  `NoteFonts.swift` (see Decisions). Simulator: nine figures incl. two
  font=note in 5.1 s cold, real text runs with embedded faces, Avenir
  Next on screen; no stale WebKit cache when installing over the old
  build. Tests 388 → 392.

### Upstream candidates (iOS-owned today, worth pushing to ../Clew-app)

Behaviour that is not actually iOS-specific and would be better living in
the golden master than forked here:

- **A registry hook in the engine** for config-named extensions, instead of
  the build patching `metadata-header.js`'s dynamic imports (see above).
- **Rebuild a preview iframe that never reports ready** — the WebKit
  moved-iframe fix, currently a `clew-preview-view` build patch.
- **The Pencil pan convention** (`src/preview/pdf-touch.js`): once a pen
  pointer has been seen in a document, fingers pan the PDF and only the
  Pencil draws. It self-arms on a `pen` event, so a desktop that never sees
  one is untouched — which is exactly why it is safe to upstream.
- **An engaged canvas node should not draw resize handles or connection
  anchors.** Both are affordances for geometry, and an engaged node's
  content owns its pointer events, so a drag on either goes to the
  content, not to the node — on desktop as much as on iOS. Currently a
  `clew-canvas-view` build patch (the draw gates take `#engagedId` into
  account, and `#engage`/`#disengage` call `#syncOverlay` so the overlay
  redraws when it changes). Upstream would also want the engaged style to
  be distinguishable from the selected one, which it is not today.
- **Publish viewer handles from `pdf-core.js`.** `pdf-embed.js` exposes
  `window.__clewPdfViewers`, but `pdf-page.js` keeps its handle private, so
  anything wanting all three surfaces (the touch layer) needs a build patch.
  The smoke hooks already there exist for the same reason.
- **The boot path should greet too.** `renderer/main.js` applies the
  Welcome.md-on-first-open rule only in the `EV_VAULT_OPENED` handler;
  the `VAULT_CURRENT` boot branch — which is every iOS launch, and a
  desktop reload — restores the workspace without it. A four-line
  duplication upstream would let `ios-ui.js` drop its copy.
- **Same-second snapshot ordering.** `history.js#entriesIn` sorts
  same-stamp entries by counter, but a counter freed by pruning is reused
  by the next snapshot, so after three saves in one second under a small
  cap the listing's order within that second (and `newest`, which gates
  the identical-content check) no longer tracks recency. Cosmetic in
  practice; a services test here asserts on the surviving set instead.
- **`officeDock.downloadEngine` never repaints a rejected download.** It
  sets `downloading: true` optimistically, and if `OFFICE_ENGINE_DOWNLOAD`
  rejects before the 700 ms status poll fires, the cached status stays
  "downloading" forever — the offer panel shows "Starting…" with no way
  back. A `catch` that refreshes the status would fix it on desktop too
  (a failed download is reachable there: offline, a bad pin).
- **`dataviewJs` in the VAULT_SETTINGS_SET reconfigure list.** Upstream
  reconfigures on `jmarkdownProject`/`normalSyntax`/`pandocCitations` but
  leaves `dataviewJs` to take effect at the next vault open, which looks
  like an oversight rather than a decision. iOS reconfigures immediately.
- **Canvas-embed scene PDFs.** Upstream still emits a raw
  `<embed type="application/pdf">` inside `.canvas-embed-scene`, relying on
  Chromium's plugin; every other PDF surface went through `pdf-page.html` in
  0.8. Routing scenes there too (as `src/preview/pdf-scene-embeds.js` does)
  would make it one pipeline everywhere — and would need upstream's own
  answer to the save relay, since a scene viewer is one frame deeper than
  `pdf-core.js`'s `window.parent` assumption. (The Excalidraw page already
  solves the same problem by posting to `window.top`.)

### Decisions taken on iOS that diverge from desktop

- **PDF file tabs no longer open in QuickLook** (0.8 sync). They open
  upstream's `pdf-page.html` viewer, for desktop parity and in-tab
  annotation. The `quickLook` Swift bridge stays available as a fallback.
- **PDF.js is gone.** EmbedPDF is the only PDF stack; canvas-embed scenes
  use `pdf-page.html` like everything else.
- **The ZetaOffice runtime is not ported; Quick Look stands in.** Desktop
  (0.10) edits Word/Excel/PowerPoint in tabs with LibreOffice-in-wasm
  (~1.6 GB resident) and thumbnails office embeds by booting the same
  offscreen. The iPad content process is killed well short of that, and
  whether to spike it at all is the owner's call. Upstream's surfaces
  all ride the vendor drop; on iOS they are backed by what the system
  has: `OFFICE_ENGINE_STATUS` says "not installed, no desktop
  LibreOffice"; "Open in Quick Look" (the relabelled open-externally
  button) presents the read-only system viewer; `OFFICE_THUMBNAIL` is
  REAL — `QLThumbnailGenerator` renders the document and the PNG is
  cached where desktop caches its own (`.clew/cache/office-thumbs/
  <rel>.png`, by mtime), so embeds and canvas nodes show a picture and
  a vault shared over iCloud reuses either side's; download/remove/
  convert/save/slot answer with a reason. Three guarded patches drop
  the controls that would lie: the settings section, the tab's download
  offer (whose button would spin forever — `downloadEngine` never
  repaints after a rejected download; upstream candidate), and the
  canvas node's Live choice. `![[doc.docx|live]]` in a note still emits
  a live iframe, which 404s here (blank box) — the one office surface
  that cannot be made honest without touching the engine.
- **Global plugins live in `Documents/Plugins`** (0.11 sync). Upstream's
  second discovery root is `<userData>/plugins`, which on iOS would be
  unreachable to the user; Documents is the one place the Files app can
  put a folder. The Swift store snapshots that folder beside the vault at
  open and the mirror carries it read-only under a second root
  (`/global-plugins`), so upstream's `plugins.js` — vault plugin shadows
  global, installing never enables — runs verbatim over both; the worker
  snapshot carries an enabled global engine surface, the scheme handler
  serves a global preview surface and its siblings from
  `__clew_plugin_file__/<sid>/<id>/…` exactly as `protocol.js` does, and
  "Open global plugin folder" opens the Files app there
  (`shareddocuments://`). No rescan watches that folder: a plugin dropped
  in mid-session is discovered at the next vault open.
- **"Open in the OS default app" is Quick Look** (0.11 sync).
  `[[paper.pdf|external]]` and `file://` links run upstream's electron-free
  `planOpen` over the mirror (vault clamp, missing file, executables
  refused by name) and then present the system's read-only viewer, which
  carries its own share / open-in sheet — the same rung office documents
  use. A `file://` link can only reach the open vault (nothing outside the
  sandbox is reachable), and a folder has no viewer; both refuse with a
  reason the renderer shows as a notice.
- **The note's typeface is built from CoreText, not read from a file**
  (`font=note`). Desktop slices the four Avenir Next faces out of the
  system's `.ttc`; the iPad never opens Apple's font file — it asks
  CoreText for each face's tables and writes one sfnt per face (sorted
  directory, aligned tables, checksums, `head.checkSumAdjustment`) into
  Application Support, keyed on the iOS version, the first time a
  figure asks; the scheme handler serves them under
  `__clew_assets__/notefonts/` in desktop's URL shape. Proven byte-for-
  byte against desktop's extractor on the same faces (the one differing
  field is `head`'s checksum, where the Swift value is the spec's). The
  engines come from the library's MASTER build in preference to
  upstream's staged copy (`scripts/stage-mptikz.js`), as upstream's own
  dev path does — that is where a new bundle lands first.
- **"Export as PDF (reading view)" prints from a hidden `WKWebView`**
  (0.11 sync). Upstream prints the note's own `clew-preview://` document
  from a hidden BrowserWindow once the page says it has settled; here
  `PrintPDF.swift` loads the same document in a second web view on the
  same preview scheme handler, parked behind the app at the paper's
  printable width (WebKit lays out only views in a window), runs
  upstream's arm and ready-probe scripts (`src/shim/print-pdf.js`, copied
  verbatim — upstream candidate: export them from an electron-free
  module), asks the client for the light theme, paginates with
  `UIPrintPageRenderer` at the `printPaperSize` setting with 0.6 in
  margins, and hands the PDF to the share sheet, iOS's save dialog.
  Measured on the Diagrams note: five A4 pages in 3.3 s, MathJax, mermaid
  and all seven wasm figures as vectors, `@media print` keeping each
  figure whole.
- **CJK PDF fallback fonts are stubbed off.** Upstream downloads a 139 MB
  Noto pack on demand; iOS has no downloader, so the three `CH.PDF_FONTS_*`
  channels answer "not available", the settings section is patched out, and
  `pdffonts/fallback.json` answers `null`. A native URLSession downloader is
  a possible later feature.
- **A canvas node engages on a double tap, and says so.** Upstream keeps
  node content inert (`pointer-events: none`) until the node is *engaged*
  by a double-click, and the port used to engage a node holding
  `<video>`/`<iframe>`/`<embed>` on a SINGLE tap so a video's play button
  could be reached. That armed exactly the interesting nodes — video, web
  pages, PDFs — on the tap that selected them, while every other node
  still wanted two, and an armed node was drawn in the same accent as a
  selected one. Which of your taps reached the content was therefore
  unpredictable, which is what the owner reported. Now: one tap selects
  (drag to move, handles to resize), a double tap engages, a tap outside
  returns to the canvas — every node type alike, the gesture upstream
  already uses, and one that cannot be confused with the tap that begins a
  drag. The engaged state is legible: its own border colour plus an inset
  hairline (`ios.css` — the hairline because a node the reader painted
  green would otherwise look identical engaged and selected), and no
  resize handles or connection anchors, since a drag on either goes to the
  content. Touches inside an engaged node are the content's: the
  two-finger canvas pan/zoom and the synthetic long-press menu both stand
  off it, and the viewport drops `touch-action: none` while it lasts so an
  embedded PDF or page can scroll and pinch at all.

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
- IndexedDB IS available to `clew-preview://` documents (probed
  2026-09-17: `indexedDB.open` succeeds), which is what makes
  mp-tikz-wasm's figure cache work — a reopened note shows its figures in
  ~250 ms with no engine boot. And a synchronous XHR issued inside a
  MODULE worker of a preview document reaches `WKURLSchemeHandler` and
  returns: the library's kpathsea reads go through the scheme handler file
  by file (a cold Diagrams note, seven figures, LuaLaTeX included: 2.3 s in
  the simulator). Heavy wasm in a preview document, worker engine — the
  rule of thumb below held for the fourth wasm engine too.
- WebAssembly compilation is CSP-gated: the app page's script-src needs
  `'wasm-unsafe-eval'` or `WebAssembly.compile` fails (EmbedPDF's Pdfium
  engine spun forever on "Initializing"). Preview documents carry no such
  CSP, which is why the same engine ran there first try.
- Module workers (`new Worker(url, {type:"module"})`) never come up under
  the clew-app scheme even post-CSP-fix, while the identical worker runs
  under clew-preview; blob-URL workers work under both, including
  importScripts/fetch/wasm-compile of custom-scheme URLs (probed
  2026-08-24). And Pdfium's DIRECT engine on the app page's main thread
  wedged/killed the content process on a real iPad (white screen, app
  must be killed) despite running in the simulator — so the canvas
  annotator is a clew-preview-hosted page (pdf-annotator.html) in an
  iframe overlay, where the worker engine is device-proven. Rule of
  thumb: heavy wasm belongs in clew-preview documents with the worker
  engine, never on the app page.
- URL "loaders" in third-party libs tend to allowlist http(s)/blob:
  Syncfusion treated a clew-preview:// documentPath as base64 data;
  EmbedPDF is fed an ArrayBuffer (openDocumentBuffer) to sidestep the
  whole class.

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
