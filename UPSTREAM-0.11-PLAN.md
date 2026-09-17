# Upstream 0.11 Sync — Plan for Clew-iOS

**STATUS: in progress, started 2026-09-17.** Written the way the 0.8, 0.9
and 0.10 plans were: one branch per phase, chained off the previous tip
(`sync10-p5-verify`, add3a49), so a bad phase falls back cleanly. Read
`README.md` and `PORT-PLAN.md` for architecture, `HANDOVER.md` for session
state. `UPSTREAM-0.9-PLAN.md` §0's ground rules apply verbatim: never push
without the owner's OK; never edit `vendor/`; non-iOS improvements go
upstream, recorded as candidates in PORT-PLAN.md; guarded build patches
must FAIL the build when upstream drifts.

Brings the port from upstream `e64cf06` to **`da5f68a` plus the two
uncommitted, owner-requested items in its working tree** (the LibreOffice
icon-theme revert and the `\nopagenumbers` removal — `../Clew-app/
HANDOVER.md` §0 says "ready for review", and neither touches anything iOS
builds except `figures.js`, which the owner decided). One piece of the
working tree is NOT vendored: `demo-vault/Guide/Widgets.md` carries smoke
residue (`rating`, `status`, a re-quoted `url`), reset to `da5f68a`'s
version in `seed-vault/`. 29 commits, 101 files, +5,364 / −745.

## 1. What changed upstream, and what it costs here

| Upstream change | Rides the drop? | iOS work |
|---|---|---|
| **Figures in wasm** (`689bb9c`, `06fd7c4`, `438e694`, `da5f68a`): `engine/figures.js` emits `<tikz-diagram>`/`<metapost-diagram>`; `preview-client/figures.js` loads mp-tikz-wasm's `auto.js` from `/__clew_assets__/mptikz/`; `stage-mptikz.js` + `shared/mptikz-manifest.json` pin v0.2.1 (74 MB, 3,668 files, never committed); six syntaxes incl. ```latex / ```tex; `show=`; MetaPost highlight grammar; editor stream modes | engine + preview client + editor: yes | **THE port** (§2): register `figures.js` in the worker (Extensions + a new `Environments` config key), a `require('highlight.js')` registry so MetaPost highlights, stage the engines into the app bundle, an `mptikz` asset root in SchemeHandler, and the seam probes: module worker + sync XHR + wasm + IndexedDB under `clew-preview://` |
| **Embeds fold / frame / refresh** (`5da6db2`, `40f1643`, `b859f26`): `embed-state.js` shared by engine and renderer; `<details>` embeds write `|collapsed`/`|open` back; `|quiet`/`|bare`; `Indexer#embeddersOf` + `RenderService#restale` | engine, client, renderer, indexer: yes | **shim `render-service.js`** gains `embeddersOf` + `#restale` (iOS's render service is a rewrite); `ipc.js` wires it to the vendored indexer |
| **Open in the OS default app** (`f3a4662`): `[[x.pdf|external]]`, `file://` links, `main/open-file.js#planOpen` (electron-free), `CH.SHELL_OPEN_PATH` | engine + renderer: yes | **new channel**: `planOpen` over the mirror, then Quick Look (iOS's "default app" rung, as for office); `file://` only inside the open vault |
| **Global plugins** (`376b626`): second discovery root `<userData>/plugins`, `plugin.dir`/`scope`, `__clew_plugin_file__/<sid>/<id>/<path>`, `CH.PLUGINS_REVEAL_GLOBAL`, settings row | `main/plugins.js` (verbatim over the mirror): yes | **iOS root = `Documents/Plugins`** (the one Files-visible place; excluded from vault enumeration), mirrored at vault open, carried in the worker snapshot, served by SchemeHandler; "Open global plugin folder" opens the Files app there (`shareddocuments://`) |
| **Export as PDF (reading view)** (`6f3be17`): `main/print-pdf.js` prints the note's own `clew-preview://` document from a hidden window after MathJax/fonts/mermaid/figures settle; `printPaperSize` setting; `@media print` | settings + css + command: yes | **hidden `WKWebView` + `UIPrintPageRenderer`** → share sheet (the iOS save dialog), same arm/probe scripts |
| Explorer remembers closed folders (`a58a3cd`): `collapsedFolders` in workspace state, `workspace-restored` event | yes | verify `ios-ui.js`'s `layout-changed` hooks still fire in order (restore emits `workspace-restored` first) |
| Reading position → editor (`d417f9f`), wikilink completion by path (`418e87b`), Meta Bind `class()` + compact numbers (`c579d11`), `WHERE x != null` (`aa16340`), Avenir Next (`7775cb0` — iOS ships it) | yes | none; simulator checks |
| **`::` is a description list** (`0c4f56a`): inline fields dropped from `query-fences.js`/`vault-model.js`/`actions.js` | yes | refresh the ported `query-fences`/`dataview` suites; the seed vault's Queries note changed |
| Engine re-sync `748bd70 → e823e76` (`e7487c0`): `\fullcite` as spans, Vancouver key group | yes | re-run engine tests |
| Smoke isolation (`04def34`), `smoke/` kit, HANDOVER/CLAUDE | desktop-only | not copied; mined for sim checks |

`shared/channels.js` gained two constants (`PLUGINS_REVEAL_GLOBAL`,
`SHELL_OPEN_PATH`); `EXPORT_NOTE` takes `format: 'print-pdf'`;
`PLUGINS_LIST` answers `globalDir`. No npm dependency changed (upstream's
`package.json` diff is scripts + electron-builder `extraResources` only).
All fourteen guarded patch anchors were pre-checked against the working
tree: every one still matches.

## 2. Figures — the decisions

1. **Engines ship in the app bundle**, as upstream ships them in the DMG.
   iOS has no downloader (the CJK-fonts gap), the release is a `.tar.gz`
   Foundation cannot unpack, and a figure in a note must simply render.
   `scripts/stage-mptikz.js` (iOS twin of upstream's) fills gitignored
   `mptikz-assets/` from, in order: `../Clew-app/mptikz-assets` (what the
   owner just staged), the owner's master build `~/Source/mp-tikz-wasm/
   dist`, or the SHA256-pinned GitHub release named in the vendored
   `vendor/clew/shared/mptikz-manifest.json`. `npm run build` copies it
   into `dist/webroot/preview-assets/mptikz` (minus `.d.ts`/`.map`), so
   the Xcode phase and Xcode Cloud need nothing new beyond one line in
   `ci_post_clone.sh`. Cost: ~+70 MB on the App Store listing — the
   owner's to veto; download-on-demand is the reversible alternative.
2. **Rendering stays in the preview document**, exactly where upstream
   put it and exactly where this port's WebKit rules say heavy wasm
   belongs (never the app page). The library uses a MODULE worker,
   dynamic `import()` of `.mjs` glue, `fetch`, and a **synchronous XHR
   inside the worker** for kpathsea reads (`vfs/bundle.js#browserIO`);
   without sync XHR it `prefetchAll()`s every bundle it was asked for.
   Module workers, `fetch` and wasm compile under `clew-preview://` are
   already proven (PORT-PLAN, WebKit findings); sync XHR through a
   `WKURLSchemeHandler` from a worker is NOT — seam question §4.1.
3. **The result cache is IndexedDB**, keyed by content hash. Whether
   WebKit grants IndexedDB to a `clew-preview://` document is seam
   question §4.2; if not, every open re-typesets (the LuaLaTeX path is
   ~270 ms a figure on the owner's Mac; slower on an iPad), and the
   iOS-side answer is the library's own saved-figures mechanism
   (`data-figures=` + `.clew/cache/figures/figure-<hash>.svg` through the
   bridge) — a follow-up, decided by measurement, not now.
4. **MetaPost `show=code` highlighting**: `figures.js` registers its
   grammar on the engine's highlight.js via `createRequire(process.argv[1]
   ?? import.meta.url)('highlight.js')`. The worker's `createRequire` shim
   throws for everything (biblify catches it); it now consults a tiny
   registry the worker entry fills with the bundled `highlight.js`
   (esbuild dedupes, so it is the engine's own instance). Unreachable
   means unhighlighted, never a failed render — upstream's own rule.
5. `Environments` is a new config key the generated config carries;
   the engine's loader reaches it through the same patched
   `__jmdImport` as `Extensions` (`metadata-header.js#
   importEnvironmentSpec` uses `await import(`), so the registry answers
   `/engine-assets/figures.js` for both.
6. The seed vault loses its two committed native SVG caches (dead
   upstream); the "desktop-cached SVG display" claim in README/PORT-PLAN
   goes with them — the md5 shim stays exact for the mermaid cache.

## 3. Phases

- **`sync11-p1-vendor`** — `npm run sync-upstream` at the working tree;
  `git checkout --` the AppIcon; reset `seed-vault/Guide/Widgets.md`;
  register `figures.js` (engine-config + engine-worker) and the
  `Environments` key; `createRequire` registry; `embeddersOf`/`#restale`
  in the shim render service + wiring; the two new channels registered
  (answers land in p3); `EXPORT_NOTE` refuses `print-pdf` honestly until
  p4; refresh every ported suite that upstream evolved; port
  `embed-state`, `embed-graph`, `open-file`, `wikilink-complete`,
  `fence-languages`, `plugins`; build + tests green; xcodebuild clean.
- **`sync11-p2-figures`** — `stage-mptikz.js`, build staging, SchemeHandler
  `mptikz` root (+ `immutable` cache header), `.gitignore`,
  `ci_post_clone.sh`; simulator probes §4.1–§4.3 on the demo vault's
  Diagrams note (all six syntaxes, `show=both`, a ```latex `\frac`, a
  ```tex `\sqrt`, edit-a-figure morph guard); port `figures.test.js`.
- **`sync11-p3-platform`** — `SHELL_OPEN_PATH` (`planOpen` + Quick Look;
  `file://` inside the vault only), global plugins (`Documents/Plugins`:
  VaultStore exclusion + mirror load, worker snapshot, SchemeHandler
  route + preview injection, `PLUGINS_REVEAL_GLOBAL` via the Files app),
  and the pre-existing `alert()` gap (`WKUIDelegate
  runJavaScriptAlertPanel`) so a refused export is no longer silent.
- **`sync11-p4-print`** — reading-view PDF: bridge `printPdf` → hidden
  `WKWebView` on the app's configuration loading the note's preview URL,
  upstream's arm/probe scripts, light theme, `UIPrintPageRenderer` at
  the chosen paper size with 0.6 in margins → share sheet.
- **`sync11-p5-verify`** — regression sweep on a clean install (folded /
  quiet / bare embeds and the write-back by content; embed refresh
  through a two-level chain; closed folders across a relaunch; reading
  line → editor; path completion; fence faces in the editor; Avenir
  Next; `Rating::` as a description list; `class()`; `!= null`; search,
  index, history, EmbedPDF, Excalidraw, Web Awesome); PORT-PLAN
  milestone; README; HANDOVER rewrite; memory.

## 4. Seam questions (answered during the phases)

1. Does a synchronous XHR issued inside a module worker reach
   `WKURLSchemeHandler` and return, under `clew-preview://`? If not,
   the library prefetches whole bundles into worker memory — measure
   before deciding whether that is acceptable or whether an iOS `bundleIO`
   is needed.
2. Is IndexedDB available to `clew-preview://` documents in WKWebView?
   (`auto.js#openDb` resolves `null` when `indexedDB` is undefined, but a
   synchronous `SecurityError` from `open()` would reject instead — check
   the failure shape, not just the happy path.)
3. Memory and time for the first LuaLaTeX figure in the simulator; the
   device number is the owner's (§5).
4. `.clew/cache/figures/` — only if §4.2 says no.
5. `UIPrintPageRenderer` over a `WKWebView` that is attached but hidden:
   does it paginate the whole document, or does it need the view on
   screen? Fallback: `createPDF(configuration:)`, one tall page.
6. Does the vendored indexer's `embeddersOf` see canvas `file` embeds
   as embeds? (Upstream's `#restale` covers what `links[].embed` says;
   parity, not more.)

## 5. Definition of done

1. `vendor/` + `seed-vault/` at the state named above; every table row
   demonstrated in the simulator or deferred with a reason.
2. Figures: the Diagrams note typesets on a clean install with the
   engines served from the bundle; an edited figure re-typesets; a
   figure with an error shows its log; no unknown channel, no 404 in the
   scheme handler log.
3. Tests: every ported suite diffs clean against upstream (path rewrite
   only); `figures` skips honestly without a staged build.
4. No vendored file edited; iOS deltas are guarded patches or `src/`/
   `ios/`; upstream candidates recorded in PORT-PLAN.md.
5. Docs updated; nothing pushed. Device verification (§5 of HANDOVER)
   remains the owner's.

## 6. Deferred, unchanged

The ZetaOffice runtime (Quick Look stands in); site export; `\citefile`
BibDesk attachments; third-party notices; native CJK font download;
Xiaolai CJK prune; ```kanban fence touch drag; "Move to folder…"
long-press; empty folders in explorer; iCloud conflict surfacing; stale
recents pruning; canvas toolbar undo/redo. New: `.clew/cache/figures/`
(§4.4) and download-on-demand engines (§2.1), both only if measurement
asks for them.
