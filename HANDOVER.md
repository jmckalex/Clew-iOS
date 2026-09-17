# Handover — 2026-09-17, late (0.11 on TestFlight and device-proven; font=note ported on top, unpushed)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8/0.9/0.10-PLAN.md` and
now `UPSTREAM-0.11-PLAN.md` are **history**: executed in full; read them
for the reasoning behind a decision.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.) A docs-only commit can carry
`[ci skip]` in its message so a later push of it does not spend a cloud
build — this handover commit does.

## 1. Where things stand

**Everything is on `main` and pushed.** On 2026-09-17 the owner
fast-forwarded `main` from 6f75e34 to `sync11-p5-verify` (e46a5ce) and
pushed; Xcode Cloud's "Default" workflow archived e46a5ce successfully
(the GitHub check on the commit says so; the success mail arrived) and
the build went to App Store Connect ▸ Clew Notes ▸ TestFlight for the
internal group. That one push released seven layers at once — the 0.8,
0.9 and 0.10 syncs, the contract parity work, and the 0.11 sync — none
of which had been on a device before. Every phase tip was green on its
own (`npm test` 388, `npm run build`, xcodebuild clean):

```
origin/main = sync11-p5-verify = e46a5ce      (the TestFlight build 0.1.0 (6), device-proven)
 main = e46a5ce + six docs commits ([ci skip], local, unpushed)
  └ fontnote-p1-vendor 4ee243d → fontnote-p2-fonts edcad8c → fontnote-p3-docs   ← TIP: review and merge
```

**On top, unpushed — `font=note` (`fontnote-p1…p3`, the evening of
2026-09-17):** vendor at upstream 4eae005; engines restaged from the
mp-tikz-wasm MASTER build (the `opentype` bundle + plain-LuaTeX patch
live on its unreleased `opentype-fonts` branch, 41d3ea4; 109 MB
staged); `NoteFonts.swift` builds the four Avenir Next faces from
CoreText and the scheme handler serves them under
`__clew_assets__/notefonts/`; the face map reaches every engine worker's
env before the first standby. Sim-verified: nine Diagrams figures incl.
two font=note in 5.1 s cold, real text with embedded faces, Avenir Next
on screen; install-over-old served the new bundle index (no stale
WebKit cache). Tests 392. **CI caveat: Xcode Cloud can only fetch the
pinned v0.2.1 release, which has no `opentype` bundle, so a TestFlight
build made from this tip refuses font=note figures by name (honestly,
in their own place) until mp-tikz-wasm publishes 0.3.0 and upstream
re-pins its manifest — then `npm run sync-upstream` + a push is all.**

The phase branches still exist locally and can be deleted once the
TestFlight build is judged good.

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
6. **Upstream demo bug, fixed and now committed upstream**:
   `demo-vault/Features/Diagrams.md`'s ```tex fence used `\frac`,
   undefined in plain TeX — now `{1 \over n^2} = {\pi^2 \over 6}` (the
   owner's diagnosis; my one-line edit). The Clew-app session committed
   it with the owner's `\nopagenumbers` change as **f92c7ea** on
   2026-09-17; nothing of ours is pending in that tree.

## 3. Upstream state

`../Clew-app` main has moved PAST what we vendored: da5f68a → f92c7ea
(the demo fix + `\nopagenumbers`), 3339969 (**`font=note`**, §4.4b),
4897ad3 (screenshot kit), b14671a (`main/asset-stamp.js`, engine-cache
stamp) — tree clean, nothing pushed, per the Clew-app session on the
evening of 2026-09-17. We vendored da5f68a plus the working tree's two
owner-requested items (minus the Widgets.md residue); the next sync
starts from f92c7ea's successors. `../Clew-docs` main = 5372a7c (the
app agent's illustration pass ca62354, `diagrams.html#note-font` +
`publishing.html#figures` 2d60de1, handover 5372a7c, on top of my
cef2e0f/6c97f5b); still not deployed. `~/Source/mp-tikz-wasm` at
`main@ff8a98b` is what upstream staged and what we copied; the
`opentype-fonts` branch is unreleased.

## 4. Open items

1. **Device verification of the TestFlight build** (0.1.0 (6)). **The
   owner ran it on the iPad on 2026-09-17: TikZ and LaTeX figures typeset
   on the device — "works perfectly".** The build had to be added to the
   Internal group by hand (no automatic distribution on the group; see
   memory). Still unchecked on hardware, everything the earlier
   syncs never had on a device: Pencil finger-pan feel, Excalidraw with
   Pencil, per-scene Pdfium memory, hardware-keyboard chords incl.
   Alt-Q fill-paragraph, Quick Look + QL thumbnail timing, the history
   modal, Web Awesome widgets on touch, the reading-view PDF's share
   sheet on a real screen, Documents/Plugins in the Files app. A bad
   result is fixed forward on a new branch off `main`; the old chain
   tips remain as fallbacks.
1b. **Version numbering, the owner's call.** Three schemes coexist:
   upstream's tags (v0.7.0–v0.9.0; `package.json` still 0.9.0); the
   port's sync labels, which continued the count past the last tag
   ("0.10", "0.11" name iOS sync rounds, not upstream releases, and
   will collide with a real v0.10.0 tag one day — future rounds could
   be named by date or upstream commit, e.g. `UPSTREAM-2026-09-PLAN.md`
   / `sync2609-p1-…`; the past ones are history); and the app's own
   `MARKETING_VERSION` 0.1.0 (`CURRENT_PROJECT_VERSION` 1, overridden by
   Xcode Cloud's auto-incremented build number) — bump it in the project
   before a push if the version string should say what the build
   contains. 0.9 → 0.10 is ordinary semver; the components are integers.
2. **Manual updated and COMMITTED in `../Clew-docs`** (2026-09-17,
   6de0df8 — the owner's own `\nopagenumbers` hunk went in first as
   47634d7; not yet deployed with `make sync`; the desktop-side docs for
   the rest of the 0.11 features are the app agent's, per the owner): "On
   iPad" callouts on `diagrams.html` (engines bundled, no LaTeX export),
   `plugins.html` (an iPad row in the global-folder table, the Files-app
   callout, the summary table), `links-and-embeds.html` (Quick Look,
   vault-only `file://`, plus a tap-to-fold sentence), `export.html`
   (two of four commands, share sheet instead of a save dialog), each
   with an iPad screenshot in `site/manual/images/ipad-*.jpg` (five,
   1000 px wide, from the simulator). `make check-links` clean. The
   previous handover's five caveats were already in the manual (history,
   first launch, office pages carry On iPad text).
3. **Upstream notes**: Web Awesome logs `[wa-color-picker] size="small"
   is deprecated. Use size="s"` on the Widgets guide (Meta Bind's
   `size="small"`, c579d11); `print-pdf.js`'s arm/probe scripts would be
   importable here if exported from an electron-free module (they are
   copied verbatim in `src/shim/print-pdf.js` — keep in step).
4. Probe subtlety, not a bug: a plugin preview script's `<body>`
   attribute set at load is stripped by the first morph (body attrs are
   synced from the incoming HTML); an attribute set later survives. The
   global plugin's sibling fetch proved the route.
4b. **font=note is ported** (§1). What remains is not code: the
   release. mp-tikz-wasm's `opentype-fonts` branch (41d3ea4) is
   unreleased; when v0.3.0 exists and upstream re-pins
   `shared/mptikz-manifest.json`, the vendored manifest follows on the
   next sync and CI builds carry the bundle. Until then the local build
   has it (staged from the master dist) and the TestFlight build does
   not. Also noted: the `otf-fonts` bundle (7 MB) rides along but only
   unicode-math needs it — a prune candidate in `stage-mptikz.js`
   copyTree if size matters. Desktop's `asset-stamp.js` cache clearing
   is NOT needed here: measured, WebKit served the restaged bundle
   index on an install-over-old.
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
- Fonts: a vault-script probe per figure — `data-opentype`, `svg text`
  count, `@font-face` count in the SVG's `<style>` — is the
  font=note assertion (upstream's smoke README: text>0 + embedded faces
  on marked figures, text=0 on controls). The Swift sfnt writer can be
  checked on the Mac: compile its pure functions with `xcrun swiftc`,
  build `AvenirNext-Regular`, and `cmp` against
  `../Clew-app/src/main/note-fonts.js#extractFace` on the system .ttc —
  identical bar `head`'s checksum field. The device's faces land in
  `<container>/Library/Application Support/notefonts/<iOS>/`.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run sync-mptikz` (prefers `~/Source/mp-tikz-wasm/dist`, then
upstream's staged tree, then the pinned release; `MPTIKZ_SRC` overrides;
`--force` restages; re-run after the library rebuilds), `npm run
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
