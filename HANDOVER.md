# Handover — 2026-09-17 (upstream 0.11 sync: DONE, simulator-verified, unpushed)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8/0.9/0.10-PLAN.md` and
now `UPSTREAM-0.11-PLAN.md` are **history**: executed in full; read them
for the reasoning behind a decision.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. Where things stand

Seven layers of finished, unpushed work, every phase tip green on its
own (`npm test` 388, `npm run build`, xcodebuild clean):

```
main                6f75e34   (10 ahead of origin, UNPUSHED, deliberately not moved)
 └ …0.8 chain… → …0.9 chain… → canvas-delete-button → embedpdf-vendor
    └ contracts-p1…p3 → sync10-p1…p5 (sync10-p5-verify add3a49)
       └ sync11-p1-vendor 09e59e3 → sync11-p2-figures b5d3bf5 → sync11-p3-platform aa7b6bf
          → sync11-p4-print 04e1d13 → sync11-p5-verify   ← TIP: review and merge
```

- **Everything before `sync11-*`** — unchanged from the previous
  handover; all simulator-verified.
- **0.11 sync** (`sync11-p1…p5`, all 2026-09-17) — `vendor/` +
  `seed-vault/` at upstream **`da5f68a` plus the working tree's two
  owner-requested uncommitted items** (LibreOffice icon revert;
  `\nopagenumbers` gone from ```tex), 29 commits on from e64cf06. No new
  npm deps. Per phase:
  1. *p1 vendor*: `figures.js` registered in the worker (Extensions +
     a new `Environments` config key, both through the patched
     `__jmdImport`); `shims/require-registry.js` maps
     `require('highlight.js')` onto the bundled instance so MetaPost
     `show=code` highlights; the shim render service gained upstream's
     `embeddersOf` + `#restale` (embedded notes refresh); ten test
     suites refreshed/ported. `Widgets.md` smoke residue reset to
     da5f68a's copy; `.clew/history/` joins the seed's excluded state.
  2. *p2 figures*: **mp-tikz-wasm ships in the app bundle** —
     `scripts/stage-mptikz.js` fills gitignored `mptikz-assets/` from
     `../Clew-app/mptikz-assets`, the master build, or the SHA256-pinned
     release in the vendored manifest; `npm run build` copies it into
     `dist/webroot/preview-assets/mptikz` (3,645 files, 84 MB);
     SchemeHandler serves the `mptikz` root immutable;
     `ci_post_clone.sh` stages with `--require`. Measured on a clean
     sim install: seven figures cold in **2.3 s** (LuaLaTeX incl.), an
     edited figure alone in 0.5 s with six SVGs kept, a reopened note
     from IndexedDB in 251 ms; the library's in-worker sync XHR reaches
     the scheme handler. `figures.test.js` ported (checks the staged
     bundle's libraries).
  3. *p3 platform*: `SHELL_OPEN_PATH` = upstream's `planOpen` over the
     mirror, then Quick Look; `file://` only inside the open vault;
     folders refused. **Global plugins in `Documents/Plugins`**:
     VaultStore snapshots it beside the vault, the mirror carries it
     under `/global-plugins`, `plugins.js` runs verbatim over both
     roots, the worker snapshot carries a global engine surface,
     SchemeHandler serves `__clew_plugin_file__/<sid>/<id>/…`, and the
     reveal opens the Files app (`shareddocuments://`). `alert()` now
     shows, in its own window on the app's scene.
  4. *p4 print*: **Export as PDF (reading view)** — `PrintPDF.swift`
     loads the note's preview URL in a hidden `WKWebView` behind the app
     at the printable width, runs upstream's arm/probe scripts
     (`src/shim/print-pdf.js`, copied verbatim), light theme,
     `UIPrintPageRenderer` at `printPaperSize`, share sheet. Diagrams:
     five A4 pages in 3.3 s, figures and MathJax as vectors, rendered
     page by page with PDFKit and eyeballed.
  5. *p5 verify*: clean-install sweep — Welcome on first launch; the
     Links guide's folded embed toggled in the preview wrote `|open` to
     its own line 50 (the inline-code mention on 55 untouched);
     `|quiet`/`|bare` rendered; a Grandparent→Parent→Child chain
     re-rendered with the child's new text; history snapshot; search;
     TikZ fence faces in the editor, Avenir Next in both panes; the
     Widgets guide's Web Awesome elements; `Rating::` as `<dt>`;
     closed folders restored across a relaunch (Guide's children
     hidden); reading position → cursor line after the flip; PDF tab
     on `pdf-page.html`; Excalidraw tab.

The iPad sim (90DCB612…) has the tip's build installed. Its Demo Vault
carries sweep residue (`.clew/scripts/probe-*.js`, `Chain A/B/C.md`,
`Global Plugin Note.md`, the Links guide's `|open` write-back,
`Documents/Plugins/hello-global`, `Documents/Plugins` itself) —
uninstall + reinstall to reseed. Working tree clean after this commit.

## 2. Decisions the owner should know about (all reversible)

1. **The TeX engines ship in the bundle** (~70 MB more on the App Store
   listing). Download-on-demand is the alternative, but iOS has no
   downloader yet and the release is a `.tar.gz` Foundation can't unpack.
2. **Global plugins = `Documents/Plugins`** (Files-visible; desktop's
   `<userData>/plugins` would be unreachable). No rescan watches it — a
   plugin dropped in mid-session appears at the next vault open.
3. **"Open in default app" = Quick Look**, `file://` links inside the
   vault only. A `.bib` (no previewer) shows Quick Look's generic card
   with the share button — that IS the open-in rung.
4. **Reading-view PDF goes to the share sheet**, not a file dialog.
5. **Two pre-existing bugs fixed on the way**: `alert()` was silent, and
   **the iPad share sheet had never presented** (popover anchored to the
   whole web view; the HTML export was affected since the first sync).
6. **Upstream demo bug fixed in `../Clew-app`'s WORKING TREE,
   uncommitted**: `demo-vault/Features/Diagrams.md`'s ```tex fence used
   `\frac`, undefined in plain TeX — now `{1 \over n^2} = {\pi^2 \over 6}`
   (the owner's diagnosis). It sits beside the owner's own pending edit
   to that file; commit it with theirs. The manual carries no plain-TeX
   snippet, so nothing to change there.

## 3. Upstream state

`../Clew-app` main = **`da5f68a`**, tree DIRTY with: the owner's two
items (icon revert, `\nopagenumbers`), their `Widgets.md` smoke residue,
and my one-line Diagrams.md fix (§2.6). We vendored that tree minus the
Widgets residue. `../Clew-docs` untouched. `~/Source/mp-tikz-wasm` at
`main@ff8a98b` is what upstream staged and what we copied.

## 4. Open items

1. **Device verification, then merge + push** = a TestFlight release.
   Hardware-specific now: **figure memory and timing on the iPad**
   (LuaTeX in wasm; the sim can't measure memory), plus everything in
   the previous handover's list (Pencil, Excalidraw, Pdfium, chords,
   Quick Look thumbnails, history modal, Web Awesome on touch). Suggested
   merge: fast-forward `main` to `sync11-p5-verify`.
2. **Manual caveats for `../Clew-docs`** (the owner's): figures typeset
   on iOS too, engines bundled (no download); global plugins live in
   the Files app under Clew › Plugins; `|external` and `file://` open
   in Quick Look, inside the vault only; "Export as PDF (reading view)"
   offers the share sheet; the LaTeX PDF still needs the desktop; plus
   the previous handover's five items (history, first launch, `.clew/`
   table, office, settings keys).
3. **Upstream notes**: Web Awesome logs `[wa-color-picker] size="small"
   is deprecated. Use size="s"` on the Widgets guide (Meta Bind's
   `size="small"`, c579d11); `print-pdf.js`'s arm/probe scripts would be
   importable here if exported from an electron-free module (they are
   copied verbatim in `src/shim/print-pdf.js` — keep in step).
4. Probe subtlety, not a bug: a plugin preview script's `<body>`
   attribute set at load is stripped by the first morph (body attrs are
   synced from the incoming HTML); an attribute set later survives. The
   global plugin's sibling fetch proved the route.
5. Possible follow-ups, unchanged: canvas toolbar undo/redo; Pencil
   long-press → contextmenu; "New drawing" in the explorer root menu; a
   THIRD-PARTY-NOTICES surface (now also mp-tikz-wasm's TeX bundles).
6. Deferred, unchanged: `\citefile`; native CJK font download; Xiaolai
   prune; ```kanban touch drag; "Move to folder…"; empty folders in the
   explorer; iCloud conflict surfacing; stale recents pruning; ZetaOffice.

## 5. Verification kit (works, use it)

- `npm test` — 388 green. `node tools/render-note.mjs <vault> <note>`
  renders through the worker (figures come out as `<tikz-diagram>` /
  `<metapost-diagram>` elements holding source; the browser typesets).
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first**; read via `xcrun simctl spawn
  <sim> log show --start "<date>" --predicate 'eventMessage CONTAINS
  "CLEWJS"'`. FUNCTION BODY; `return` an async IIFE; **no backslashes**;
  `git commit -F file`.
- **Inside a preview document**: drop a vault script at
  `<vault>/.clew/scripts/probe.js` (injected into every preview; no
  manifest) that `console.warn('PROBE …')`s — the DEBUG console
  forwarder logs every frame. Re-arm on `document.addEventListener(
  'clew:render', …)` for post-morph state. Cross-origin iframes stay
  unreachable from the app page.
- Screenshots: `xcrun simctl io <sim> screenshot x.png`. A PDF from the
  share sheet lands in the app container's `tmp/<name>.pdf`; render its
  pages with a 20-line PDFKit script under `xcrun swift` (page count,
  MediaBox, text per page) — `qlmanage -t` only shows page 1.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry/officeDock; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId. Same-path tabs
  are REUSED and `openWikilink` navigates the active tab — count tabs
  accordingly. `ws.setTabMode(id, 'source')` flips a tab.
- On-disk checks: `xcrun simctl get_app_container <sim> <bundle> data`
  (rotates on every install); `/usr/bin/stat -f "%Sm %N"`.
- Upstream's `smoke/make-global-plugin.mjs <dir>` builds a three-surface
  plugin fixture; copy `userdata/plugins/hello-global` into the sim's
  `Documents/Plugins/` and add it to the vault's `plugins` array.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run sync-mptikz` (once; re-run when upstream restages), `npm run
build`, then `xcodebuild -project ios/Clew.xcodeproj -scheme Clew
-destination 'id=<sim>' -derivedDataPath build/DerivedData build`. A
missing `mptikz-assets/` is a build warning here and a refusal in CI.
Twelve guarded patches in scripts/build.js, all fourteen anchors
re-checked against da5f68a (none moved). New Swift files must be added to
`project.pbxproj` by hand (four entries, `C1E…/C1F…` ids —
`PrintPDF.swift` is the latest). `sync-upstream` regenerates
`AppIcon.png` non-deterministically — `git checkout --` it; it also
excludes `.clew/history` from the seed now. npm deps do NOT auto-merge
(none changed this time).
