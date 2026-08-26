# Upstream 0.8 Sync — Implementation Plan for Clew-iOS

Written 2026-08-25 for a fresh implementation session. This plan brings the
iOS port up to parallel with upstream `../Clew-app` (v0.8.0), which is **43
commits ahead** of the iOS vendored snapshot. Read `README.md` and
`PORT-PLAN.md` first for the architecture; read `HANDOVER.md` for session
state. Everything below was verified against both repos on 2026-08-25.

## 0. Ground rules (non-negotiable)

1. **Never `git push` without the owner's explicit OK.** A push to `main`
   IS a TestFlight release (Xcode Cloud builds on every push). Commit
   locally freely.
2. **Never edit `vendor/`.** It is a wholesale mirror of upstream,
   overwritten by `npm run sync-upstream`. iOS-specific behavior goes in
   `src/`, `ios/`, or guarded build-time patches in `scripts/build.js`
   (exact-string patches that FAIL the build when upstream drifts — keep
   that property for any new patch).
3. Structural improvements that aren't iOS-specific belong upstream, not
   here — record them as upstream candidates in PORT-PLAN.md instead of
   forking vendored behavior.
4. Verification kit: `npm test`, simulator smoke via `-ClewSmokeJS`, CLEWJS
   log filter, `tools/render-note.mjs` — see HANDOVER.md §4 for the exact
   incantations and the gotchas list.

## 1. Where the repos stand

- **iOS repo**: branch `embedpdf-annotator` (clean, device-verified,
  `main` fast-forwards into it — `main` is an ancestor). It carries the
  iOS-built EmbedPDF PDF surface: inline note-embed annotator appended to
  `client.js`, canvas PDF reader + annotator overlay, Swift `updateBinary`
  bridge, embedpdf asset staging.
- **Upstream**: `../Clew-app` `main` at `ed35ba8` (confirm with
  `git -C ../Clew-app rev-parse main` — it moves; re-run the delta if it
  has advanced past ed35ba8 and skim any new commits before starting).
- **Sync point**: the iOS `vendor/` tree corresponds to upstream
  `b1b5790` ("Vault-wide bibliography and a References panel",
  2026-08-24), except for a handful of renderer/client fixes that were
  hand-applied on iOS and later upstreamed — those converge identically
  on sync (verified file-by-file).
- **Patch guards**: all 7 build-time patch anchors in `scripts/build.js`
  were checked against upstream `main` and **all still match** —
  `metadata-header.js` (10 `await import(` sites, unchanged),
  `clew-editor-view.js`, `clew-file-explorer.js`, `tab-drag.js`,
  `node-content.js` webview block, `clew-preview-view.js` (both anchors),
  `client.js` `post({ type: 'ready' });` (still the final statement). The
  sync will not break the build; the danger is *silent runtime* breakage,
  which this plan exists to prevent.

### What upstream shipped since b1b5790 (the feature arcs)

| Arc | Commits | iOS cost |
|---|---|---|
| **EmbedPDF PDF surface** (all three surfaces, autosave, CJK-fonts setting) | 3c5ccff→733de49, merge e0a363d | The big reconciliation — §5 |
| **Excalidraw** (Obsidian drawings, React editor shimmed in an iframe) | 985a766→2e739c3, merge 788ccc9 | Build + shim + Swift — §6 |
| **Dataview DQL / dataviewjs / Bases** (.base files) | aa4811f, 7894992, 68b8564 | Engine config + worker registry — §4 |
| **Obsidian callouts** (whole family, foldable, nested) | 0668ad0 | Engine config + worker registry — §4 |
| **Block references** `[[Note#^id]]` read + written | fc033d4 | Engine config + worker registry — §4 |
| **Markdown table editing** (Tab/Enter in editor) | 4d2add6 | Free with sync |
| **Engine: `@image`/`@video` directives** (media.js), pandoc citations, `\citefile` | 449d9a0, e13eec4, 733de49 | Mostly free; one config key; caveats §4 |
| **Note Headers 1.2.0** (live HTML banners, `data-clew-keep`) | e607932, d07b3f4, 918e008 | Already on iOS; sync converges |
| **Pane/split/focus fixes** | dc336ee, e8be76c, dcc8ee8, a604e25, eb8f259, 70385f2 | Free (mostly already on iOS) |
| **Vault report / dataview report / third-party notices** | 9caec4a, ed35ba8, 2e4726a | Dev-only; notices deferred §9 |

New upstream IPC channels (`src/shared/channels.js`), all of which the iOS
shim must handle or deliberately neutralize:

| Constant | String | iOS disposition |
|---|---|---|
| `CH.PDF_WRITE` | `clew:pdf-write` | Implement (§5.3) |
| `CH.EXCALIDRAW_LIB_GET` | `clew:excalidraw-lib-get` | Implement (§6.4) |
| `CH.EXCALIDRAW_LIB_SET` | `clew:excalidraw-lib-set` | Implement (§6.4) |
| `CH.PDF_FONTS_STATUS` | `clew:pdf-fonts-status` | Stub (§5.6) |
| `CH.PDF_FONTS_DOWNLOAD` | `clew:pdf-fonts-download` | Stub (§5.6) |
| `CH.PDF_FONTS_REMOVE` | `clew:pdf-fonts-remove` | Stub (§5.6) |

## 2. The strategic decision (already made — do not relitigate)

Upstream's EmbedPDF surface is a **second-generation rewrite of the iOS
branch's own design** — commit 3c5ccff explicitly credits "the lesson
Clew-iOS paid for" (ArrayBuffer feed, wasm-in-a-preview-document, airgapped
fonts, the 2.5s debounce). It lives almost entirely in files the wholesale
vendor sync delivers (`preview-client/pdf-core.js`, `pdf-embed.js`,
`pdf-page.html/js`, `renderer/pdf-save.js`, `lib/preview-url.js`,
channels). An unreconciled sync degrades **silently**: upstream's
`initPdfEmbeds()` wins the note embeds and its saves hit `CH.PDF_WRITE`,
which the iOS shim rejects → every annotation save fails; two save bridges,
two CSS blocks with the same id, and two `window.__clewPdfViewers` shapes
coexist; the iOS MutationObserver rips out upstream's canvas PDF iframes.

**Therefore: adopt upstream's surface, retire the iOS parallel
implementation, keep the iOS platform layer** (Swift `updateBinary`, asset
staging, scheme-handler roots, and the Pencil touch conventions, re-hooked
onto upstream's viewers). Details in §5.

## 3. Phase 0 — Preflight

1. `cd /Users/jalex/Source/Clew/Clew-iOS`; confirm clean tree on
   `embedpdf-annotator`. Create the work branch from it:
   `git switch -c upstream-0.8-sync`.
   (Do NOT rebase or touch `main`/`origin`. Whether the owner ships
   `embedpdf-annotator` to TestFlight before this lands is their call and
   doesn't affect this branch.)
2. Record the upstream SHA you sync: `git -C ../Clew-app rev-parse main`.
   Put it in the sync commit message.
3. Baseline: `npm test` → 19 passing. `npm run build` → succeeds.

## 4. Phase 1 — Mechanical sync, deps, engine plumbing

### 4.1 sync-upstream.js

- Add `'excalidraw'` to the copied-dirs list
  (`for (const dir of ['renderer', 'shared', 'preview-client', 'engine', 'main'])`)
  so `../Clew-app/src/excalidraw/` (the React editor page, `page.html` +
  `page.js`) lands in `vendor/clew/excalidraw/`.
- Add `'excalidraw-library.json'` to `CLEW_STATE_EXCLUDED` — upstream's
  demo vault carries a shape library under `.clew/`; it's per-user state,
  not vault documentation, and shouldn't ship in the seed vault.

### 4.2 package.json

Add and `npm install`:
`"@excalidraw/excalidraw": "^0.18.1"`, `"react": "^18.3.1"`,
`"react-dom": "^18.3.1"`, `"lz-string": "^1.5.0"`.
(`@embedpdf/*` ^2.15.0 and `pdfjs-dist` are already present; pdfjs may be
*removed* later — §5.5.)

### 4.3 Run the sync + build

`npm run sync-upstream && npm run build`. Both should succeed (patch
anchors verified). The app is **runtime-broken** at this point (unknown
channels, missing asset roots) — expected; don't debug it yet. Commit the
vendor drop as its own commit ("Sync upstream @ <sha>") so later diffs are
readable.

### 4.4 Engine worker registry — `src/worker/engine-worker.js`

The generated engine config names four new extension files that the worker
must pre-bundle (dynamic `import()` is dead in a bundle; the build patches
`metadata-header.js` to consult `globalThis.__jmdExtensionRegistry` first).
Mirror the existing three entries (wikilinks / obsidian-fences /
query-fences) exactly — same key-path convention — adding:

- `vendor/clew/engine/block-refs.js`
- `vendor/clew/engine/dataview.js` (its imports — `dv-expr.js`,
  `dv-functions.js`, `dataview-js.js`, `vault-model.js` — resolve through
  the bundler; one registry entry per *config-named* file is enough)
- `vendor/clew/engine/bases.js`
- `vendor/clew/engine/callouts.js`

Portability facts (already audited — trust these): none of the new engine
files use Node builtins beyond the already-shimmed set. `vault-model.js`
walks `process.env.CLEW_VAULT_ROOT` via the fs shim (same pattern as
wikilinks.js) — works against the vfs snapshot. `dataview-js.js` uses
`new Function` — the worker already runs `vm.runInThisContext` (indirect
eval, M3-verified), which is gated by the same CSP class, so this should
work; smoke-verify. Its failures render as an error notice, so worst case
is graceful. `bases.js` reads `CLEW_SESSION_ID` (already passed).
`media.js` in the engine calls `execSync('ffmpeg …')` **only on the LaTeX
path**, always inside try/catch — the throwing `child_process` shim
degrades it to "no ffmpeg", never a crash.

### 4.5 Render service config — `src/shim/render-service.js`

Mirror upstream `src/main/render-service.js` (read its diff against the
old vendor copy) in `#engineConfig()`:

1. Add the four `Extensions` lines with upstream's exact extension-name
   lists, **in upstream's order, callouts LAST**:
   - `tableBeforeAnchor, blockAnchorLine, blockAnchor from <engine-assets>/block-refs.js`
   - `dataviewFence, dataviewJsFence, dataviewInline from <engine-assets>/dataview.js`
   - `baseFence from <engine-assets>/bases.js`
   - `calloutBlock from <engine-assets>/callouts.js`
   Ordering is load-bearing: marked offers the most-recently-registered
   block extension first, and `calloutBlock` must beat the engine's
   GFM-alert rule.
2. Add `'Pandoc citations': this.#vaultOptions.pandocCitations === true`.
3. In the worker `env:` (currently `CLEW_VAULT_ROOT`, `CLEW_SESSION_ID`,
   ~line 163) add `CLEW_DATAVIEW_JS: this.#vaultOptions.dataviewJs === true ? '1' : ''`.

Also check `#loadVaultOptions()` picks up the two new vault-settings keys
(`pandocCitations`, `dataviewJs`) if it filters keys.

### 4.6 Settings triggers — `src/shim/ipc.js`

The `VAULT_SETTINGS_SET` handler's reconfigure trigger (currently
`jmarkdownProject || normalSyntax`, ~line 205) must add
`pandocCitations` (upstream parity). Also add `dataviewJs` — upstream
omits it (takes effect only on next vault open there), which looks like an
oversight; making it immediate on iOS is strictly better and shim code is
iOS-owned. Record "add dataviewJs to upstream's reconfigure list" as an
upstream candidate in PORT-PLAN.md.

### 4.7 Text-extension gap — `src/shim/vault-manager.js`

`TEXT_EXT` (~line 21) must gain `'excalidraw'` and `'base'`. Without this,
plain `.excalidraw` and `.base` files mirror as binary stubs — not
indexed, not renderable, not writable through the vfs. (`.excalidraw.md`
already passes as `.md`.)

## 5. Phase 2 — PDF surface reconciliation

Read `vendor/clew/preview-client/pdf-core.js`, `pdf-embed.js`,
`pdf-page.js`, and `vendor/clew/renderer/pdf-save.js` before touching
anything — the iOS work below hooks their actual shapes.

### 5.1 Retire the iOS parallel surface

- **`src/preview/pdf-viewer.js`**: delete, and remove its append from
  `previewClientPatches` in `scripts/build.js`. KEEP the `pageshow`
  re-announce patch (that's a WebKit fix, still needed). Before deleting,
  extract the Pencil finger-pan logic into the new touch module (§5.4).
- **`src/preview/pdf-annotator.html`**: delete, plus its staging line
  (`assets['embedpdf/clew-annotator.html']`) in `stageStatic()`.
- **`src/shim/ios-ui.js`**: remove the canvas-PDF machinery — the
  MutationObserver that rips out `iframe.canvas-pdf-frame`, the PDF.js
  reader mount, the ✎ Annotate overlay, and the `clew-pdf-save` message
  listener. The vendored `node-content.js` now points canvas PDF nodes at
  `pdf-page.html` itself. Keep the generic canvas media tap-to-engage for
  video/audio/iframe nodes; drop only the `.clew-canvas-pdf` specifics.
- **`src/ios/index.html`**: remove `'wasm-unsafe-eval'` from the CSP —
  no wasm runs on the app page anymore (the annotator overlay that needed
  it is gone; both repos' shared rule is "heavy wasm lives in clew-preview
  documents"). If anything on the app page breaks, put it back and note
  why.
- **QuickLook file-tab override** (`ios-ui.js` `workspaceStore.openFile`
  routing `.pdf` → QuickLook): REMOVE, so PDFs open in tabs via the
  vendored `clew-file-view` → `pdf-page.html` (desktop parity, in-app
  annotation). The `quickLook` Swift bridge stays (harmless, and useful
  as a fallback). *Owner-reversible decision — flag it in your handover.*

### 5.2 Bundle + stage upstream's viewer page

In `scripts/build.js`:

- `buildPreviewClients()` currently bundles `client.js`, `api.js`,
  `site-client.js`. Add `pdf-page.js` (same iife config). Note
  `pdf-core.js` contains a template-literal dynamic
  `import('/__clew_assets__/embedpdf/embedpdf.js')` — esbuild leaves
  non-analyzable `import()` alone (upstream's own iife build relies on
  this); confirm no build warning demotes it.
- `stageStatic()`: copy `vendor/clew/preview-client/pdf-page.html` into
  `webroot/preview-client/`.
- The embedpdf staging (`@embedpdf/snippet/dist` → `preview-assets/embedpdf`,
  pruned) already exists on this branch — keep it; upstream's `pdf-core`
  fetches the identical `/__clew_assets__/embedpdf/` paths.

### 5.3 The save path — `CH.PDF_WRITE` in `src/shim/ipc.js`

Upstream flow (all vendored, runs verbatim once the channel exists):
viewer iframe → `postMessage {source:'clew-pdf', type:'pdf-save', id,
path, bytes}` → `renderer/pdf-save.js` bridge (installed by vendored
`main.js`) → `ipc.invoke(CH.PDF_WRITE, { path, bytes })`.

Implement the handler mirroring upstream `vault.js#writePdf`'s deliberate
narrowness: path must resolve inside the vault, match `/\.pdf$/i`, contain
no `..` segments, and **already exist** (overwrite-in-place only — never
create). Then `bridgeCall('updateBinary', { rel, base64 })` — the Swift
side (`FSBridge`/`VaultStore.updateBinary`, already on this branch)
re-enforces existence + containment and does a coordinated write. Bytes
arrive as a structured-clone `Uint8Array`; base64-encode for the bridge.
Update the vault mirror's knowledge of the file (mtime) the same way other
binary writes do, so the reader remount logic sees fresh bytes.

This one handler makes all three upstream surfaces (note embeds, file
tabs, canvas nodes) save on iOS.

### 5.4 Pencil finger-pan layer (iOS-only, re-hooked)

Extract from the old `pdf-viewer.js`: once a `pen` pointer is seen, while
a free-drag annotation tool is active (`ink`, `inkHighlighter`, `circle`,
`square`, `line`, `lineArrow`, `polyline`, `polygon`), fingers pan (manual
scroller drive — EmbedPDF's layers set `touch-action: none`) and the
Pencil draws; tracked via `annotationCap.onActiveToolChange`.

Re-implement as a small standalone module, e.g. `src/preview/pdf-touch.js`,
that discovers viewers through upstream's kept hooks (read `pdf-core.js` /
`pdf-embed.js` for the registry shape — upstream preserved
`window.__clewPdf*` smoke hooks) and subscribes to `onActiveToolChange`.
Append it to BOTH the `client.js` bundle (inline embeds) and the
`pdf-page.js` bundle (file tabs + canvas nodes) — an esbuild `footer` or
the existing append-source pattern both work; keep the guarded-anchor
style if patching. Record the whole convention as an upstream candidate
(it self-arms only after a pen pointer is seen, so desktop would be
untouched).

Owner follow-up from the previous session still applies: the finger-pan
*feel* needs an iPad check.

### 5.5 Canvas-embed scenes + dropping PDF.js

Upstream still emits raw `<embed type="application/pdf">` inside
`.canvas-embed-scene` (canvases embedded in notes) — Chromium renders
those with its plugin; WebKit shows one static page. This is a genuinely
iOS-only gap the old branch filled with a PDF.js reader.

**Default: swap scene PDF embeds for `pdf-page.html?src=…` iframes** (same
origin inside the preview document) via a small addition to the appended
iOS client module, and then **remove PDF.js entirely**: delete
`src/preview/pdf-reader-core.js` and the six `pdfjs/*` staging entries in
`stageStatic()` (several MB off the app). One PDF stack everywhere.
Caveat to verify on device: one Pdfium engine per scene-PDF — watch memory
on a note embedding a canvas with several PDFs. If that's bad, fall back
to keeping `pdf-reader-core.js` for scenes only.

### 5.6 CJK fonts machinery — neutralize honestly

Upstream's `pdf-core.js` fetches `/__clew_assets__/pdffonts/fallback.json`
on every viewer open; upstream answers it dynamically (a fonts config when
the 139 MB Noto pack is downloaded, the literal string `null` otherwise).

- **Swift** (`SchemeHandler.swift`): answer
  `__clew_assets__/pdffonts/fallback.json` with body `null`
  (`application/json`). (A 404 also degrades — pdf-core catches — but the
  explicit answer is clean and matches upstream's "off" state.)
- **Shim**: register the three `CH.PDF_FONTS_*` channels defensively:
  STATUS returns `{ installed: false, downloading: false, progress: null,
  packs: [], totalBytes: 0, bytesOnDisk: 0 }`; DOWNLOAD/REMOVE reject with
  a clear "not available on iOS" error.
- **Settings UI**: the vendored settings view renders a "PDF viewer"
  section whose download button would dead-end. Add a guarded build.js
  patch removing the `this.#section('PDF viewer', …)` call from
  `vendor/clew/renderer/components/views/clew-settings-view.js` (find the
  exact current string first; keep the fail-loud `patched()` helper).
  Native CJK download via URLSession is a possible later feature — note
  it, don't build it.

### 5.7 Swift asset roots for PDF

`SchemeHandler.swift` `assetRoots` (~line 42): add
`"clewpdf"` → the staged `preview-client/` directory (where
`pdf-page.html` + `pdf-page.js` land). The `"embedpdf"` root already
exists on this branch. Vendored code requests
`clew-preview://vault/__clew_assets__/clewpdf/pdf-page.html?src=…` (the
session id travels inside `src`, not the page URL).

## 6. Phase 3 — Excalidraw

### 6.1 Build the editor page

Upstream quarantines React in one minified iife bundle:
`src/excalidraw/page.js` (+ `page.html`), built with esbuild options
`jsx: 'automatic'`, `conditions: ['production']`,
`define: {'process.env.NODE_ENV': '"production"'}`, `minify: true`,
`loader: { '.woff2': 'file', '.ttf': 'file', '.png': 'file', '.svg': 'file' }`.
Copy upstream's `scripts/build.js` config for this bundle (read it —
don't guess), outputting to `webroot/preview-assets/clewex/` and staging
`vendor/clew/excalidraw/page.html` beside it.

### 6.2 Stage the Excalidraw runtime assets

The page sets `window.EXCALIDRAW_ASSET_PATH = '/__clew_assets__/excalidraw/'`
so fonts/locale data never hit a CDN. Mirror upstream's mapping: stage
`node_modules/@excalidraw/excalidraw/dist/prod` filtered to `fonts/**` and
`data/**` into `webroot/preview-assets/excalidraw/`, matching whatever
subpaths the page actually requests (verify against upstream
`src/main/protocol.js`'s `excalidraw` root and the packaged extraResources
layout — the target layout must make
`/__clew_assets__/excalidraw/fonts/…` resolve).

### 6.3 Swift asset roots

`SchemeHandler.swift`: add `"clewex"` → staged `clewex/` dir and
`"excalidraw"` → staged excalidraw assets dir.

### 6.4 Shim channels — `src/shim/ipc.js`

- `CH.EXCALIDRAW_LIB_GET`: return the parsed contents of the vault's
  `.clew/excalidraw-library.json` or `[]` — use the same vault-state
  load/save path the workspace state uses (upstream:
  `vaults.loadState('excalidraw-library.json') ?? []`).
- `CH.EXCALIDRAW_LIB_SET` `{ items }`: save it, return `true`.

Everything else (file-tab hosting, canvas nodes, note embeds via
`excalidraw-embed.js`, the save bridge gating on `isExcalidrawPath()` and
forwarding to the existing `CH.NOTE_WRITE`, indexing drawings via
`extractDrawingMetadata`, `file:new-drawing` command, `excalidrawFormat`
vault setting) arrives vendored and runs through existing iOS machinery —
`lz-string` (§4.2) and `TEXT_EXT` (§4.7) are the only substrate gaps.

### 6.5 Known risks to verify (don't skip)

- React 18 + @excalidraw/excalidraw 0.18 under WKWebView / the Safari-16
  esbuild target, loaded over a custom scheme — untested anywhere.
  Simulator first, then device.
- The note-embed case is an iframe *inside* the preview iframe posting to
  `window.top` — two frames deep across custom-scheme origins. WebKit's
  moved-iframe stale-window-proxy gotcha (PORT-PLAN "WebKit findings")
  may bite here; the existing rebuild-on-no-ready patch covers preview
  frames, not grandchildren. If saves/library calls silently vanish from
  an embed after workspace reshuffles, that's the signature.
- `page.html` hardcodes `data-theme="dark"` upstream (cosmetic; fine).

## 7. Phase 4 — Tests

1. Mirror upstream's new pure-Node tests with import paths adjusted to
   `vendor/clew/…`: `callouts.test.js`, `dataview.test.js`,
   `dataview-js.test.js`, `bases.test.js`, `excalidraw-file.test.js`,
   `excalidraw-index.test.js` (all engine/shared-layer, no Electron,
   run under `node --test` with real tmp-dir vaults +
   `process.env.CLEW_VAULT_ROOT`). Skip `block-refs.test.js` /
   `tables.test.js` if their renderer imports drag in DOM (lower value —
   they test vendored code exercised upstream).
2. Extend the iOS engine-worker render battery
   (`tests/engine-worker.test.js`) with at least: a callout note, a
   `[[Note#^id]]` block transclusion, a `dataview` TABLE, and a `.base`
   render — these go through the actual worker bundle + registry, which
   is exactly what the upstream tests can't cover.
3. `npm test` — all green (19 existing + new).

## 8. Phase 5 — Verification

### 8.1 Automated

`npm run sync-upstream && npm run build && npm test` — the full
propagation check. Then rebuild + reinstall the app in the simulator
(remember: a failed xcodebuild leaves the previous build installed —
check for `** BUILD SUCCEEDED`; uninstall for clean state).

### 8.2 Simulator smoke (seed vault has demo content for every arc)

Use the HANDOVER §4 kit (iPad sim `90DCB612-1B85-4E1A-A17A-DBEB98F6C36D`),
screenshots + CLEWJS logs:

- `Guide/Callouts.md` → callout boxes render, fold toggles work.
- `Guide/Links and Embeds.md` → block-ref links + `![[…#^id]]`
  transclusions.
- `Features/Queries.md` → Dataview TABLE/LIST render; `.base` embed
  renders (was "(not found)").
- dataviewjs: off by default → gated notice; enable `dataviewJs` in vault
  settings → executes (verifies `new Function` in the worker).
- `Guide/Drawings.md` → Excalidraw embed renders;
  `Attachments/Round Trip.excalidraw.md` opens in the editor, a stroke
  saves and round-trips (file bytes change, embed re-renders).
- PDF: note embed renders via upstream viewer, annotate → autosave chip →
  vault file changes; PDF file tab opens `pdf-page.html`; canvas PDF node
  shows the viewer; canvas-embed scene PDF shows the §5.5 choice.
- `Guide/Note Headers.md` → matrix-rain banner keeps animating across an
  edit (data-clew-keep).
- Table editing: Tab/Enter inside a markdown table in the editor.
- Regression sweep: wikilink follow, search, kanban render, canvas ink,
  mermaid/MathJax, external-vault open.

### 8.3 Device (owner)

Pencil finger-pan feel while drawing (both inline and pdf-page surfaces);
Excalidraw with Pencil; EmbedPDF usability inside a small canvas node —
upstream's answer is its fullscreen control, so verify element fullscreen
works in WKWebView (`clew-preview-view` / node iframes carry
`allow="fullscreen"`; WKWebView needs the fullscreen preference enabled —
check `WKPreferences.isElementFullscreenEnabled` on the config). If
fullscreen is unsatisfying, resurrect a thin overlay *reusing
pdf-page.html* (not a separate annotator). Memory on many-PDF /
many-drawing notes.

## 9. Deferred / explicitly out of scope

- **CJK PDF fonts** native download (139 MB Noto via URLSession) — stubbed
  off per §5.6.
- **`\citefile` BibDesk attachments**: the engine's new
  `bib-attachments.js` uses Buffer APIs the iOS `BufferShim` lacks
  (`readBigUInt64BE`, `swap16`, `latin1`/`utf16le` decodes), and its
  output is `file://` URLs — useless in WKWebView regardless. If a note
  using `\citefile` errors at render, that's this; the fix (extend
  BufferShim + map to clew-preview URLs) is a follow-up, not this pass.
- **Third-party notices surface**: upstream ships THIRD-PARTY-NOTICES.md
  + an Electron menu item. iOS needs its own surface eventually
  (App Store licence hygiene) and the notices regenerated for the iOS
  dependency set — record as an open item.
- Pre-existing open items (kanban touch drag, move-to-folder, empty
  folders, sync phase 2, …) — unchanged, see HANDOVER §3.

## 10. Definition of done

1. `vendor/` == upstream at the recorded SHA; `sync-upstream && build &&
   test` green; no silent-degradation leftovers: exactly one PDF pipeline
   (grep the built `client.js` for a single `clew-pdf-inline-css`
   definition; no `clew-pdf-save` listener in `ios-ui.js`; no
   `pdf-annotator.html` anywhere).
2. All six new channels handled (three implemented, three stubbed) — no
   "Unknown channel" in CLEWJS logs across the smoke sweep.
3. §8.2 simulator sweep fully passing with screenshots.
4. HANDOVER.md rewritten for the session; PORT-PLAN.md gains the new
   upstream candidates (pencil convention, dataviewJs reconfigure,
   canvas-scene PDF embeds) and records the §5.1 QuickLook decision.
5. Committed locally on `upstream-0.8-sync`. **NOT pushed, NOT merged to
   main** — the owner device-verifies first, then says the word.
