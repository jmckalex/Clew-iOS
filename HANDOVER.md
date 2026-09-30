# Handover — 2026-09-30 (sync #2 live; the PDF Swift half on a branch)

**LATEST (2026-09-30, afternoon):**
- **Sync #2 is LIVE**: origin/main = `09ce3f2` (vendor at Clew-app
  `cd8c311`), pushed on the owner's decision via Clew-boss; its Xcode
  Cloud build SUCCEEDED (https://github.com/jmckalex/Clew-iOS/runs/109954480606).
  Record: `UPSTREAM-CD8C311-PLAN.md`.
- **PDF unification, Swift half — branch `pdf-native-p1` (65d2708), NOT
  pushed, must merge WITH the next sync** (Clew-app
  `docs/dev/pdf-unification.md`, owner-approved): native fetcher
  (Network.framework, pinned + SNI to the original host, the address guard,
  https only, 50 MB), device cache in Library/Caches, the
  `__clew_remote_pdf__/<hash>` route, bridge methods, Quick Look PDF thumbs,
  the navigation-response PDF leak check (makes a note's own `<iframe
  src=x.pdf>` go blank until the shared rewrite lands — hence "with the
  sync"), and subframes no longer load clew-app:// (frame-bridge §2.7).
  `npm run test:swift` — 140 defensive tests (fakes only, never a network).
- **Measured**: WebKit honours a CSP on WKURLSchemeHandler responses, the
  <meta> tag AND the response header (`script-src 'none'` blocked inline
  and external scripts) — frame-bridge §4.4 is enforceable on iOS.
- **Security finding sent to Clew-boss/Clew-app**: a note's metadata
  header (`Load javascript` → runInThisContext; `Load extensions` /
  `Load environments` → dynamic import) runs vault code at RENDER time —
  Node on desktop. To be gated engine-side in restricted vaults (§4).
- **NEXT SYNC also carries the note-code guard (owner-approved; ordered
  under the standing rule):** Clew-app adds ONE engine switch in the
  jmarkdown master ("Run note code"-style, default = today) that every
  note-code path honours, refusing BY NAME when off (the Load
  javascript/extensions/directives/environments keys and `Extension …`
  keys, function and script blocks, inline function expressions, mathjs,
  Mathematica). The INTERIM guard: a vault this device already knows stays
  trusted silently; a first-time vault gets the switch OFF in the generated
  config, with a "Trust this vault" banner once something is refused;
  trust on the device, keyed by frame-bridge §4.3's identity, revocable.
  iOS parity at the sync: `src/shim/engine-config.js` sets the switch; the
  trust store is a native JSON in Application Support over the bridge (no
  absolute paths: container-relative for Documents vaults, the bookmark's
  provider-relative path for Files vaults); "already known" = the union of
  `settings.recentVaults`, the `vaultBookmarks` bookmarks and the vaults
  in Documents. Exact shapes come from Clew-app.

**NOW (2026-09-30, overnight):** the upstream 0.11.1 sync ran p1 → p4 on
`sync111-p1-vendor … sync111-p4-verify` — vendor at Clew-app `84f975e`
(local there), the caller token on iOS, the scene-PDF relay guard,
RENDER_HTML. Every check in `UPSTREAM-0.11.1-PLAN.md` passed in the
simulator (its STATUS line has the results and what the simulator could
not prove); 680 tests. **Pushed** on the owner's decision relayed by
Clew-boss ("push overnight if ALL checks pass"): origin/main = `e79b158`,
and its Xcode Cloud build SUCCEEDED (23:11–23:19 UTC,
https://github.com/jmckalex/Clew-iOS/runs/109664532923). The owner adds it
to TestFlight Internal, then tries the four iPad-only checks (the plan's
STATUS line). Sections below that describe the live-edit sync are its
history; §4.5 and §5–§6 are current.

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

**Never `git push` without the owner's decision** — given here, or
relayed by the coordinating session Clew-boss. (Owner's standing rule,
2026-09-29: Clew-boss's instructions on syncs, which Clew-app commit to
port, and other iOS work are the owner's; pushes stay the owner's
decision, which Clew-boss may relay; design questions go to the owner.) The Xcode Cloud workflow builds and ships to TestFlight on
every push to `main` — a push IS a release. Commit locally freely. A
docs-only commit carries `[ci skip]` in its message so a push of it
spends no cloud build — and the marker works ANYWHERE in the message,
body included: a commit meant to build must never quote it (fbb56f4 did,
and sat unbuilt; 7a34dd3, an empty marker-free commit, built). A real
build shows a "Clew | Default | Archive - iOS" check run on the commit
within seconds (`gh api repos/jmckalex/Clew-iOS/commits/<sha>/check-runs`).
(Also in Claude's memory.)

## 1. Where things stand

```
origin/main = main              PUSHED 2026-09-29 (evening) — faa3023 + the bridge fix + citation-js, merged
   fix-bridge-main-frame 8ceb533  the native bridge answers the app page only (security)
   citation-js-worker    3771169  citations render in reading mode; CSL files staged
faa3023                           PUSHED 2026-09-29 — the 0.11 sync + fontnote + canvas engage + live edit + the 0.3.0 pin
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
canvas engage work. **It must NOT go to testers**: it has the native
bridge hole (any iframe in a note could call the Swift file bridge).
Both fixes were merged into `main`, checked together in the simulator
(the bridge refuses a note document and a sandboxed frame, the app page
still answers; `Features/Citations.md` shows 6/6 cites and a 3-entry
bibliography in reading mode) and pushed on 2026-09-29 on the owner's
instruction relayed by Clew-boss. That cloud build is the one for
TestFlight Internal (§4.1). Tests **677 green**.

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
  (they read the `.bib` files directly). **Fixed and pushed** (§4.2).
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
   build of the merged tip (NOT faa3023 — it has the bridge hole) under
   iOS Builds and add the Internal group — or,
   once, turn on the Internal group's "Enable automatic distribution" so
   every later cloud build goes out by itself. Processing took under an
   hour for the 0.11 build; this one is larger (the live-edit
   stylesheets, the opentype bundle). Then the device pass (§3), which
   now includes the fontnote check: the Diagrams note's last two figures
   and a 12pt document.
2. **citation-js in the worker — DONE, merged and pushed.** The require registry carries `@citation-js/core`
   + the BibTeX and CSL plugins (+694 KB minified / +168 KB gzip on a
   2.99 MB worker; the umbrella package would be +1.9 MB, 1.1 MB of it
   Wikidata tables Biblify never touches — output identical in all 8
   named styles on the demo `refs.bib`). The engine's five CSL files are
   staged to `/engine/csl/` (`ENGINE_CSL_FILES`). Worker spawn→ready
   on the simulator ~157 → ~191 ms, paid by the pre-spawned standby.
   Eager, not lazy: see the commit message. Simulator: all six cites and
   the Chicago bibliography in `Features/Citations.md` render in reading
   mode; live chips unchanged; a live block frame resolves cites when the
   vault has a bibliography. Needs its device check with the next build.
3. **Device pass of §3**, plus the fontnote device check (the Diagrams
   note's last two figures, a 12pt document) on the first cloud build.
4. Upstream candidates are in PORT-PLAN, now with Clew-app's verdicts
   (reviewed at `e88aff6` on 2026-09-29, relayed by the coordinating
   session `Clew-boss` in `~/Source/Clew`): nothing landed yet; most are
   agreed and wait on the owner; the `Origin`-parity item was wrong and
   is withdrawn; the References-panel item is probably not a gap (the
   shim runs desktop's event chain) — one simulator check at the next
   sync. The coordinator says it will announce each landing with the
   patch it retires.
   **Next sync — the build breaks there, by design.** Clew-app
   `e88aff6..fc2c79f` (on its local main, unpushed — `sync-upstream`
   reads `../Clew-app`, so it takes them anyway) landed the quick-fix
   round. `patched()` will throw on: `clew-canvas-view.js` patches 2 and
   4 (drop 3 too — it still matches but would redraw twice; keep patch
   1, the office Live choice) — `45dffd7`; `toolbar/popover.js` and
   `chrome/floating-pane.js` ×2 — `43cc4e7`. And `89a6bb0` needs
   `"imports": { "#jmarkdown/*": "./vendor/jmarkdown/src/*" }` in this
   `package.json` in the same sync, which makes the `onResolve` re-root
   and `tests/hooks/vendor-jmarkdown.mjs` dead. Retired without
   breaking: the `renderer/main.js` settings-load patch and `ios-ui.js`'s
   Welcome copy (`9b97ff9` — drop both, check for no second Welcome
   tab); the shim's own `dataviewJs` reconfigure (`055d46b`); the
   history services test can assert order again (`0d17da7`). Then
   `fc2c79f..6c63132` (0.11.1, and `7a0cb6f`: an unused bare Esc in a
   preview posts `{type:'escape'}` and the canvas disengages the card
   that sent it) breaks nothing — the `client.js` `ready` anchor and
   canvas patch 1's anchor are each still unique at `6c63132`
   (checked). Verify phase: a hardware-keyboard Esc on the iPad leaves an
   engaged note card. Then `6c63132..1956d89` (`1956d89`: PDF
   annotations survive their viewer going — viewers report `pdf-dirty`
   and save on `pdf-flush`; the new `renderer/pdf-frames.js#retire`
   keeps an outgoing view `display:none` until clean, 10 s cap, used by
   the tab-group body swap, the live frame layer and canvas card
   removal; `pdf-embed.js#holdIfUnsaved`; a 3 s close guard; a window
   close handshake in `office-dock.js`) breaks nothing — the `pdf-core`
   "Spike instrumentation", `client.js` `ready`, `builtin.js`
   `shell:toggle` and canvas patch 1 anchors are each still unique at
   `1956d89` (checked). Verify phase, on WebKit: (a) a `display:none`
   iframe stays loaded AND keeps running timers/wasm, so the retire path
   can finish a save (tab switch, embed switch, live frame, canvas card);
   (b) backgrounding mid-annotation saves. Suspected gap for (b): iOS has
   no window-close handshake, and the Swift side (`ClewApp.swift`
   scenePhase → `flushEditors`; `install-shim.js` visibilitychange) never
   takes a `beginBackgroundTask`, so a slow PDF save may be cut off by
   suspension — measure, and if so wrap the background transition in a
   background task until the web side reports flushed. Then
   `1956d89..c386829` (the two-row live-edit toolbar) touches no anchor,
   but **`src/ios/styles/ios.css` must change in the same sync**: drop
   `body.is-ios .editor-toolbar { height: 44px }` (it outranks the new
   rows × `--toolbar-row` height and clips row 2) and set
   `--toolbar-row: 44px` instead; button sizes stay ours. The bar drops
   to one row plus … while `visualViewport.height` <
   `--toolbar-two-row-min-height` (560 px default, tunable in ios.css) —
   measure on the simulator: Clew-app expects landscape with the keyboard
   up (~450 pt) to get one row and portrait to keep two. Then
   `c386829..83532b2` (menu chords, main only; the live preview pane
   passes a wheel it cannot use to the note, and a 12 px sizing fix)
   touches no anchor. **iPad gap it leaves, and the plan:** the pane is
   fixed, outside the editor's scroller, so a finger drag that starts on
   it scrolls nothing (the wheel handler does not cover touch; WebKit
   chains a touch scroll up the DOM, and the pane's ancestors are not
   the scroller). Neither forwarding touchmove (inertia by hand) nor a
   blanket `pointer-events: none` (a tall diagram could not scroll): under
   `(pointer: coarse)` the pane takes no pointer events UNLESS its content
   overflows — drags fall through to the note with native inertia, a tap
   lands on the text the pane mirrors, a tall diagram keeps its own
   scroll. Needs `data-overflows` on the pane where `preview-pane.js`
   sets the body height (l.221 at `83532b2`: `h + padding > MAX_H`;
   cleared where the height is, l.195) — LANDED upstream as `f47080b` (Clew-app
   main), measured true/false/true in its preview-pane-wheel scenario; a build patch
   there otherwise — plus one ios.css rule. Measure on the simulator:
   a drag over a fitting pane scrolls the note; a tall diagram scrolls
   in the pane. Then `707ed87`: a live block frame renders under its
   note's citation keys — `shared/citation-keys.js` reads the engine's 8
   citation keys from a note's header, `main/citation-header.js` makes a
   fenced header (bibliography path absolute), desktop's
   `render-service.renderBlock` prepends it, `frame-layer.js` re-renders
   frames when a save changes the keys. **At the sync, the iOS block
   render path (`src/shim/render-service.js#renderBlock`) must prepend
   `citationHeader(noteText, noteDir)` the same way**
   (`citation-header.js` needs only `node:path`, already aliased). The
   full notices and the candidate numbering are in
   `~/Source/Clew/SYNC-LEDGER.md` (the coordinator's ledger).
   Both fix branches (`fix-bridge-main-frame`, `citation-js-worker`)
   are merged into `main` and pushed.
5. **Protocol caller token (design, with Clew-app).** Desktop hardened
   its protocol (random session ids `b561983`; cross-origin reads only
   for clew-preview://vault and null `3575f24`). Refusing `Origin: null`
   on the render POSTs could not work there (no desktop render POST
   carries an Origin), so the owner chose a per-session token the app
   page gets over IPC and hands to preview documents, required on the
   render POSTs, enforced the same way on both platforms. Clew-app sends
   the proposal; iOS reviews it for WebKit (sandboxed frames send
   `Origin: null`, measured) and the scheme handler. Building iOS's side
   and parity (random ids, narrower ACAO in `SchemeHandler.swift`) waits
   on the owner's direct approval. **Measured 2026-09-29** (a throwaway
   build, reverted): WebKit sends `Origin: clew-app://app` from the app
   page, NO Origin on a same-origin preview document's render POST (the
   canvas scene's cards), `clew-preview://vault` on preview documents'
   CORS-mode GETs, `null` from a sandboxed frame. ACAO narrowed to
   `clew-app://app` on both schemes broke no consumer (Diagrams, maps,
   EmbedPDF, Excalidraw, canvas scene, MathJax, media, charts, live
   block frames) and blocked every null-frame read — but a null frame's
   POST still ran the engine (CORS blocks the reader, not the request),
   so the token check is needed here too. **AGREED with Clew-app
   (2026-09-29; `Clew-app/docs/dev/frame-bridge.md` §1):** never in the
   served HTML — a client asks its parent lazily on its first POST
   (retrying ~1 s, bounded, failing visibly: WebKit's stale-proxy bug
   drops postMessage), the app page answers only its own child frames
   (`event.origin === 'clew-preview://vault'`,
   `event.source.parent === window`; targetOrigin
   `clew-preview://vault`), nested cards relay by the same rule, a
   top-level document (iOS: the Export-as-PDF view) gets a self-post;
   JSON body `{token, text, sourcePath}` with NO Content-Type; 403 before
   the engine; sid + token random per vault open. **iOS work, awaiting
   the owner's approval:** SchemeHandler token check + Origin layer
   (refuse null/http(s) on the POSTs) + ACAO echo for `clew-app://app`
   with `Vary: Origin` on both schemes; random sid (not "s1") + token in
   Swift, to the app page via VAULT_CURRENT; the token self-post in
   PrintPDF; the shared client half arrives with a sync (Clew-boss has
   suggested to the owner folding the iOS half into the next sync).
   **Desktop built it: Clew-app `6cbe0d8`.** ⚠ Its shared files change
   behaviour — syncing them WITHOUT the native half breaks canvas cards
   and block frames on iOS, so the iOS half is part of that sync. The
   shapes to match (from Clew-app, exact):
   (1) VAULT_CURRENT's vault object carries `callerToken` (64 hex)
   beside `sessionId` (`showVault` strips it before vaultStore) — the
   shim's VAULT_CURRENT answer gets it from native;
   (2) render POST bodies are JSON text, NO Content-Type:
   `__clew_fragment__` `{token, text}` (was raw text), `__clew_block__`
   `{token, text, sourcePath}`; desktop's order
   (`main/caller-token.js#readRenderBody`): body > 100,000 chars → 413;
   not JSON / not an object → 400; token mismatch → 403 (constant-time);
   `text` not a string, or `sourcePath` neither null nor a string → 400 —
   mirror it in `SchemeHandler.swift`, plus iOS's own Origin layer;
   (3) handshake (`shared/caller-token.js`): ask
   `{source:'clew-preview', type:'caller-token'}` to window.parent with
   '*'; answer `{source:'clew-preview-host', type:'caller-token', token}`
   with targetOrigin `clew-preview://vault`, only when
   `event.origin === 'clew-preview://vault'` and
   `event.source.parent === window`; believed only from window.parent;
   retry 1 s × 5 then fail (canvas cards keep the instant render + a
   warn), re-ask on pageshow;
   (4) print: evaluate
   `window.postMessage({ source: 'clew-preview-host', type: 'caller-token', token }, 'clew-preview://vault')`
   in the Export-as-PDF view beside the light-theme script, right after
   load; (5) reuse `tests/caller-token.test.js` and
   `smoke/caller-token-scenario.js` — the scenario counts
   `.callout-title` in canvas cards (the instant renderer cannot draw a
   callout), so an engine-rendered card proves the token arrived.
   **Owner's decision (2026-09-29):** no desktop measurement of
   null-origin reads; desktop closes that gap by design, moving its app
   page to its own `clew-app://` origin (option (c)). That becomes the
   first section of the frame-bridge design, worked out with iOS next —
   bring what `clew-app://` taught here: CSP, the storage origin, print,
   the navigation guards (`WebHost.swift` decidePolicyFor).
6. TestFlight group / external testers / the manual's DNS — unchanged
   from the last handover.
7. Follow-ups seen, not requested: 44 pt explorer rows (none exist; the
   virtualised explorer measures a probe row so a rule is safe to add);
   `excalidraw`/`base`/`bibtex` in `VaultStore.swift`'s text set (the
   shim's `TEXT_EXT` has them); Swift-side pruning of `hidden` paths from
   the snapshot; a touch route to link previews; persisting frame
   heights across reopenings (upstream's own follow-on); canvas toolbar
   undo/redo; a THIRD-PARTY-NOTICES surface.
8. Deferred, unchanged: `\citefile`; native CJK font download; Xiaolai
   prune; ```kanban touch drag; "Move to folder…"; empty folders in the
   explorer; iCloud conflict surfacing; stale recents pruning; ZetaOffice.

## 5. Verification kit (works, use it)

- `npm test` — 680 green, plain `node --test` (the engine is reached as
  `#jmarkdown/*` through package.json's `imports`; the old resolver hook
  is gone). `node tools/render-note.mjs <vault> <note>
  [--vault-options '<json>'] [--global-fragments '<json>']`.
- **The session is random now** (`s` + 32 hex, per vault open): read it
  from `__clewNative.sessionId`, never write `s1` — an unknown sid is a
  404. The render POSTs need the caller token: JSON body
  `{token, text[, sourcePath]}`, NO Content-Type, token from
  `__clewShim.services.vaults.callerToken`. Cross-origin reads answer only
  `clew-app://app`, so a sandboxed probe frame reads nothing.
- Open a `.canvas` with `workspaceStore.openCanvas(path)` (`openFile`
  gives a plain file tab). The Export-as-PDF web view has no console
  forwarder: check it through the PDF (`tmp/<name>.pdf`, `pdftotext`).
  `message` listeners from the smoke hook never fire — a page script in
  `dist/webroot` (scratch, gitignored) can log; remove it after.
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first**; read via `xcrun simctl spawn
  <sim> log show --start "<date>" --predicate 'eventMessage CONTAINS
  "CLEWJS"'`. FUNCTION BODY; `return` an async IIFE; **do not declare a
  `const` twice** (one SyntaxError costs a launch); `git commit -F file`.
  Sub-frames relay too, prefixed with their path — block documents as
  `[/<sid>/__clew_block__/<hash>]`.
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
- **Block frames from the app page**: `fetch('clew-preview://vault/<sid>/
  __clew_block__', {method: 'POST', body: JSON.stringify({token, text,
  sourcePath})})` → `{hash}`; GET `…/__clew_block__/<hash>` → the
  document (text/html, `data-clew-block="1"`). Citations are formatted
  at compile time, so the fetched HTML carries them, and since 707ed87 a
  block renders under its note's citation header (renderBlock prepends
  it). Before that a block never saw its note's `Bibliography:` header
  (a block renders from its own text, desktop too), so a header-only
  bibliography leaves a block's cites unresolved.
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

**Fourteen guarded patches** (`patched()` calls) in `scripts/build.js`,
all matching at Clew-app `84f975e`, plus one alias (`@xterm/*` →
`src/shim/xterm-stub.js`). The 0.11.1 sync retired eight (canvas-view
2–4, `renderer/main.js`, `toolbar/popover.js`, `chrome/floating-pane.js`
×2) and the `onResolve` re-root — upstream absorbed each. Clew-app
`f1816ae` (the stuck-preview watchdog, next sync) retires three more: the
`client.js` pageshow patch, the `clew-preview-view` 2.5 s rebuild and its
`__iosSubscribed` guard — confirm then that nothing of ours calls
render() repeatedly. Clew-app `12b1734` (local) upstreams the Pencil
convention and the viewer handles (`preview-client/pdf-handles.js`,
`pdf-pen.js`, imported by pdf-core so it rides both the client.js and
pdf-page.js bundles; hook names kept, `__clewPdfTouch`): it retires the
pdf-core handle patch and the `pdf-touch.js` appends into client.js and
pdf-page.js. `pdf-scene-embeds.js` and `embed-scroll.js` stay ours — but
upstream's item 15 (canvas scene PDFs, coming) will change the scene
relay's ground — and it did: Clew-app `71180c6` (local) routes canvas-scene
PDFs through upstream's pdf-page.html (pdf-core posts saves and dirty
reports to `window.top`; pdf-frames finds a dirty viewer at any depth and
asks it to flush; pdf-page answers the app page as well as its parent;
every sender stays on the preview origin, inside 2e45098's checks). It
RETIRES `src/preview/pdf-scene-embeds.js` whole, relay and tonight's guard
with it. At the sync, verify on WebKit that a scene viewer two frames deep
saves AND flushes (desktop's measure: pdf-scene-scenario), and that
nothing else of ours relays PDF messages. It also touches
`clew-preview-view.js`, where our rebuild patch lives until f1816ae
retires it. The next sync's range starts at `84f975e`. The manual
now describes the pen convention (Clew-docs d215c8d); an "On iPad"
sentence there must be measured first and go via Clew-boss.
`patched()` throws on a missed anchor, so a stale patch fails the build
rather than silently reverting a fix.

`SchemeHandler.swift` gained the two `__clew_block__` routes and an
`Origin` guard on both POSTs; no new Swift files (nothing to add to
`project.pbxproj`). `sync-upstream` regenerates `AppIcon.png`
non-deterministically — `git checkout --` it. npm deps did NOT change
(the two xterm packages are stubbed, not installed).
