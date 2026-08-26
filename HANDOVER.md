# Handover — 2026-08-25 (upstream 0.8 delta investigated, sync plan written)

Session-rollover state, upstream-style: rewritten each session, kept short.
Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. **The next session's job is to
execute `UPSTREAM-0.8-PLAN.md`** (repo root) — read it in full before
touching anything; it contains the investigation results, the settled
decisions, and the phase-by-phase work list.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. Where things stand

- **This session wrote a plan, not code.** No source changes; the only
  new files are `UPSTREAM-0.8-PLAN.md` and this handover. Three parallel
  investigations (feature arcs, EmbedPDF overlap, channels/services/
  engine delta) fed it; their conclusions are baked into the plan — do
  not re-derive them.
- **Repo state unchanged from last session**: on branch
  `embedpdf-annotator` (clean, device-verified, ready). `main` is 3
  commits ahead of `origin/main`, deliberately unpushed. `main`
  fast-forwards into `embedpdf-annotator`. Whether the owner ships the
  branch to TestFlight before the sync lands is their call; the sync
  work branches off `embedpdf-annotator` either way (as
  `upstream-0.8-sync`).
- **Upstream `../Clew-app` is 43 commits ahead** of our vendored tree
  (iOS vendor == upstream `b1b5790`; upstream main == `ed35ba8`, v0.8.0
  — re-check the SHA, it moves). Arcs: EmbedPDF PDF surface, Excalidraw,
  Dataview/dataviewjs/Bases, callouts, block refs, table editing,
  @image/@video, pandoc citations. Six new IPC channels.
- **The load-bearing finding**: upstream's EmbedPDF surface is a
  second-gen rewrite of our own branch's work (3c5ccff credits the iOS
  lessons) and arrives via the wholesale vendor sync. Unreconciled, it
  degrades SILENTLY — upstream's viewer wins the note embeds but saves
  via `clew:pdf-write`, which our shim doesn't know → every annotation
  save fails, plus duplicated CSS ids/hooks and the ios-ui.js observer
  destroying upstream's canvas iframes. The plan's settled decision:
  adopt upstream's surface, retire our parallel one (pdf-viewer.js,
  pdf-annotator.html, ios-ui.js canvas PDF machinery), keep the iOS
  platform layer (Swift `updateBinary` behind a new `CH.PDF_WRITE`
  handler, embedpdf staging, Pencil finger-pan re-hooked onto upstream's
  viewers).
- **All 7 build.js patch-guard anchors verified matching upstream main**
  — the sync will build; the danger is runtime, which the plan sequences
  around. New engine code needs no new Node shims (worker `new Function`
  for dataviewjs expected fine — indirect eval already M3-verified;
  smoke it).

## 2. Decisions the owner may want to reverse (flagged in the plan)

1. PDF file tabs switch from the QuickLook override to upstream's
   `pdf-page.html` viewer (desktop parity; QuickLook bridge stays).
2. Canvas-embed-scene PDFs also use `pdf-page.html`, letting PDF.js be
   dropped entirely from staging (several MB smaller; watch per-scene
   Pdfium memory on device).
3. CJK PDF fonts: stubbed off (channels return unavailable, settings
   section patched out, `pdffonts/fallback.json` answers `null`).
   Native 139 MB download is a possible later feature.

## 3. Open items

1. **Execute UPSTREAM-0.8-PLAN.md** (the next phase, start to finish:
   sync → engine/shim plumbing → PDF reconciliation → Excalidraw →
   tests → simulator sweep). Definition of done is in the plan §10.
2. `embedpdf-annotator` merge + push to main = TestFlight release,
   still awaiting the owner's word (device-verified last session).
   Owner follow-up riding along: Pencil finger-pan feel-check.
3. Deferred from the sync (recorded in plan §9): `\citefile` BibDesk
   attachments (BufferShim gaps), third-party notices surface for iOS,
   CJK fonts.
4. Pre-existing: kanban touch drag; "Move to folder…" long-press; empty
   folders invisible in explorer; iCloud conflict surfacing + canvas-ink
   merge; engine-surface vault plugins + TikZ preamble-hash reuse;
   stale recents pruning; upstream candidates in PORT-PLAN (add from
   this arc: Pencil pan convention, `dataviewJs` in the reconfigure
   list, canvas-scene PDF embeds).

## 4. Verification kit (works, use it)

- `npm test` — 19 green (engine render battery + services).
- Simulator smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios
  -ClewSmokeJS '<js>'` (runs in app page ~2s after load; `window.__clew`
  = stores/registry/ipc, `window.__clewNative` = render/diff/flush);
  logs via `log show --predicate 'eventMessage CONTAINS "CLEWJS"'`;
  screenshots via `simctl io <sim> screenshot`. iPad sim
  90DCB612-1B85-4E1A-A17A-DBEB98F6C36D, iPhone A97A2ED5….
- `node tools/render-note.mjs <vault> <note>` — engine render under Node.
- **Gotchas that cost hours** (details in PORT-PLAN/memory): smoke
  `message` listeners never fire from callAsyncJavaScript closures;
  simulator state persists across reinstalls (uninstall for clean runs);
  test with a freshly built+installed app (a failed xcodebuild leaves
  the previous build installed — check for `** BUILD SUCCEEDED`).
- **Upstream propagation**: `npm run sync-upstream && npm run build &&
  npm test`; build fails loudly if a vendored patch no longer matches
  (fix in scripts/build.js); check `shared/channels.js` +
  `main/render-service.js` diffs for new shim/engine-config work; npm
  deps do NOT auto-merge from jmarkdown/Clew-app package.json.
