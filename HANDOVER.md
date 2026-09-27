# Handover — 2026-09-27 (the canvas work is device-proven; upstream has run 77 commits ahead)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8/0.9/0.10/0.11-PLAN.md`
are **history**: executed in full; read them for the reasoning behind a
decision.

The port's last change was 2026-09-18; this is written on 09-27, and the
gap is all upstream's (§3).

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. A docs-only commit carries `[ci skip]` in its message so a push of
it spends no cloud build. (Also in Claude's memory.)

## 1. Where things stand

Two layers, from the bottom (the fontnote and canvas branches were
fast-forwarded into `main` on 2026-09-27, owner's instruction):

```
origin/main = e46a5ce   the 0.11 sync — TestFlight 0.1.0 (6), on the owner's iPad
 main = 6a5d521 + this plan's docs commit                 ← TIP, local
   (carries fontnote-p1…p3 and canvas-engage-touch, both still as branches)
```

17 commits sit unpushed. Working tree clean, tests **392 green**.
**`UPSTREAM-LIVE-EDIT-PLAN.md` is written and unexecuted** — the next
session starts at its §3 `live-p1-vendor`, chained off `main`.

- **The 0.11 sync** (pushed, released): wasm figures in the bundle,
  embeds that fold/refresh, Quick Look for `|external`, global plugins in
  Documents/Plugins, the reading-view PDF, `alert()` and the iPad share
  sheet. Build 6 had to be added to the Internal group by hand.
- **`font=note`** (`fontnote-p1…p3`, unpushed): vendor at 4eae005;
  engines restaged from the mp-tikz-wasm master build (the `opentype`
  bundle, 72 Latin Modern faces, 3,891 files); `NoteFonts.swift` builds
  the four Avenir Next faces from CoreText and serves them under
  `__clew_assets__/notefonts/`. Simulator-verified; **not yet on a
  device, because no TestFlight build can carry it** (§2.1).
- **The canvas engage convention** (`canvas-engage-touch`, unpushed,
  this session, **all three device-confirmed by the owner**):
  - `7d7fc49` — one tap selects, a double tap engages, a tap outside
    returns to the canvas, for every node type. Replaces an iOS-only
    shim that engaged `<video>`/`<iframe>`/`<embed>` nodes on a SINGLE
    tap, which armed exactly the interesting nodes on the tap that
    selected them and left the reader guessing where a tap would land.
    Engaged now has its own border colour plus an inset hairline (a
    green-coloured node would otherwise look identical), and loses its
    resize handles and connection anchors.
  - `f89b035` — an un-engaged node carries an `::after` shield, because
    `pointer-events: none` does not stop a drag reaching an iframe's
    scroller; and an engaged note embed is asked to scroll its body
    rather than its document, because a subframe's root scroller is
    unreachable by touch under `.canvas-world`'s transform. Both WebKit
    facts are written up in PORT-PLAN's WebKit findings.
  - `d2ad1bb` — a framed embed's title bar is a flex row above the frame
    (`order: -1`), not an absolute strip across it; it had been sitting
    on EmbedPDF's toolbar, because an engaged node is always selected.

## 2. Decisions the owner should know about (all reversible)

1. **Engines come from the library's master build, not the pinned
   release** (`scripts/stage-mptikz.js` order: `MPTIKZ_SRC`,
   `~/Source/mp-tikz-wasm/dist`, `../Clew-app/mptikz-assets`, the pinned
   release). `mptikz-assets/STAGED.json` says `copy` from that dist,
   staged 2026-09-17, and the `opentype` bundle is in it. **Xcode Cloud
   can only fetch the pinned release, and mp-tikz-wasm still has no tag
   past v0.2.1, so a TestFlight build from this tip refuses font=note
   figures by name** — honestly, in their own place; everything else
   typesets. Publishing 0.3.0 is the owner's call and is the whole gate.
2. **The note's faces come from CoreText, never from Apple's font file**
   (PORT-PLAN Decisions). One sfnt per face, cached in Application
   Support keyed on the iOS version, built on first use.
3. **No engine-cache clearing on iOS** (desktop needed `asset-stamp.js`):
   measured twice. Revisit only if a restaged engine misbehaves after an
   app update; the fix would be `WKWebsiteDataStore` removal on a
   bundle-identity change.
4. The 0.11 decisions stand: engines in the bundle (~+70 MB on the
   listing); Documents/Plugins; Quick Look as "default app"; the
   reading-view PDF to the share sheet, Avenir Next subset and all.
5. **Version numbering** is now genuinely tangled and is the owner's
   call: upstream's tags stop at **v0.9.0** while its `package.json`
   already says **0.10.0** (untagged), the port's own sync labels
   "0.10"/"0.11" mean something else entirely, and the app ships
   `MARKETING_VERSION` 0.1.0 with Xcode Cloud's build counter. Future
   rounds could be named by date.

## 3. Upstream state (2026-09-27) — read this before planning

- `../Clew-app` main = **ccf8dca**, clean. We vendor **4eae005**:
  **77 commits behind**, and the bulk of them are one feature.
  - **Live edit** (`254c198`, merged from `feat/live-edit`): a THIRD
    view mode where constructs conceal and render in place — an editor
    toolbar, a `//` menu at the cursor, tables edited in place, link
    hover previews, a live preview pane for maths and diagrams,
    cross-reference numbering as you type, citations as objects with a
    library and a graph, PDF annotations back into a note, and sidenotes
    in the margin. This is the next sync's real work, and it is heavily
    **interaction**-shaped, which is exactly where iOS diverges.
  - `90a4d95` **Inline footnotes keep their face across a paragraph
    break** — the change the Clew-app session messaged us about on
    09-18. The analysis then: nothing for us to do, because
    `sync-upstream` copies all of `src/renderer` (so the new
    `footnote-parser.js` arrives on its own), `styles/` is copied
    verbatim, and no patch touches `editor.js`. **That analysis was made
    at 4eae005 and live edit has since rewritten `editor.js` nine
    times — re-check it rather than trusting it.**
  - Also: 0.10.0 itself, a shell panel, vault exclusion lists, a
    virtualised file explorer, `@reveal[…]`, TeX fragments, description
    lists, headerless tables.
- **Patched-file churn since 4eae005**, i.e. where the next sync will
  fight. `patched()` throws on a missed anchor, so the build will tell
  you — but budget for it:

  | file | upstream commits |
  |---|---|
  | `clew-settings-view.js` | 10 |
  | `editor.js` (not patched; carries the footnote parser) | 9 |
  | `clew-preview-view.js` | 7 |
  | `clew-editor-view.js` | 4 |
  | `preview-client/client.js` | 4 |
  | `clew-file-explorer.js` | 2 |
  | `clew-file-view.js`, `pdf-core.js` | 1 each |
  | `clew-canvas-view.js`, `node-content.js`, `tab-drag.js` | **0** |

  The five canvas patches and this session's work are therefore safe;
  the settings, preview and editor patches are the ones to re-anchor.
- `../Clew-docs` main = **eff4e7f**, with `HANDOVER.md`, `Makefile` and
  `README.md` **uncommitted**, and the repo **has no remote**. It now
  carries the live-edit manual. Still not deployed — the domains point
  at GoDaddy parking; `make sync` waits on the DNS change and the
  provision/tls sequence in that repo's handover.
- `~/Source/mp-tikz-wasm` on branch `opentype-fonts` at **93a144b**
  (moved since the 1dea1b8 our engines were staged from — a
  `npm run sync-mptikz` will restage if its mtimes changed). **Still no
  release past v0.2.1.**

## 4. Open items

1. **Push, the owner's call** (`main` is merged, §1). Pushing now
   releases the 0.11 build plus the 4eae005 vendor drop and the canvas
   work, with font=note refused by name (§2.1); waiting for the 0.3.0 pin
   gives one release with the fonts. The canvas fixes are device-proven
   and are the strongest reason to ship something.
2. **The live-edit sync** — planned in `UPSTREAM-LIVE-EDIT-PLAN.md`
   (2026-09-27): five phases `live-p1-vendor` → `p5-verify`, twelve
   decisions (§2), eleven seam questions (§4). Findings that shaped it:
   **all 17 patch anchors still match at `ccf8dca`** (the churn table
   below was a false alarm); the build BREAKS on `@xterm/*` imports
   without the stub alias; `FS_RENAME` THROWS without `vaults.excludes`;
   the iOS boot path never loads the renderer's vault-settings store
   (grammar and live config would run on `{}`); block frames must be
   rebuilt when the editor DOM is re-attached (the WebKit stale-proxy
   case). §2.11 — live as the default edit mode on iOS — is the decision
   the owner may want to reverse before p1 runs.
3. **Device check of font=note** once a build carries the bundle: the
   Diagrams note's last two figures, and a 12pt document. Memory on the
   iPad is the unmeasured number (luaotfload scans 72 faces on the first
   OpenType figure, ~7 MB through the scheme handler).
4. **TestFlight group**: turn on the Internal group's automatic
   distribution, or keep adding builds by hand (memory:
   clew-ios-release-pipeline). External testers need an external group,
   Test Information incl. a privacy-policy URL, Beta App Review once,
   then the public link — and the landing-page sentence to replace.
5. Manual: deploy is gated on DNS (§3); the docs repo also wants a
   remote and has three files uncommitted.
6. Follow-ups seen, not requested: canvas toolbar undo/redo; Pencil
   long-press → contextmenu; "New drawing" in the explorer root menu; a
   THIRD-PARTY-NOTICES surface (now also mp-tikz-wasm's TeX bundles and
   the Latin Modern faces); a prebuilt luaotfload name database in the
   bundle. Upstream candidates from this session are in PORT-PLAN: an
   engaged canvas node should draw neither resize handles nor connection
   anchors, and engaged should not look like selected.
7. Deferred, unchanged: `\citefile`; native CJK font download; Xiaolai
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
  `git commit -F file`. Sub-frames relay too, prefixed with their path:
  `CLEWJS warn [/s1/Welcome.md.html] …`, so grep for the message, not
  for `[/index.html]`.
- **The app container changes on every `simctl install`.** A vault
  script written into the old container silently never runs — this cost
  two rounds this session. Always re-read `xcrun simctl
  get_app_container <sim> org.jmckalex.clew.ios data` after installing,
  and write fixtures only then.
- **Inside a preview document**: a vault script at
  `<vault>/.clew/scripts/probe.js` (injected by
  `SchemeHandler.swift#injectClientScripts` into every preview, no
  manifest) that `console.warn('PROBE …')`s; re-arm on
  `document.addEventListener('clew:render', …)`. It is the only way to
  see inside a `clew-preview://` document — cross-origin keeps
  `contentDocument` shut from the app page.
- **Driving touch**: synthetic `PointerEvent`s with `pointerType:
  'touch'` plus a `MouseEvent('click')` exercise the app's own pointer
  code (selection, engage, drags) — `ios-ui.js` reads `lastPointerType`
  from a real `pointerdown`, so dispatch that first. **They do NOT drive
  native scrolling**, so a scroll gesture cannot be tested here at all;
  assert the *configuration* instead (which scroller overflows, what
  `touch-action`/`overflow` compute to) and let the iPad confirm.
- `document.elementFromPoint(x, y)` is the way to prove an overlay: over
  an un-engaged canvas node it must return the node, over an engaged one
  the iframe.
- Screenshots: `xcrun simctl io <sim> screenshot x.png`. The image is
  1668×2420 for a 1379-CSS-px-wide screen, so scale by `im.width/1379`
  to crop by a `getBoundingClientRect()`. **Crop with PIL** (available)
  and upscale with LANCZOS — `sips` crops from the CENTRE and fights
  you. Re-measure the rect in the SAME run as the screenshot; the canvas
  camera moves between runs, and a stale rect crops the sidebar.
- The canvas zoombar is scriptable:
  `view.querySelector('[data-zoom=fit]').click()` (also
  `in`/`out`/`reset`); `fit` on the demo canvas lands near 10%, so zoom
  in before expecting to read anything.
- Fonts: the device's faces land in `<container>/Library/Application
  Support/notefonts/<iOS>/`. The Swift sfnt writer's pure functions
  compile on the Mac (`xcrun swiftc`); `cmp` against
  `../Clew-app/src/main/note-fonts.js#extractFace` on the system .ttc.
  Upstream's `smoke/make-figures-vault.mjs <dir>` writes Fonts.md, and
  `smoke/make-global-plugin.mjs <dir>` a three-surface plugin fixture.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry/officeDock; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId. Same-path tabs
  are REUSED and `openWikilink` navigates the active tab.
  `workspaceStore.openCanvas(path, { newTab: true })` opens a canvas.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run sync-mptikz` (source order in §2.1; the stamp tracks the
engines' and `bundles/index.json`'s mtimes so a library rebuild restages
by itself; `--force` if in doubt), `npm run build`, then `xcodebuild
-project ios/Clew.xcodeproj -scheme Clew -destination 'id=<sim>'
-derivedDataPath build/DerivedData build`. The sim used all session is
`90DCB612-1B85-4E1A-A17A-DBEB98F6C36D` (iPad Pro 11-inch M4, iOS 18.1).
A missing `mptikz-assets/` is a build warning here and a refusal in CI
(`ci_post_clone.sh` runs `stage-mptikz --require`, which on a clean clone
downloads the pinned release).

**Seventeen guarded patches** in `scripts/build.js`, all anchors last
re-checked at 4eae005 — see §3 for which files have moved since. Five
are on `clew-canvas-view.js` (the office menu, plus this session's four:
handles and anchors gated on `#engagedId`, and `#engage`/`#disengage`
calling `#syncOverlay` so the overlay redraws). `patched()` throws on a
missed anchor, so a stale patch fails the build rather than silently
reverting a fix.

**Three iOS preview modules** in `src/preview/` are appended to the
preview bundles by `build.js`, sharing their module scope: `pdf-touch.js`
(both bundles), `pdf-scene-embeds.js` and `embed-scroll.js` (client.js
only). Prefix their globals with `clew` — it is one scope.

New Swift files go into `project.pbxproj` by hand (four entries,
`C1E…/C1F…` ids — `NoteFonts.swift` is `…AD`). `sync-upstream`
regenerates `AppIcon.png` non-deterministically — `git checkout --` it;
it excludes `.clew/history` from the seed. npm deps do NOT auto-merge
(none changed since 0.10).
