# Handover — 2026-09-18 (0.11 on TestFlight and device-proven; font=note ported on top, unpushed)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8/0.9/0.10/0.11-PLAN.md`
are **history**: executed in full; read them for the reasoning behind a
decision.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. A docs-only commit carries `[ci skip]` in its message so a push of
it spends no cloud build. (Also in Claude's memory.)

## 1. Where things stand

Three layers, from the bottom:

```
origin/main = e46a5ce   the 0.11 sync — TestFlight 0.1.0 (6), on the owner's iPad, figures typeset there
 main = e46a5ce + 6 docs commits              [ci skip], local
  └ fontnote-p1-vendor 4ee243d → fontnote-p2-fonts edcad8c → fontnote-p3-docs db9d3f6   ← TIP
```

- **The 0.11 sync** (2026-09-17, pushed, released): wasm figures shipped
  in the bundle, embeds that fold/refresh, Quick Look for `|external`,
  global plugins in Documents/Plugins, the reading-view PDF, `alert()`
  and the iPad share sheet fixed. Build 6 had to be added to the
  Internal group by hand (no automatic distribution on the group). The
  owner ran it: "TikZ and LaTeX embedded compilation works perfectly".
- **`font=note`** (the evening of 09-17, `fontnote-p1…p3`, unpushed):
  vendor at upstream 4eae005; engines restaged from the mp-tikz-wasm
  MASTER build (branch `opentype-fonts`, dist at 1dea1b8: the `opentype`
  bundle with all 72 Latin Modern faces + the plain-LuaTeX luaotfload
  patch; 3,891 files, 109 MB); `NoteFonts.swift` builds the four Avenir
  Next faces from CoreText tables and the scheme handler serves them
  under `__clew_assets__/notefonts/`; the face → file map reaches every
  engine worker's env before the first standby. Simulator, installed
  over the previous build: Diagrams' nine figures (two font=note) ok in
  5.0 s cold; upstream's Fonts.md fixture — ```latex, ```tikz, ```tex
  on plain LuaTeX, a hand-written fontspec document, **a 12pt article**,
  a control — all six ok in 5.6 s, text runs with embedded faces where
  expected, Avenir Next on screen. Tests 392, build clean, xcodebuild
  clean. The Swift sfnt writer was proven byte-identical to desktop's
  extractor (table for table) on this Mac.

Working tree clean. The sim (90DCB612…) has the fontnote build installed
over the 0.11 one; its Demo Vault carries residue (`Fonts.md`, the two
font=note fences in Diagrams, `Documents/Plugins/hello-global`) —
uninstall + reinstall to reseed.

## 2. Decisions the owner should know about (all reversible)

1. **Engines from the library's master build, not upstream's staged copy
   or the release** (`scripts/stage-mptikz.js` order: `MPTIKZ_SRC`,
   `~/Source/mp-tikz-wasm/dist`, `../Clew-app/mptikz-assets`, the pinned
   release). That is where the `opentype` bundle lives tonight. **Xcode
   Cloud can only fetch the pinned release (v0.2.1, no bundle), so a
   TestFlight build made from this tip refuses font=note figures by
   name** — honestly, in their own place, everything else typesets —
   until mp-tikz-wasm publishes 0.3.0 and upstream re-pins; then the
   next `npm run sync-upstream` + push carries it.
2. **The note's faces come from CoreText, never from Apple's font file**
   (PORT-PLAN Decisions). One sfnt per face, cached in Application
   Support keyed on the iOS version, built on first use.
3. **No engine-cache clearing on iOS** (desktop needed `asset-stamp.js`):
   measured twice — installing a build with a changed bundle over the old
   one served the new `bundles/index.json`. Revisit only if a restaged
   engine ever misbehaves after an app update; the fix would be
   `WKWebsiteDataStore` removal on a bundle-identity change.
4. `otf-fonts` (now latinmodern-math alone, 0.7 MB) rides along;
   nothing to prune any more.
5. The 0.11 decisions stand: engines in the bundle (~+70 MB on the
   listing); Documents/Plugins; Quick Look as "default app"; the
   reading-view PDF to the share sheet, Avenir Next subset and all (as
   the desktop's does — a PDF embedding the glyphs it uses is ordinary).
6. **Version numbering** is the owner's call (three schemes: upstream
   tags v0.7–v0.9, the port's sync labels "0.10"/"0.11" which will
   collide with a real v0.10.0, the app's `MARKETING_VERSION` 0.1.0 with
   Xcode Cloud's build counter). Future rounds could be named by date.

## 3. Upstream state (2026-09-18 morning)

- `../Clew-app` main = **0a4aa87**, clean. We vendor **4eae005**; the
  three commits since are `d393b78` (extractFace's `head` checksum per
  spec — the thing the iPad comparison found; plus the 12pt fixture),
  `1eb25be` (fonts scenario timings), `0a4aa87` (handover). Nothing of
  ours pending there. Next sync: trivial.
- `../Clew-docs` main = **bc0a5d9**, clean: the iPad pass (6de0df8),
  the font=note "On iPad" callout (7e7ca70), the app agent's
  illustration + measurement passes. **Not deployed — the domains still
  point at GoDaddy parking**; `make sync` waits on the DNS change and
  the provision/tls sequence in that repo's handover. Landing page says
  "in beta on TestFlight" with a mailto until a public link exists.
- `~/Source/mp-tikz-wasm` on branch `opentype-fonts` at 99aadbe, dist
  built from it; **no release past v0.2.1**. A 0.3.0 release is the
  owner's call and the only thing between this tip and TestFlight
  carrying font=note.

## 4. Open items

1. **Merge + push, the owner's call**: fast-forward `main` to
   `fontnote-p3-docs`. Pushing now releases a build whose font=note is
   refused by name (§2.1) but is otherwise the 0.11 build plus the
   4eae005 vendor drop (Widgets.md residue gone from the seed, the
   demo's two font=note fences); waiting for the 0.3.0 pin gives one
   release with the fonts. Either is fine; the docs commits on `main`
   are `[ci skip]` either way.
2. **Device check of font=note** once a build carries the bundle: the
   Diagrams note's last two figures, and a 12pt document. Memory on the
   iPad is the unmeasured number (luaotfload scans 72 faces on the first
   OpenType figure, ~7 MB through the scheme handler).
3. **TestFlight group**: turn on the Internal group's automatic
   distribution, or add each build by hand (memory:
   clew-ios-release-pipeline). External testers need an external group,
   Test Information incl. a privacy-policy URL, Beta App Review once,
   then the public link — and the landing page sentence to replace.
4. Manual: deploy is gated on DNS (§3). The two desktop sentences the
   docs handover listed (reading position → editor; Avenir Next in
   theming) were the app agent's; check `../Clew-docs/HANDOVER.md`.
5. Follow-ups seen, not requested: canvas toolbar undo/redo; Pencil
   long-press → contextmenu; "New drawing" in the explorer root menu; a
   THIRD-PARTY-NOTICES surface (now also mp-tikz-wasm's TeX bundles and
   the Latin Modern faces); a prebuilt luaotfload name database in the
   bundle (engine side; the scan is noise on the sim).
6. Deferred, unchanged: `\citefile`; native CJK font download; Xiaolai
   prune; ```kanban touch drag; "Move to folder…"; empty folders in the
   explorer; iCloud conflict surfacing; stale recents pruning; ZetaOffice.

## 5. Verification kit (works, use it)

- `npm test` — 392 green. `node tools/render-note.mjs <vault> <note>`
  renders through the worker (figures come out as `<tikz-diagram>` /
  `<metapost-diagram>` elements holding source; the browser typesets).
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first**; read via `xcrun simctl spawn
  <sim> log show --start "<date>" --predicate 'eventMessage CONTAINS
  "CLEWJS"'`. FUNCTION BODY; `return` an async IIFE; **no backslashes**;
  `git commit -F file`.
- **Inside a preview document**: a vault script at
  `<vault>/.clew/scripts/probe.js` (injected into every preview, no
  manifest) that `console.warn('PROBE …')`s; re-arm on
  `document.addEventListener('clew:render', …)`. For figures: per
  element `data-opentype`, `svg text` count, `@font-face` count in the
  SVG's `<style>` — upstream's smoke README assertions. Cross-origin
  iframes stay unreachable from the app page.
- Screenshots: `xcrun simctl io <sim> screenshot x.png`. A share-sheet
  PDF lands in the container's `tmp/`; render pages with a 20-line
  PDFKit script under `xcrun swift`. `sips` crops from the CENTRE.
- Fonts: the device's faces land in `<container>/Library/Application
  Support/notefonts/<iOS>/`. The Swift sfnt writer's pure functions
  compile on the Mac (`xcrun swiftc`); `cmp` the result against
  `../Clew-app/src/main/note-fonts.js#extractFace` on the system .ttc.
  Upstream's `smoke/make-figures-vault.mjs <dir>` writes Fonts.md.
- Upstream's `smoke/make-global-plugin.mjs <dir>` builds a three-surface
  plugin fixture for `Documents/Plugins/`.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry/officeDock; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId. Same-path
  tabs are REUSED and `openWikilink` navigates the active tab.
- A `python3 -m http.server 8000 --directory site` for the manual may
  still be running from 09-17: `kill $(lsof -t -iTCP:8000)`.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run sync-mptikz` (source order in §2.1; the stamp tracks the
engines' and `bundles/index.json`'s mtimes so a library rebuild restages
by itself; `--force` if in doubt), `npm run build`, then `xcodebuild
-project ios/Clew.xcodeproj -scheme Clew -destination 'id=<sim>'
-derivedDataPath build/DerivedData build`. A missing `mptikz-assets/` is
a build warning here and a refusal in CI (`ci_post_clone.sh` runs
`stage-mptikz --require`, which on a clean clone downloads the pinned
release). Twelve guarded patches in scripts/build.js, all anchors
re-checked at 4eae005. New Swift files go into `project.pbxproj` by hand
(four entries, `C1E…/C1F…` ids — `NoteFonts.swift` is `…AD`).
`sync-upstream` regenerates `AppIcon.png` non-deterministically — `git
checkout --` it; it excludes `.clew/history` from the seed. npm deps do
NOT auto-merge (none changed since 0.10).
