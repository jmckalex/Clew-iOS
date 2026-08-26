# Handover — 2026-08-25 (upstream 0.8 sync executed, simulator-verified)

Session-rollover state, upstream-style: rewritten each session, kept short.
Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8-PLAN.md` is now
**history**: it was executed in full this session. Read it only for the
reasoning behind a decision, not as a work list.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. What happened

The 0.8 sync landed, start to finish, on a **chain of phase branches** so
any phase can be dropped without losing the earlier ones:

```
main (6f75e34, = embedpdf-annotator, 10 ahead of origin, UNPUSHED)
 └── sync-p1-vendor      prep → vendor drop @ ed35ba8 → engine plumbing
      └── sync-p2-pdf    EmbedPDF everywhere, iOS parallel surface retired
           └── sync-p3-excalidraw   editor page + assets + 2 channels
                └── sync-p4-tests   19 → 160 tests
                     └── sync-p5-verify  ← TIP, the branch to review/merge
```

`main` was fast-forwarded to `embedpdf-annotator` at the owner's request
(it ships nothing until pushed). Each branch builds and tests green on its
own tip.

**Everything in the plan's Definition of Done (§10) is met**, plus three
bugs the plan could not have known about (§3).

## 2. Verified, and how

`npm test` 160/160 (was 19). `npm run build` and `xcodebuild` both clean.
Simulator sweep on the iPad sim, clean install, screenshots in the session
scratchpad:

- **Callouts** — 14 typed boxes with icons, foldables as `<details>`.
- **Block refs** — anchors emit ids; `![[Note#^id]]` transcludes the real
  paragraph text.
- **Dataview + Bases** — TABLE and ```base render with resolved links and
  display names. `dataviewjs` gated off by default, executes when the vault
  opts in (so `new Function` works in the worker).
- **PDF, all four surfaces** — note embed, file tab, canvas node, and
  canvas-embed scene. All render upstream's viewer; **all four save**:
  driving a real annotation changed `sample.pdf` on disk twice
  (`77c5f1ac` → `56e3dbad` → `cf8dc84b`, still a valid PDF 1.4).
- **Excalidraw** — the embed renders, and the editor tab opens the real
  Excalidraw (full toolbar, drawing, undo/redo) under WKWebView. This was
  the plan's biggest unknown; it works.
- **Channels** — all six new ones answer; zero "Unknown channel".
- **Settings** — the CJK "PDF viewer" section is gone, as intended.
- **Regressions** — search, index (42 notes, drawings indexed), tree, bib,
  mermaid, MetaPost cached SVG, Note Headers banner. No CSP/wasm errors
  after dropping `'wasm-unsafe-eval'` from the app page.

TikZ still errors in the demo vault — the documented accepted loss (no
LaTeX toolchain), not a regression.

**Instrument worth knowing about**: app-page JS cannot read into a
cross-origin preview iframe, so the sweep used a temporary vault plugin
(`.clew/plugins/probe`) whose preview surface paints DOM counts on a banner
and can drive a real annotation. It has been removed from the simulator
vault. It needs `data-clew-keep` or the next morph strips it — that cost
half an hour.

## 3. Bugs found and fixed along the way (not in the plan)

1. **`tools/render-note.mjs` carried a stale hand-copy of the engine
   config.** The Node battery rendered notes WITHOUT the app's extensions
   and still reported green — the exact silent-degradation shape this sync
   existed to catch. Both sides now import one `src/shim/engine-config.js`.
2. **`vfs.stat()` returned no `birthtimeMs`/`ctimeMs`.** Dataview's
   vault-model feeds them to `new Date(...).toISOString()`, so *every*
   dataview render died with "Invalid time value".
3. **Vault-wide bibliography never reached the iOS shim** — shipped
   upstream in the *previous* sync point (b1b5790); the settings UI was
   live and the engine config ignored it.

Two build fixes also fell out: `stageStatic` now wipes `preview-assets/`
(the dropped PDF.js megabytes lingered in an incremental dist and shipped
anyway), and `pdf-core.js` publishes viewer handles so the touch layer can
reach all three surfaces.

## 4. Decisions the owner may want to reverse

Both were the plan's documented defaults, taken because the owner was
asleep; both are a single-commit revert on `sync-p2-pdf`.

1. **PDF file tabs no longer open in QuickLook** — they open upstream's
   `pdf-page.html` viewer (desktop parity, in-tab annotation). The
   `quickLook` Swift bridge is still there.
2. **Canvas-scene PDFs use Pdfium too, and PDF.js is deleted outright.**
   One PDF stack, several MB smaller. **Watch memory on a note embedding a
   canvas with several PDFs — one Pdfium engine per scene PDF.** That is
   the device check to make; if it is bad, the fallback is keeping a
   lightweight reader for scenes only.

Third, unchanged from the plan: CJK PDF fonts are stubbed off (§2).

## 5. Open items

1. **Device verification, then merge + push** = TestFlight release. Nothing
   is pushed. Specifically worth an iPad: Pencil finger-pan *feel* on both
   the inline and `pdf-page` surfaces; Excalidraw with Pencil; EmbedPDF
   inside a small canvas node (upstream's answer is its fullscreen control
   — verify element fullscreen works in WKWebView, and if it disappoints,
   resurrect a thin overlay *reusing pdf-page.html*); memory on
   many-PDF / many-drawing notes.
2. **Markdown table editing** (Tab/Enter in the editor) is vendored and
   covered by `tables.test.js`, but was NOT exercised in the simulator —
   it needs keyboard input. First thing to try on a device with a keyboard.
3. Deferred from the sync: `\citefile` BibDesk attachments (BufferShim
   gaps), a third-party notices surface for iOS (App Store licence hygiene
   — notices need regenerating for the iOS dependency set), native CJK font
   download.
4. **App size**: Excalidraw's assets add 17 MB, 12 MB of which is the
   Xiaolai CJK face. Staged whole on purpose (the bundle fetches
   `locales/*.json` from the same root, so the plan's "fonts + data" guess
   would have broken every non-English UI). Prune the CJK face if size
   matters more than CJK handwriting.
5. Pre-existing: kanban touch drag; "Move to folder…" long-press; empty
   folders invisible in explorer; iCloud conflict surfacing + canvas-ink
   merge; engine-surface vault plugins + TikZ preamble-hash reuse; stale
   recents pruning. Upstream candidates now have their own section in
   PORT-PLAN.md.

## 6. Verification kit (works, use it)

- `npm test` — 160 green (upstream's ported suites + the iOS engine-worker
  battery + services).
- `node tools/render-note.mjs <vault> <note> [--vault-options '<json>']` —
  render under Node through the SAME config the app uses.
- Simulator smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios
  -ClewSmokeJS '<js>'`; `window.__clew` = stores/registry/ipc,
  `window.__clewNative` = render/diff/flush. Read results with
  `xcrun simctl spawn <sim> log show --last 40s --predicate 'process ==
  "Clew"'` — **`--start` wants LOCAL time, not UTC** (that silently
  returned nothing). iPad sim 90DCB612-1B85-4E1A-A17A-DBEB98F6C36D.
- Open a note deterministically: `openWikilink(name, {})` then
  `workspaceStore.setTabMode(tab.id, 'reading')`. **Do not use
  `toggleReadingMode`** in a smoke script — workspace state persists, so a
  blind toggle lands in source mode half the time.
- **Gotchas that cost hours** (details in PORT-PLAN/memory): smoke
  `message` listeners never fire from callAsyncJavaScript closures; every
  `simctl install` rotates the data container, and the app then reopens a
  now-missing vault path and looks empty — uninstall + reinstall for a
  clean run; a failed xcodebuild leaves the previous build installed
  (check for `** BUILD SUCCEEDED`).
- **Upstream propagation**: `npm run sync-upstream && npm run build &&
  npm test`; the build fails loudly if a vendored patch no longer matches
  (fix in scripts/build.js — 9 guarded anchors across 8 files now, the
  settings-view and pdf-core ones new this sync, plus the metadata-header
  dynamic-import transform). Check `shared/channels.js` and `main/render-service.js`
  diffs for new shim/engine work; npm deps do NOT auto-merge from upstream.
