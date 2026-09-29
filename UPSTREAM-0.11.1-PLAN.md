# Upstream 0.11.1 sync — plan

**STATUS: EXECUTED 2026-09-30** — p1 `465b837`, p2 `70b4f11`, p3 `d0d3842`,
p4 (this record + RENDER_HTML) on `sync111-p4-verify`; `main`
fast-forwarded to it. Ordered by Clew-boss, whose instructions on syncs are
the owner's (the owner's standing rule); push = the owner's decision
("push overnight if ALL checks pass"), relayed by Clew-boss after p4.

**Results (simulator, iPad Pro 11" M4, iOS 18.1; 680 tests):**
- The four build breaks resolved; 14 guarded patches remain.
- Token: random sid (`s` + 32 hex) and token (64 hex) per vault open; an
  unknown sid → 404 (incl. `__clew_plugin_file__`); render POSTs in
  desktop's order — no token 403, wrong 403, raw text 400, array 403,
  > 100,000 chars 413, bad `text` 400, bad `sourcePath` 400, valid 200.
  Engine-rendered callout cards in the canvas tab (app-page POSTs), the
  canvas embed in a note (preview-document POSTs, lazy ask), and the
  Export-as-PDF of that note (the self-post; read from the PDF's text).
  Live block frames 2/2. A sandboxed frame: every read blocked, its POST
  refused.
- Step 0 senders: Excalidraw library load/save from `clew-preview://vault`
  answered; PDF saves — a preview document's answered, a sandboxed frame's
  refused, a same-origin non-viewer frame's DROPPED by the scene relay, a
  scene viewer's relayed and answered. The Excalidraw library survives a
  note embedding a drawing and the drawing's editor tab (1 → 1 → 1).
- The consumer sweep matches the baseline (Diagrams 11/11, maps + tiles,
  EmbedPDF, Excalidraw, canvas scene, MathJax, media, charts); the only
  error is jsoncanvas.org's own script, as before.
- Toolbar: 2 rows × 44 = 88 px on the tall viewport; forced short
  (`--toolbar-two-row-min-height` 5000 px) → 1 row, 44 px; back to 2.
- Preview pane on a coarse pointer: `pointer-events: none` when it fits,
  `auto` with `[data-overflows]`.
- Block citations under the note's header: "Lewis (1969)" (was empty).
- Esc: a synthetic Escape from inside an engaged note card disengages it
  (1 → 0); control without Esc stays engaged (1 → 1).
- `display:none` preview frame: timers AND wasm keep running.
- Suspension: backgrounding calls `flushForSuspension` (resolves `true`);
  an edit made just before is on disk while the app is backgrounded.
- References "This note": 4 entries, unchanged by an exclusion-list change —
  after adding the MISSING `RENDER_HTML` handler (a pre-existing gap since
  upstream b1b5790: the view said "Could not render this note" whenever a
  vault turned `bibliographyPanel` on).
- A clean install opens exactly one tab, Welcome.md. History same-second
  order asserted (services test).

**What the simulator cannot prove (the iPad):** a real hardware-keyboard
Esc (the logic path is verified with a synthetic event); iOS suspending
the app mid-save (the 1 s auto-save and the flush both land first here);
the short viewport under a real software keyboard (forced via the CSS
threshold instead); an actual PDF annotation save (the bridge path is
exercised with a refused bogus path, not a real annotation).

**PIN: Clew-app `84f975e`** — the commit right after `2e45098` (the message
receiver fix, on `6cbe0d8`), which fixes the Excalidraw library data loss
(the read-only embed's `onLibraryChange` in `src/excalidraw/page.js`
emptied the library). Guards passed 2026-09-29: HEAD `84f975e` (parent
`2e45098`), `src vendor demo-vault` clean. Guard before copying: Clew-app's HEAD is
the pin AND `git status --porcelain -- src vendor demo-vault` is empty —
else abort (or sync from a worktree/export of the pin).

Base: `main` (origin at `7a34dd3`: vendor at Clew-app `ccf8dca` + the
`368bfd7` mptikz pin, i.e. through app `e88aff6`). One branch per phase,
chained. **Stop before any push** (a push is a TestFlight release; the
owner decides it, usually after the iPad).

Dry run (2026-09-29, a scratch copy synced at `6cbe0d8`): the build fails
in exactly four places — canvas patch 2 (patch 4 would fail next),
`toolbar/popover.js`, `chrome/floating-pane.js`, and the unresolved
`#jmarkdown/crossref.js`. Nothing else breaks. `vendor/jmarkdown` and
`demo-vault` are untouched by the range.

## p1 — vendor (`sync111-p1-vendor`)

- `npm run sync-upstream` (guarded); `git checkout --` the regenerated
  `AppIcon.png`.
- `package.json`: `"imports": { "#jmarkdown/*": "./vendor/jmarkdown/src/*" }`
  (89a6bb0). Drop the `onResolve` re-root in `scripts/build.js` (l.~130–
  140) and `tests/hooks/vendor-jmarkdown.mjs` + its `register()` line —
  check `node --test` and the worker bundle still resolve the engine.
- `scripts/build.js`: drop canvas-view patches 2, 3 (both anchors) and 4
  (45dffd7; keep 1, the office Live choice); drop the `toolbar/popover.js`
  and both `chrome/floating-pane.js` patches (43cc4e7, `lib/viewport.js`);
  drop the `renderer/main.js` settings-load patch (9b97ff9).
- `src/shim/ios-ui.js`: drop the first-open greeting copy (l.~471–490,
  9b97ff9) — verify no second Welcome tab.
- `src/shim/ipc.js`: `dataviewJs` in the reconfigure list is now upstream's
  (055d46b) — keep or drop per whether the shim mirrors upstream's list.
- The history services test may assert same-second ORDER again (0d17da7).
- `npm run build` green, `npm test` green. PORT-PLAN: the upstream-candidates
  list — mark the landed ones (boot greeting + settings load, snapshot
  order, downloadEngine repaint, dataviewJs, engaged canvas node, floaters,
  `#jmarkdown/*`, `data-overflows`, `citationHeader`).

## p2 — the caller token (`sync111-p2-token`)

Shapes from Clew-app `6cbe0d8` (HANDOVER §4.5 has them verbatim).

- **Swift, `SchemeHandler.swift`:**
  - `__clew_fragment__` body becomes JSON `{token, text}`; `__clew_block__`
    `{token, text, sourcePath}`. Desktop's order
    (`main/caller-token.js#readRenderBody`): > 100,000 chars → 413; not
    JSON / not an object → 400; token mismatch → 403 (constant-time);
    `text` not a string, `sourcePath` neither null nor a string → 400.
  - iOS's own Origin layer on the render POSTs: allow `clew-app://app`,
    `clew-preview://vault`, or none; refuse `null` and http(s) (measured:
    the app page sends `clew-app://app`, a same-origin preview POST none,
    a sandboxed frame `null`).
  - ACAO: a CONSTANT `clew-app://app` on both schemes (measured: every
    consumer works, null reads blocked) — agreed with Clew-app (§2.6).
  - **A random sid, and validate it.** Today Swift never checks the
    `/<sid>/` segment (`/anything/Welcome.md` serves the file), so a
    random sid alone protects nothing: refuse an unknown sid (404) on
    every `/<sid>/` route, `__clew_plugin_file__/<sid>/` included.
- **Session:** sid + token (32 random bytes, hex) generated in Swift per
  vault open, held in memory only; the app page receives them through the
  bridge (main frame only since 8ceb533) — `src/shim/ipc.js`'s
  `SESSION_ID` constant (`'s1'`, used at l.25/65/68/517/589) becomes the
  bridge's value, and VAULT_CURRENT's vault object carries `callerToken`
  beside `sessionId`.
- **PrintPDF:** evaluate the self-post
  `window.postMessage({ source: 'clew-preview-host', type: 'caller-token', token }, 'clew-preview://vault')`
  in the Export-as-PDF view beside the light-theme script, after load.
- Tests: port `tests/caller-token.test.js`; Swift-side refusal cases as a
  services test where the shim mirrors them.
- **iOS-owned message listeners, to step 0's rule** (`2e45098`,
  `shared/message-guard.js`): `src/preview/pdf-scene-embeds.js`'s save relay
  forwards ANY child's `clew-pdf` save upward under the PREVIEW origin — a
  confused deputy that defeats the app page's new origin check; forward only
  when `event.origin === PREVIEW_ORIGIN` and `event.source` is one of this
  document's scene-viewer iframes, and accept results only from
  `window.parent` (`fromWindow`). `src/preview/embed-scroll.js`: host
  messages only from `window.parent`.

## p3 — iOS features the range needs (`sync111-p3-features`)

- `src/ios/styles/ios.css`: drop `body.is-ios .editor-toolbar { height:
  44px }` (it clips row 2), set `--toolbar-row: 44px`; tune
  `--toolbar-two-row-min-height` if the short-viewport measurement needs it.
- `ios.css`: `@media (pointer: coarse) { clew-preview-pane:not([data-overflows]) { pointer-events: none } }`
  (f47080b).
- `src/shim/render-service.js#renderBlock`: prepend
  `citationHeader(noteText, noteDir)` as desktop's render-service does
  (707ed87; `main/citation-header.js` needs only `node:path`).
- The PDF flush on suspension: if p4's measurement loses a save,
  `beginBackgroundTask` around the background transition until the web
  side reports flushed (`ClewApp.swift` scenePhase, `install-shim.js`).

## p4 — verify (`sync111-p4-verify`)

Simulator, clean install AND upgrade install; shut down afterwards.
- Token: canvas cards engine-rendered (`.callout-title` present — the
  instant renderer cannot draw one), live block frames, a canvas embed in
  a note (preview-document POSTs), the preview pane, print with a canvas
  embed; a sandboxed frame's POST → refused; an unknown sid → 404.
- The consumer sweep again (Diagrams, maps, EmbedPDF, Excalidraw, canvas
  scene, MathJax, media, charts, live blocks), zero new errors.
- Esc on a hardware keyboard leaves an engaged note card (7a0cb6f).
- The two-row toolbar; one row + … at a short viewport (keyboard up,
  landscape).
- The preview pane: a drag over a fitting pane scrolls the note; a tall
  diagram scrolls in the pane.
- PDF annotations survive their viewer going (1956d89): a `display:none`
  iframe keeps running long enough to save (tab switch, embed switch,
  live frame, canvas card); a save across backgrounding.
- Citations in a live block frame under the note's `Bibliography:` header.
- Step 0 on iOS: every legitimate sender is on `clew-preview://vault` —
  Excalidraw saves (tab, canvas node, note embed), PDF saves (tab, canvas
  node, note embed, a scene PDF through the relay), and preview documents;
  none refused. Opening a note that embeds a drawing leaves the Excalidraw
  library intact (`.clew/excalidraw-library.json` unchanged).
- The References panel's Note mode after an exclusion-list change.
- History same-second ordering. No second Welcome tab.
- `npm test` green. Docs: PORT-PLAN milestone, README known gaps,
  HANDOVER rewrite, this plan's STATUS line. Report to Clew-boss; stop.
