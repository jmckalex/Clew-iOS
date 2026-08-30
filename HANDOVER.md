# Handover — 2026-08-30 (0.9 sync + canvas delete button done; upstream moved again)

Session-rollover state, upstream-style: rewritten each session, kept short.
Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8-PLAN.md` and
`UPSTREAM-0.9-PLAN.md` are both **history**: executed in full. Read them
only for the reasoning behind a decision, not as work lists.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. Where things stand

Three layers of finished, unpushed work, each green on its own tip
(`npm test` 240, build + xcodebuild clean):

```
main                6f75e34   (10 ahead of origin, UNPUSHED, deliberately not moved)
 └ …0.8 chain… sync-p1-vendor … sync-p5-verify (edcd261)
    └ …0.9 chain… sync09-p1-vendor … sync09-p5-verify (322224e)
       └ canvas-delete-button  e618a00   ← TIP: review and merge
```

- **0.8 sync** — EmbedPDF everywhere, Excalidraw, Dataview/Bases,
  callouts, block refs, tables. Simulator-verified 2026-08-25.
- **0.9 sync** — vendored at upstream `8422a45`: kanban boards, Tasks
  dialect, DQL FLATTEN/GROUP BY/lambdas, admonitions, Meta Bind, Bases
  map views, obsidian:// links, Back-able anchors, chord forwarding,
  Excalidraw embedded images, and **engine-surface vault plugins**
  (charts demo). Simulator-verified 2026-08-26; details in PORT-PLAN's
  0.9 milestone entry.
- **canvas-delete-button** — from the owner's iPad testing: a trash-icon
  "Delete selection" button in the canvas toolbar. Touch had no delete
  route for shapes: the eraser is ink-only **by the owner's explicit
  call** ("it feels wrong to use the eraser for a shape"), Delete needs
  a keyboard, and a Pencil long-press never synthesizes contextmenu.
  Sim-verified end-to-end (disabled↔selection tracking; select-all + tap
  emptied shapes AND strokes from the .canvas file on disk).

The iPad sim (90DCB612…) has the tip build installed. Working tree clean.

## 2. SPLIT-BRAIN WARNING: the trash button is uncommitted upstream

The delete button was implemented in the GOLDEN MASTER and vendored
surgically into this repo (commit e618a00). In `../Clew-app` it is
**still uncommitted working-tree state**, deliberately — the owner
live-tests and commits there themselves:

- `src/renderer/components/views/clew-canvas-view.js` (+19: #deleteBtn,
  toolbar button, disabled sync in #syncOverlay)
- `src/renderer/styles/canvas.css` (+2: .canvas-tool:disabled rules)
- `scripts/generate-icons.js` (+1: `'trash': 'regular/trash-can'`)
- `src/renderer/lib/icons.js` (+1: the generated trash entry —
  regenerated 2026-08-30 against their moved HEAD and the hand-kept
  licence header restored, so the diff is exactly the icon)

If the owner commits these upstream, the next sync converges. If not,
`sync-upstream` copies the working tree, so it still carries them — but
do not let them silently vanish in an upstream `git checkout --`.

## 3. Upstream has moved again — the next sync's scope

`../Clew-app` main is now **`de45fe7`, 14 commits past `8422a45`**
(402 files, +4136/−1445, checked 2026-08-30). Do not run
`npm run sync-upstream` casually — it pulls all of this. Highlights:

1. **The owner's custom EmbedPDF OCG build is now VENDORED upstream**
   (`vendor/embedpdf/` + `scripts/vendor-embedpdf.js`). iOS currently
   stages EmbedPDF from `node_modules/@embedpdf/snippet/dist`
   (scripts/build.js assets map), and **our sync-upstream.js does NOT
   copy upstream's vendor/embedpdf** — the next sync must extend the
   sync script, switch the asset staging to the vendored build, and
   probably drop the three npm @embedpdf deps. This is the biggest and
   most iOS-relevant item: it changes the wasm/viewer we ship.
2. File explorer: "folders anchor the hierarchy" (+ a phantom-token
   trap noted in their HANDOVER).
3. Demo vault: Dashboards page, a "marking vault" recipe, Note Headers
   and Demo Canvas edits.
4. A "canvas-cards-are-the-app-page trap" fix.
5. `vendor/jmarkdown` moved: `config-manager.js` (the duplicate-key
   build-warning file) and `metapost.js`.

**Pre-checked at de45fe7:** only two anchor-bearing files changed
(`preview-client/client.js` +18, `clew-file-explorer.js` ±1) and BOTH
guarded patch anchors still match — all 9 build.js patches will apply.
Read `../Clew-app` HANDOVER.md for their own traps before scoping.

The owner also has unrelated uncommitted demo-vault edits in
`../Clew-app` (Note Headers.md, Demo Canvas.canvas, clewdata.json) —
never `git add -A` or checkout over them.

## 4. Open items

1. **Device verification, then merge + push** = TestFlight release,
   covering both syncs and the delete button. Owner has started (they
   created a drawing, embedded it in a canvas, and drove the eraser on
   an iPad — that testing is where the delete button came from).
   Still specifically worth hardware: Pencil finger-pan feel, Excalidraw
   with Pencil, per-scene Pdfium memory on many-PDF canvases, element
   fullscreen on small canvas PDF nodes, markdown table editing +
   Cmd+[ / Cmd+] + chord forwarding with a hardware keyboard.
2. **Decide sequencing**: ship the current stack first, or fold in the
   next sync (§3)? The EmbedPDF vendoring makes the next sync
   substantial; the current stack is coherent and shippable on its own.
3. Possible follow-ups the owner has seen but not requested: canvas
   toolbar undo/redo buttons (the remaining half of PORT-PLAN touch
   item 6 — Cmd+Z is still keyboard-only); Pencil long-press →
   contextmenu in select/pan tools (`ios-ui.js` gate; today only finger
   long-press synthesizes); "New drawing" in the explorer #rootMenu
   (upstream omission — palette and folder long-press are the only
   touch routes today).
4. Deferred, unchanged: `\citefile` BibDesk attachments; third-party
   notices surface (chart.umd.js MIT ships in seed-vault; EmbedPDF OCG
   build will change the notices story again); native CJK font
   download; 12 MB Xiaolai CJK face prune; ```kanban fence touch drag;
   "Move to folder…" long-press; empty folders in explorer; iCloud
   conflict surfacing; TikZ preamble-hash reuse; stale recents pruning.

## 5. Verification kit (works, use it)

- `npm test` — 240 green. `node tools/render-note.mjs <vault> <note>
  [--fragment]` — reads the vault's own vault-settings by default;
  `--vault-options '<json>'` REPLACES them (needed for gate-off tests).
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first or the script won't run**; read via
  `xcrun simctl spawn <sim> log show --last 40s --predicate
  'eventMessage CONTAINS "CLEWJS"'` (sim's own store; `--start` wants
  LOCAL time — use `--last`).
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId.
  `renderNote(rel)` returns full rendered HTML — fastest in-app engine
  assertion.
- Opening things from smoke: notes via
  `__clew.actions.openWikilink(name, { mode: "reading" })`; drawings and
  PDFs via `workspaceStore.openFile(path, {})`; **canvases via
  `workspaceStore.openCanvas(path, {})`** — openFile makes a generic
  file tab with no canvas viewer. **Same-path tabs are REUSED**: a stale
  wrong-kind tab from a previous run persists in the workspace and wins
  — walk `workspaceStore.state.root` and `closeTab(id)` first.
- Probe plugin recipe for inside preview iframes (unreachable from the
  app page): temporary vault plugin with a `preview` surface painting
  counts on a `data-clew-keep` banner; it can also DRIVE the document
  (it toggled a Meta Bind checkbox; assert on the file on disk).
  Remove it from the sim vault afterwards.
- Gotchas: every `simctl install` rotates the data container (re-run
  `get_app_container` — and re-resolve BEFORE writing test files);
  a failed xcodebuild leaves the previous build installed (grep
  `BUILD SUCCEEDED`); uninstall+reinstall to reseed the demo vault;
  smoke `message` listeners never fire from callAsyncJavaScript
  closures.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first
(xcode-select points at CLT). `npm run build`, then
`xcodebuild -project ios/Clew.xcodeproj -scheme Clew -destination
'id=<sim>' -derivedDataPath build/DerivedData build` (build/ is
gitignored). The one esbuild warning — duplicate "Highlight theme" key —
comes from vendor/jmarkdown's config files; upstream just touched
config-manager.js, so it may look different after the next sync.

`sync-upstream` regenerates `AppIcon.png` non-deterministically —
`git checkout --` it unless the upstream icon actually changed. On the
next sync: guarded patches fail the build loudly if an anchor drifted
(pre-checked fine at de45fe7, §3); check `shared/channels.js` and
`main/render-service.js` diffs for new shim/engine work; npm deps do
NOT auto-merge — and this time EmbedPDF moves from npm to upstream's
vendor tree (§3.1).
