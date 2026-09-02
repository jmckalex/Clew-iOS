# Handover — 2026-09-02 (EmbedPDF OCG done; upstream surged: office suite, history, atomic writes)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. The `UPSTREAM-0.8-PLAN.md` and
`UPSTREAM-0.9-PLAN.md` files are **history**: executed in full.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. Where things stand

Four layers of finished, unpushed work, each green on its own tip
(`npm test` 240, build + xcodebuild clean):

```
main                6f75e34   (10 ahead of origin, UNPUSHED, deliberately not moved)
 └ …0.8 chain… sync-p1-vendor … sync-p5-verify (edcd261)
    └ …0.9 chain… sync09-p1-vendor … sync09-p5-verify (322224e)
       └ canvas-delete-button  e618a00
          └ embedpdf-vendor  13c22ff   ← TIP: review and merge
```

- **0.8 sync** — EmbedPDF everywhere, Excalidraw, Dataview/Bases,
  callouts, block refs, tables. Simulator-verified 2026-08-25.
- **0.9 sync** — vendored at upstream `8422a45`: kanban, Tasks dialect,
  DQL FLATTEN/GROUP BY/lambdas, admonitions, Meta Bind, Bases map
  views, obsidian:// links, Back-able anchors, chord forwarding, and
  engine-surface vault plugins. Simulator-verified 2026-08-26.
- **canvas-delete-button** — trash-icon Delete-selection in the canvas
  toolbar (touch had no delete route for shapes). Sim-verified.
- **embedpdf-vendor** (`8fc7011`) — the owner's EmbedPDF OCG build
  (layers fork; wasm carries FPDF*OCG*), cherry-vendored from what was
  then upstream's tip. `vendor/embedpdf/` is the committed mirror
  (sync-upstream.js copies it; .gitignore needed exceptions for BOTH
  `dist/` and `*.map`), build.js stages from it, `@embedpdf/snippet`
  dropped from deps (models/pdfium kept — the owner's; ask before
  pruning). Sim-verified by content: OCG chunk 200 + stock npm chunk
  404 over `clew-preview://vault/__clew_assets__/embedpdf/`, served
  wasm carries 24 FPDF*OCG symbols, sample.pdf renders. The layers tab
  itself is inside the cross-origin viewer page (smoke can't reach) —
  eyeball on hardware: sidebar, third icon-only tab, empty state.

The iPad sim (90DCB612…) has the tip build installed. Working tree clean.

## 2. The old split-brain is RESOLVED

The trash button is now **committed upstream** (`bff8410`) and the
upstream tree is CLEAN — the owner also committed their demo-vault
edits. The next `sync-upstream` overwrites our vendored copies with
their committed versions and everything converges. No dangling state.

## 3. Upstream SURGED — next sync is now a major undertaking

`../Clew-app` main is **`dbe8348`, 38 commits / 463 files / +8738
past our vendored `8422a45`** (checked 2026-09-02; 24 of those commits
are NEW since the last check at de45fe7). Do not run
`npm run sync-upstream` casually. **Their HANDOVER.md §1 is addressed
directly to this iOS session — read it first.** Highlights:

1. **A whole office suite**: ZetaOffice / LibreOffice-in-wasm. Office
   documents edit in tabs; office embeds in notes and canvases
   (thumbnails by default, live by choice); new main-process files
   (office-convert/office-slot/office-thumbs/zeta-assets/zeta-icons),
   `shared/channels.js` gained channels, `shared/zeta-manifest.json`,
   a CDN engine download, a vendored Sifr icon zip. This is a NEW
   SUBSYSTEM with unknown WKWebView feasibility (wasm size, memory) —
   scope it as its own arc, maybe its own decision to defer.
2. **Note history — an on-disk vault contract** (`22c59b4`):
   `.clew/history/<note path>/<stamp><ext>` snapshots, per-vault
   `history` setting. Reference: `src/main/history.js` + unit tests.
   **iOS writes notes, so iOS should produce/respect the same
   snapshots or the shared manual needs an iOS caveat** — parity is
   candidate work even before/without the full sync.
3. **Atomic vault writes — an on-disk convention** (`5b70193`): temp
   `.<basename>.clew-tmp` beside the target + fsync + rename, behind
   every durable write. Same argument: iOS should adopt the same shape
   so each app ignores the other's temps. Exemplar:
   `src/main/fs-utils.js#writeFileAtomic`.
4. **First-run/welcome** (`dd703e7`): desktop now ships + copies out
   the demo vault (iOS already does this); a vault with NO saved
   workspace opens its root `Welcome.md` — cheap parity win.
5. Editor: fill-paragraph / auto-fill-mode (Emacs M-q; true Alt-Q).
6. **Engine mirror re-synced** at `at-migration@748bd70` — the next
   sync pulls a new jmarkdown too (config-manager.js moved earlier;
   the duplicate-key esbuild warning may change shape).
7. `smoke/` is now committed upstream (reusable scenarios + 5k-vault
   stress kit with baselines) — mine it for iOS smoke ideas.
8. Plus the earlier de45fe7 batch still unpulled: explorer "folders
   anchor the hierarchy", demo-vault content, the canvas-cards trap
   fix. (Its EmbedPDF item is DONE here — §1.)
9. The shared manual (`../Clew-docs`) now documents desktop truths
   (note-history, first-launch, `.clew/` table, ninth per-vault key
   `history`) — check against iOS reality, caveat where needed.

**Pre-checked at dbe8348:** of the files build.js patches, only three
changed upstream since the last anchor check (client.js,
node-content.js, clew-settings-view.js) and **all three anchors still
match — all 9 guarded patches will apply.** package.json changed
upstream; npm deps do NOT auto-merge.

## 4. Open items

1. **Device verification, then merge + push** = TestFlight release,
   covering both syncs, the delete button, and the OCG PDF viewer
   (layers sidebar + per-annotation layer assignment — the piece the
   sim can't show). Still specifically worth hardware: Pencil
   finger-pan feel, Excalidraw with Pencil, per-scene Pdfium memory on
   many-PDF canvases, element fullscreen on small canvas PDF nodes,
   markdown table editing + Cmd+[ / Cmd+] + chord forwarding with a
   hardware keyboard.
2. **Decide sequencing.** The current stack is coherent and shippable.
   The pending sync now contains a big office arc — plausible shape:
   ship the stack, then a "0.10 sync" that pulls everything BUT defers
   office to its own feasibility spike.
3. **On-disk contract parity** (§3.2–3.4): note history, atomic
   writes, Welcome.md-on-first-open. These matter independent of the
   sync because both apps write the same vaults (iCloud).
4. Possible follow-ups the owner has seen but not requested: canvas
   toolbar undo/redo buttons (remaining half of PORT-PLAN touch item
   6); Pencil long-press → contextmenu in select/pan tools; "New
   drawing" in the explorer #rootMenu.
5. Deferred, unchanged: `\citefile` BibDesk attachments; third-party
   notices surface (now also the OCG build; office would add
   LibreOffice/Sifr); native CJK font download; 12 MB Xiaolai CJK
   prune; ```kanban fence touch drag; "Move to folder…" long-press;
   empty folders in explorer; iCloud conflict surfacing; TikZ
   preamble-hash reuse; stale recents pruning.

## 5. Verification kit (works, use it)

- `npm test` — 240 green. `node tools/render-note.mjs <vault> <note>
  [--fragment]` — reads the vault's own vault-settings by default;
  `--vault-options '<json>'` REPLACES them (needed for gate-off tests).
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first or the script won't run**; read
  via `xcrun simctl spawn <sim> log show --last 40s --predicate
  'eventMessage CONTAINS "CLEWJS"'` (sim's own store; `--start` wants
  LOCAL time — use `--last`). The script is a FUNCTION BODY: `return`
  an async IIFE and the resolved value prints as `CLEWJS smoke ok:
  <value>` — that line is the ONLY channel (page console.log never
  reaches oslog). Asset fetches from the app page need the absolute
  `clew-preview://vault/__clew_assets__/<root>/…` URL; root-relative
  paths 404 on the clew-app origin.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId.
  `renderNote(rel)` returns full rendered HTML — fastest in-app engine
  assertion.
- Opening things from smoke: notes via
  `__clew.actions.openWikilink(name, { mode: "reading" })`; drawings
  and PDFs via `workspaceStore.openFile(path, {})`; **canvases via
  `workspaceStore.openCanvas(path, {})`**. **Same-path tabs are
  REUSED**: a stale wrong-kind tab persists in the workspace and wins
  — walk `workspaceStore.state.root` and `closeTab(id)` first.
- Probe plugin recipe for inside preview iframes (unreachable from the
  app page): temporary vault plugin with a `preview` surface painting
  counts on a `data-clew-keep` banner; it can also DRIVE the document.
  Remove it from the sim vault afterwards. (The PDF viewer page is a
  different, also-unreachable origin — and ALL shadow DOM, per
  upstream's traps: walk shadowRoots, never querySelector.)
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
gitignored). EmbedPDF stages from `vendor/embedpdf/dist` (§1) — the
sync refreshes that mirror along with vendor/clew and vendor/jmarkdown.
The one esbuild warning — duplicate "Highlight theme" key — comes from
vendor/jmarkdown's config files and may change after the engine
re-sync. `sync-upstream` regenerates `AppIcon.png` non-deterministically
— `git checkout --` it unless the upstream icon actually changed. On
the next sync: guarded patches fail the build loudly if an anchor
drifted (pre-checked fine at dbe8348, §3); diff `shared/channels.js`
and `src/main/` for the office subsystem's new shim surface before
assuming the app boots; npm deps do NOT auto-merge.
