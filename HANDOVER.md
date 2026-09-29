# Handover — 2026-09-29 (the live-edit sync is pushed; the cloud build succeeded)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8/0.9/0.10/0.11-PLAN.md`
and now `UPSTREAM-LIVE-EDIT-PLAN.md` are **history**: executed in full;
read them for the reasoning behind a decision.

This session ran unattended overnight (the owner: "build this through to
completion … I'm going to sleep now"). Everything below was measured;
nothing was pushed, and the two decisions the plan flagged for the owner
stand as the plan wrote them (§2).

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. A docs-only commit carries `[ci skip]` in its message so a push of
it spends no cloud build. (Also in Claude's memory.)

## 1. Where things stand

```
origin/main = main = faa3023   PUSHED 2026-09-29 — the 0.11 sync + fontnote + canvas engage + live edit + the 0.3.0 pin
   live-p1-vendor  90d0017   vendor at ccf8dca; shell stubbed; excludes, citations, TeX fragments, @reveal
   live-p2-frames  0c3e867   block frames: __clew_block__ endpoints, block documents, keyed fragments
   live-p3-touch   06ed5cd   touch: long-press is the source, link-at, floaters read the visual viewport
   live-p5-verify  faa3023   the sweep + docs + the mp-tikz-wasm 0.3.0 pin              = main
```

(`live-p4-platform` was verification only — citations, PDF annotations,
TeX fragments, `@reveal`, exclusion lists, the explorer, sidenotes, the
guide — and changed no source, so it was folded into p5's record and the
branch dropped.) `main` was fast-forwarded to `live-p5-verify` and
pushed on 2026-09-29 at the owner's instruction. **The Xcode Cloud build
of faa3023 SUCCEEDED** — the first build carrying live edit, font=note
(its clean clone downloaded the pinned mp-tikz-wasm 0.3.0 release and
its digest checked out, which had never been exercised before) and the
canvas engage work. As of this handover it is in App Store Connect ▸
Clew Notes ▸ TestFlight but NOT yet in a tester group (§4.1); the owner
is releasing it. Working tree clean, tests **675 green**. Two docs-only
`[ci skip]` commits sit on local `main` ahead of origin (this file);
they cost no cloud build whenever they are pushed.

- **The live-edit sync** (this session): vendor/ and seed-vault/ at
  upstream **`ccf8dca`** (77 commits: live edit, the shell panel, vault
  exclusion lists, the virtualised explorer, `@reveal[…]`, TeX fragments,
  0.10.0). PORT-PLAN's milestone has the full list of what was ported and
  what was measured; the plan's STATUS line has the deviations. Headlines:
  live mode renders on the iPad's WebKit — Tier A/B in place, Tier C as
  block frames through two new scheme-handler endpoints; the touch
  conventions are in (§2); all of upstream's live-sweep scenarios that
  touch can drive pass, and the cross-reference numbering matches the
  engine's.
- **Pre-existing gap surfaced, NOT this sync's**: formatted citations and
  bibliographies never render in reading mode on iOS (the engine's
  Biblify needs `citation-js` via `createRequire`, which the worker
  refuses — `\cite{}` renders empty, a `\fullcite{}` preview is blank).
  The live-mode chips, the References panel, Insert and completion work
  (they read the `.bib` files directly). Follow-up: bundle citation-js
  into the worker through the require registry, as highlight.js is
  (README known gaps).
- **mp-tikz-wasm 0.3.0 is pinned** (this session, after the sync): the
  library session published v0.3.0 (the `opentype` bundle, plain-LuaTeX,
  `fonts: 'woff2'`; engines unchanged from 0.2.1), the Clew-app session
  pinned it in `src/shared/mptikz-manifest.json` (368bfd7, pushed), and
  the mirror here carries that manifest. The archive's size and digest
  were verified independently here; the local engines are restaged from
  the same build; two never-cached font=note figures typeset on them in
  the simulator. So a cloud build from this tip ships font=note figures —
  the gate the last two handovers named is gone.
- **The canvas engage convention** is as the last handover left it: on
  `main`, unpushed, device-proven.

## 2. Decisions the owner should know about (all reversible)

1. **Live is the default edit mode on iOS** (`newTabMode: 'live'`,
   `defaultEditMode: 'live'`, `editorToolbar: 'always'` — `src/shim/
   settings.js`). The plan flagged this as the one to reverse before p1
   ran; the owner was asleep, so it stands as planned. A tab's mode is
   per vault in `workspace.json`, so a tab opened live on the iPad is
   live on the Mac next time (upstream's design). Three Settings rows
   undo it.
2. **The live frame cap is 8** (upstream 16). Memory on the device with
   a Diagrams-shaped note is the unmeasured number (plan §4.4): if the
   content process is killed, the cap comes down further or
   `liveRenderFences` goes off by default.
3. **Touch conventions in live mode: long-press is the source.** Tap on a
   concealed link follows; long-press on any concealed stand-in places
   the caret (⌥). Source mode keeps first-tap-places / second-tap-follows,
   now through `link-at.js`. The frame edge is a 24 px grip on iOS.
4. **Link hover previews and the selection bubble default OFF** on iOS
   (Settings turns either on; a trackpad reader may want previews).
5. **The shell panel is stubbed** — no PTY exists on iOS. Impossible,
   not deferred.
6. **The re-attach rebuild the plan budgeted was NOT needed** — measured
   (PORT-PLAN, WebKit findings): the frame layer is recreated by the
   renderer's own path when the editor DOM is re-adopted, so live frames
   never meet the stale-proxy case.
7. Earlier decisions stand: engines from the library's master build;
   note faces from CoreText; no engine-cache clearing; Documents/Plugins;
   Quick Look as "default app"; version numbering tangled (upstream's
   `package.json` now says 0.10.0, still untagged).

## 3. What the iPad has to confirm (the simulator cannot)

- A real tap on a concealed link in live mode synthesising the
  `mousedown` liveEvents wants (synthetic events did; WebKit's own tap
  path is the device's).
- The software keyboard shrinking `visualViewport.height` and the
  formatting popovers / preview pane staying above it (`popover.js` and
  `floating-pane.js` read the visual viewport now).
- **The preview pane at all**: it gates on `document.hasFocus()`, which a
  `simctl launch`ed page never has (WebKit finding) — a tap in the editor
  on the iPad gives it focus.
- A touch scroll starting on a block frame chaining to the editor's
  scroller (the configuration is right: block bodies `overflow: hidden`,
  no transformed ancestor).
- Memory with the frame cap at 8 on the Diagrams note; IME composition
  inside a concealed word and in a table cell; sidenotes in landscape
  (auto is correctly off in portrait — 826 px pane, 29 px margin; forced
  on works).
- The long-press grip on a frame edge feeling right at 24 px.

## 4. Open items

1. **Release the build to testers.** The cloud build archived; it does
   not join a tester group by itself. On
   https://appstoreconnect.apple.com/apps/6804827534/testflight/ios
   (sign in as j.mckenzie.alexander@mac.com, not the iCloud ID) pick the
   build of faa3023 under iOS Builds and add the Internal group — or,
   once, turn on the Internal group's "Enable automatic distribution" so
   every later cloud build goes out by itself. Processing took under an
   hour for the 0.11 build; this one is larger (the live-edit
   stylesheets, the opentype bundle). Then the device pass (§3), which
   now includes the fontnote check: the Diagrams note's last two figures
   and a 12pt document.
2. **citation-js in the worker** (§1, README): the one feature-shaped
   follow-up this sync surfaced. Bundle it through
   `src/worker/shims/require-registry.js`; measure the bundle size
   (citation-js + `@citation-js/plugin-csl` + the engine's CSL files).
3. **Device pass of §3**, plus the fontnote device check (the Diagrams
   note's last two figures, a 12pt document) on the first cloud build.
4. Upstream candidates from this sync are in PORT-PLAN: the boot path
   loading the vault-settings store, floaters reading the visual
   viewport, `Origin` parity, a package self-reference for the engine
   mirror, "long-press as ⌥" as a question, and the References panel
   not refreshing when the exclusion lists change.
5. TestFlight group / external testers / the manual's DNS — unchanged
   from the last handover.
6. Follow-ups seen, not requested: 44 pt explorer rows (none exist; the
   virtualised explorer measures a probe row so a rule is safe to add);
   `excalidraw`/`base`/`bibtex` in `VaultStore.swift`'s text set (the
   shim's `TEXT_EXT` has them); Swift-side pruning of `hidden` paths from
   the snapshot; a touch route to link previews; persisting frame
   heights across reopenings (upstream's own follow-on); canvas toolbar
   undo/redo; a THIRD-PARTY-NOTICES surface.
7. Deferred, unchanged: `\citefile`; native CJK font download; Xiaolai
   prune; ```kanban touch drag; "Move to folder…"; empty folders in the
   explorer; iCloud conflict surfacing; stale recents pruning; ZetaOffice.

## 5. Verification kit (works, use it)

- `npm test` — 675 green (`node --import ./tests/hooks/register.mjs
  --test`: the hook re-roots the one relative `vendor/jmarkdown` import
  upstream's renderer makes). `node tools/render-note.mjs <vault> <note>
  [--vault-options '<json>'] [--global-fragments '<json>']`.
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first**; read via `xcrun simctl spawn
  <sim> log show --start "<date>" --predicate 'eventMessage CONTAINS
  "CLEWJS"'`. FUNCTION BODY; `return` an async IIFE; **do not declare a
  `const` twice** (one SyntaxError costs a launch); `git commit -F file`.
  Sub-frames relay too, prefixed with their path — block documents as
  `[/s1/__clew_block__/<hash>]`.
- **The app container changes on every `simctl install`** but the vault
  in Documents survives an upgrade install; only `uninstall` wipes it.
  Re-read `get_app_container` after every install; write fixtures only
  then. A fixture written into the vault while the app runs is picked up
  by the 20 s rescan or the next launch.
- **Inside a preview document (block documents included)**: a vault
  script at `<vault>/.clew/scripts/probe.js` runs in every one —
  `document.documentElement.dataset.clewBlock === '1'` tells a block
  from a note. It is the only way to see inside a `clew-preview://`
  document; a `reveal-embed` deck iframe IS readable from there (same
  origin). `window.__clewFiguresPending()` counts unfinished figures.
- **Driving live edit**: `window.__clew` has `editorPool`,
  `workspaceStore`, `registry` (`runCommand`), `activeCellView(view)`,
  `previewPane()`, `linkPreview()`, `numbering`, `pdfAnnotations`,
  `vaultSettingsStore`, `settingsStore`. Reveal by dispatching a
  selection; type with `view.dispatch({changes, userEvent: 'input.type'})`
  (that is what triggers the `//` menu); accept a completion with a
  synthetic `keydown` Enter on `contentDOM`. **CodeMirror's own caret
  placement ignores a synthetic `mousedown`** — dispatch the selection
  to emulate the first tap. liveEvents' `mousedown` DOES respond to
  synthetic events (pointerdown + mousedown + click on the widget), and
  so does the port's long-press (pointerdown, 650 ms, pointerup).
  **`document.hasFocus()` is false in a simctl-launched page**, so the
  preview pane never shows here.
- **Block frames from the app page**: `fetch('clew-preview://vault/s1/
  __clew_block__', {method: 'POST', body: JSON.stringify({text,
  sourcePath})})` → `{hash}`; GET `…/__clew_block__/<hash>` → the
  document (text/html, `data-clew-block="1"`). Biblify formats citations
  client-side, so a fetched document's citation spans are empty — read
  them from the loaded frame (the vault probe), not from the HTML.
- **Sequencing**: Quick Look covering the app detaches the web view's
  window — a print issued while the sheet is up fails ("no window to
  print from"). Print first, or last with nothing covering the app.
- Screenshots, the canvas zoombar, fonts, `__clewNative`: as the last
  handover (`xcrun simctl io <sim> screenshot`, crop with PIL;
  `view.querySelector('[data-zoom=fit]').click()`; notefonts under
  Application Support; `__clewNative` = renderNote/renderFragment/
  renderBlock/blockDocument/externalDiff/flush/sessionId).

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run sync-mptikz`, `npm run build`, then `xcodebuild -project
ios/Clew.xcodeproj -scheme Clew -destination 'id=<sim>' -derivedDataPath
build/DerivedData build`. The sim used all session is
`90DCB612-1B85-4E1A-A17A-DBEB98F6C36D` (iPad Pro 11-inch M4, iOS 18.1).

**Twenty-two guarded patches** (`patched()` calls) in `scripts/build.js`,
all anchored at `ccf8dca`, plus one `onResolve` (the engine-mirror
relative import) and one alias (`@xterm/*` → `src/shim/xterm-stub.js`).
New this sync: `builtin.js` (drop `shell:toggle`), `renderer/main.js`
(await `vaultSettingsStore.load()` on the boot branch),
`toolbar/popover.js` and `chrome/floating-pane.js` ×2 (visual viewport).
`patched()` throws on a missed anchor, so a stale patch fails the build
rather than silently reverting a fix.

`SchemeHandler.swift` gained the two `__clew_block__` routes and an
`Origin` guard on both POSTs; no new Swift files (nothing to add to
`project.pbxproj`). `sync-upstream` regenerates `AppIcon.png`
non-deterministically — `git checkout --` it. npm deps did NOT change
(the two xterm packages are stubbed, not installed).
