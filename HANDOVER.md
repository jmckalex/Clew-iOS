# Handover — 2026-08-26 (upstream 0.9 sync executed, simulator-verified)

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

TWO syncs are now stacked locally, neither pushed. The 0.8 chain
(`sync-p1-vendor` … `sync-p5-verify`, see the 0.8 plan) still exists; the
0.9 sync continues from its tip on its own chain:

```
main                      6f75e34   (10 ahead of origin, UNPUSHED)
 └ …0.8 chain… └ sync-p5-verify  edcd261
                  └ sync09-p1-vendor    7d9532f  vendor drop @ 8422a45 + 3 new engine extensions
                    └ sync09-p2-plugins 0879402  engine-surface vault plugins + worker `global` fix
                      └ sync09-p3-features dd8d369  Swift dict-form-surfaces fix (sim sweep lived here)
                        └ sync09-p4-tests    (174 → 240)
                          └ sync09-p5-verify ← TIP: review and merge
```

Each branch builds and tests green on its own tip. Working tree clean;
**nothing pushed**. `main` was NOT moved this time — the owner said
nothing about it, so merging the two chains (or dropping a phase) is
their call.

## 2. What the 0.9 sync brought (all simulator-verified)

Vendor + seed-vault at upstream `8422a45` (v0.9.0). No new IPC channels,
no new npm deps (chart.js ships vendored INSIDE the demo vault's plugin).
Full list + verification detail in PORT-PLAN's 0.9 milestone entry.
Highlights and the proof used:

- **Charts plugin end-to-end** — the demo vault's first ENGINE-surface
  plugin forced the known iOS gap closed: engine-config takes
  `engineExtensions` entries (computed by both callers via vendored
  `main/plugins.js`), the worker snapshot carries the named files, and
  the build's `__jmdImport` falls back to `__jmdImportSource` (vfs text →
  blob-URL module import, data:-URL under Node). Probe banner in the sim:
  `chart=6 canvas=6` on Guide/Charts.md — fences AND dataviewjs
  `renderChart`. Plugin engine surfaces must be self-contained modules.
- **Meta Bind writes through**: probe toggled the compat page's
  `INPUT[toggle:done]`; the file's frontmatter changed `done: false →
  true` on disk.
- **Excalidraw images**: a fabricated drawing with `## Embedded Files`
  → `[[NASA - Earthrise.jpg]]` opened in the editor with the photo
  rendered (resolve bridge + same-origin preview fetch both work as
  vendored — the clewex page and vault files share the `vault` host).
- **Kanban board** renders read-only with cards/dates/wikilinks; the
  checkbox is the only write path (same data-source-line toggle 0.8
  verified). NOT a collision with the pre-existing kanban-drag item.
- **Bases map view**: leaflet + two markers from note `coordinates`.
- **Diagrams**: MetaPost's new abacus figure is a cache HIT (renders);
  TikZ misses cache and errors per block — the same accepted loss, new
  error shape, exactly as predicted.
- **Regressions**: callouts, queries/bases/dataview, MathJax, wikilinks,
  search (36 hits), PDF file tab in EmbedPDF viewer — all green.

## 3. Bugs found and fixed (not in the plan)

1. **esbuild-injected `global` was invisible to runtime-imported
   modules** (worker). The charts engine surface references `global` at
   module scope; under Node it exists, in the worker it was only a
   bundle-scoped binding — "Can't find variable: global" in the sim while
   the harness passed. globals.js now sets `globalThis.global`.
2. **Swift manifest parsing dropped dict-form surfaces.**
   `manifest["surfaces"] as? [String: String]` fails wholesale when ANY
   surface is `{ "file": … }` — so a plugin with an engine surface lost
   its preview surface too (charts drew nothing, silently). SchemeHandler
   now parses per-key, mirroring plugins.js.

Also: `tools/render-note.mjs` now defaults vaultOptions to the vault's
own `.clew/vault-settings.json` (--vault-options REPLACES it) — the 0.8
lesson again: the battery must run the config the app runs.

## 4. Open items

1. **Device verification, then merge + push** = TestFlight release —
   unchanged from 0.8 and now covering both syncs: Pencil finger-pan
   feel (inline + pdf-page), Excalidraw with Pencil, EmbedPDF in a small
   canvas node (element fullscreen?), per-scene Pdfium memory,
   markdown table editing with a hardware keyboard. New from 0.9, also
   needing hardware: **Cmd+[ / Cmd+] and full chord forwarding from
   reading mode** (unit-tested; not exercisable in the sim), anchor-jump
   Back behavior feel, obsidian:// links in a real vault.
2. **The two chains are stacked** — if the owner wants 0.8 shipped alone
   first, `sync-p5-verify` is still a valid tip; 0.9 rebases cleanly on
   whatever lands (it only touches vendor/, seed-vault/, src/, ios/,
   tests/, tools/).
3. Deferred, unchanged: `\citefile` BibDesk attachments; third-party
   notices surface (note: chart.umd.js MIT now ships inside seed-vault);
   native CJK font download; the 17 MB Excalidraw asset set (12 MB CJK
   face prune candidate); kanban ```kanban-fence touch drag; "Move to
   folder…" long-press; empty folders in explorer; iCloud conflict
   surfacing; TikZ preamble-hash reuse (would turn the demo TikZ misses
   into hits); stale recents pruning.
4. Upstream candidates from this sync: none new — the two fixes in §3
   are genuinely iOS-only. Existing candidates list lives in PORT-PLAN.

## 5. Verification kit (works, use it)

- `npm test` — 240 green. `npm run build` then xcodebuild (see §6).
- `node tools/render-note.mjs <vault> <note> [--fragment]` — now reads
  the vault's vault-settings by default; `--vault-options '<json>'`
  replaces them (needed for gate-off tests).
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first or the script won't run**; read via
  `xcrun simctl spawn <sim> log show --last 40s --predicate 'eventMessage
  CONTAINS "CLEWJS"'` (sim's own store; `--start` wants LOCAL time — use
  `--last`). iPad sim 90DCB612-1B85-4E1A-A17A-DBEB98F6C36D.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry; `__clewNative` =
  **renderNote/renderFragment/externalDiff/flush/sessionId** (NOT
  `render` — an older note said otherwise). `renderNote(rel)` returns the
  full rendered HTML: the fastest way to assert engine output in-app.
- Open a note: `__clew.actions.openWikilink(name, { mode: "reading" })`
  (mode option beats the old two-step). Open a DRAWING or PDF:
  `__clew.workspaceStore.openFile("path/File.excalidraw.md", {})` — a
  wikilink to a drawing needs the `.excalidraw`-inclusive name, and an
  unresolved openWikilink CREATES the note (it did; the stray was
  deleted).
- **Probe plugin recipe** (cross-origin preview iframes are unreachable
  from the app page): temporary vault plugin with a `preview` surface
  painting counts on a fixed banner — MUST carry `data-clew-keep` or the
  morph strips it. It can also DRIVE the document (it toggled the Meta
  Bind checkbox). Removed from the sim vault after the sweep, as always.
- Gotchas: every `simctl install` rotates the data container (re-run
  `get_app_container`); a failed xcodebuild leaves the previous build
  installed (grep `BUILD SUCCEEDED`); uninstall+reinstall to reseed the
  demo vault; smoke `message` listeners never fire from
  callAsyncJavaScript closures.

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first
(xcode-select points at CLT). `npm run build`, then
`xcodebuild -project ios/Clew.xcodeproj -scheme Clew -destination
'id=<sim>' -derivedDataPath build/DerivedData build` (build/ is
gitignored now). The one esbuild warning — duplicate "Highlight theme"
key — is in vendor/jmarkdown's config files, pre-existing, upstream's.

`npm run sync-upstream` currently REPRODUCES the vendor tree (upstream
main = 8422a45 = our sync point, checked 2026-08-26) — but it regenerates
`AppIcon.png` non-deterministically; `git checkout --` it unless the
upstream icon actually changed. When upstream moves again, the same
drill: guarded patch anchors fail the build loudly if a patched line
drifted; check `shared/channels.js` and `main/render-service.js` diffs
first; npm deps do NOT auto-merge.
