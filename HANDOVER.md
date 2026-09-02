# Handover — 2026-09-02 (contract parity + 0.10 sync minus office: DONE, unpushed)

Session-rollover state, upstream-style: rewritten each session, kept
short. Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** — trust those first. `UPSTREAM-0.8-PLAN.md`,
`UPSTREAM-0.9-PLAN.md` and now `UPSTREAM-0.10-PLAN.md` are **history**:
executed in full; read them for the reasoning behind a decision.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Also in Claude's memory.)

## 1. Where things stand

Six layers of finished, unpushed work, every phase tip green on its own
(`npm test` 291, `npm run build`, xcodebuild clean):

```
main                6f75e34   (10 ahead of origin, UNPUSHED, deliberately not moved)
 └ …0.8 chain… sync-p5-verify (edcd261)
    └ …0.9 chain… sync09-p5-verify (322224e)
       └ canvas-delete-button  e618a00
          └ embedpdf-vendor  d2e7beb
             └ contracts-p1-atomic 195fd96 → contracts-p2-history 48b4c1f → contracts-p3-welcome fe4cb2c
                └ sync10-p1-vendor c7ae103 → sync10-p2-office f4896a2 → sync10-p3-features 4c6d084
                   → sync10-p4-tests a28b17c → sync10-p5-verify   ← TIP: review and merge
```

- **0.8 / 0.9 syncs, delete button, EmbedPDF OCG** — unchanged from
  the previous handover; all simulator-verified.
- **On-disk contract parity** (`contracts-p1…p3`, 2026-09-02) — the
  three things desktop changed about what a vault looks like on disk,
  matched exactly because both apps write the same iCloud vaults:
  1. *Atomic writes*: every Swift write path is temp + `F_FULLFSYNC` +
     rename with desktop's own temp name `.<basename>.clew-tmp` beside
     the target (`AtomicFile.swift`). Proven standalone on macOS and
     by content in the sim (zero temps after every scenario).
  2. *Note history*: `.clew/history/<note path>/<stamp><ext>` — produced
     by upstream's `history.js` run VERBATIM over the vault mirror (like
     the indexer/kv-store), so the format is identical by construction
     and upstream's nine unit tests port with a path rewrite. The
     mirror grew what that needed: Buffer-returning encoding-less
     reads, `vfs.utimes`/`vfs.rename` with hooks, bridge ops `setMtime`
     and `remove` (`.clew/history/` only, refused elsewhere on both
     sides). Sim-verified by content: interval gate, pre-image, forced
     restore, rename carrying the dir, pruning with `-N` counters, a
     backdated note's snapshot mtime'd 2025-09-01 on disk.
  3. *Welcome.md on first open*: `ios-ui.js` applies upstream's rule
     after each restore commit, because iOS boots through the
     `VAULT_CURRENT` branch that never fires `EV_VAULT_OPENED`. Clean
     install opens on Welcome.
- **0.10 sync minus office** (`sync10-p1…p5`) — `vendor/` + `seed-vault/`
  at upstream **`e64cf06`** (39 commits on from 8422a45). New dep
  `@awesome.me/webawesome` + two preview bundles `wa.{js,css}` (Meta
  Bind widgets are Web Awesome components; SchemeHandler's
  `__clew_preview__/` route is now upstream's closed set); the vendored
  modules' `writeFileAtomic` runs over the mirror (fd APIs in the fs
  shim, `Buffer` injected into the app bundle, VaultManager collapses
  temp+rename into the one bridge write Swift already makes atomic);
  history modal + settings toggle, fill-paragraph/auto-fill, explorer
  anchoring, Dashboards/Widgets guides, first-run Create/Demo channels
  (native name sheet; the seeded vault), the openWikilink URL guard,
  engine re-sync. **ZetaOffice runtime NOT ported — Quick Look stands
  in** (§2). All nine + three guarded patches anchored.

The iPad sim (90DCB612…) has the tip's build installed (p3–p5 changed
no code). The sim's Demo Vault carries test residue (`Memo.docx`,
`Office Embed Test.md`, `Office Canvas.canvas`, `Fill Test.md`,
`.clew/history/…`) — uninstall + reinstall to reseed. Working tree clean
after this commit.

## 2. Decisions the owner should know about (all reversible)

1. **Office = Quick Look.** Upstream's LibreOffice-in-wasm (~1.6 GB
   resident) is not ported and the decision to spike it is yours. Every
   office surface upstream draws stays truthful: engine status "not
   installed, no desktop LibreOffice"; the office tab shows one
   sentence + **"Open in Quick Look"** (read-only system viewer);
   **`OFFICE_THUMBNAIL` is real** — `QLThumbnailGenerator` renders
   Word/Excel/PowerPoint and the PNG is cached at upstream's own path
   (`.clew/cache/office-thumbs/<rel>.png`, by mtime) so note embeds and
   canvas office nodes show a picture and iCloud vaults reuse either
   side's; download/remove/convert/save/slot answer with a reason.
   Three guarded patches drop controls that would lie: the settings
   office section, the tab's download offer (upstream's button would
   spin forever — `downloadEngine` never repaints a rejected download;
   upstream candidate in PORT-PLAN), the canvas node's Live choice.
   Residue: `![[x.docx|live]]` in a note still emits a live iframe →
   blank box (engine-emitted; not patchable here); ODT/ODS/ODP have no
   Quick Look previewer (embed shows the reason). QL thumbnails are
   sim-proven (1.1 s for a docx) — worth a device timing check.
2. **History runs upstream's module over the mirror**, so
   `.clew/history/` is mirrored in memory like the rest of `.clew/`
   (pruning caps it at 40 versions per edited note). Measure on the 5k
   stress shape before worrying; the alternative (Swift reimplementation)
   was rejected for bytes-by-re-derivation with no unit harness.
3. **First-run Create/Demo**: implemented (native sheet; seeded vault)
   but the welcome screen is practically unreachable on iOS — boot
   always opens the last vault or the seeded demo. The manual's
   first-launch text needs an iOS caveat (§4).

## 3. Upstream state

`../Clew-app` main = **`e64cf06`, tree CLEAN** (checked at the end of
this session) — exactly what we vendored; nothing pending. `../Clew-docs`
at `e618ed9`. The next sync will overwrite `vendor/clew/main/history.js`
and `shared/channels.js` with identical bytes (they were cherry-vendored
early for Arc A). `vendor/embedpdf` unchanged since de45fe7.

## 4. Open items

1. **Device verification, then merge + push** = a TestFlight release
   covering everything in §1. Hardware-specific: Pencil finger-pan feel,
   Excalidraw with Pencil, per-scene Pdfium memory, hardware-keyboard
   chords + **Alt-Q fill-paragraph**, Quick Look + QL thumbnail timing,
   the history modal on the iPad, Web Awesome widgets on touch (sliders,
   colour picker). Suggested merge: fast-forward `main` to
   `sync10-p5-verify`.
2. **Manual caveats to write in `../Clew-docs`** (not touched here — the
   shared manual is the owner's): `note-history.html` — iOS matches the
   format fully, both apps snapshot the same vault; `getting-started
   .html` #first-launch — iOS seeds and opens the demo vault itself,
   no welcome screen; new vaults are folders in Files/Documents or
   "Open another vault…"; `vaults-and-files.html` `.clew/` table — iOS
   also writes `cache/office-thumbs/`; the office chapter — iOS is
   read-only Quick Look, thumbnails via Quick Look, no editing;
   `settings-and-hotkeys.html` — the `history` key is honoured on iOS.
3. **`alert()` is silent on iOS**: the renderer's export-failure
   `alert(...)` (builtin.js) needs a `WKUIDelegate`
   `runJavaScriptAlertPanel` to show; WebHost has none, so an export
   failure (LaTeX export on iOS always fails) shows nothing. ~10 lines
   of Swift; pre-existing, not a sync regression.
4. Possible follow-ups the owner has seen but not requested: canvas
   toolbar undo/redo buttons (PORT-PLAN touch item 6, remaining half);
   Pencil long-press → contextmenu in select/pan tools; "New drawing" in
   the explorer #rootMenu; a THIRD-PARTY-NOTICES surface (upstream now
   has one; ours would add Web Awesome, the OCG build, chart.js).
5. Deferred, unchanged: `\citefile` BibDesk attachments; native CJK
   font download; 12 MB Xiaolai CJK prune; ```kanban fence touch drag;
   "Move to folder…" long-press; empty folders in explorer; iCloud
   conflict surfacing; TikZ preamble-hash reuse; stale recents pruning.

## 5. Verification kit (works, use it)

- `npm test` — 291 green. `node tools/render-note.mjs <vault> <note>
  [--fragment]` reads the vault's own vault-settings by default;
  `--vault-options '<json>'` REPLACES them.
- Smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
  '<js>'` — **terminate the app first**; read via `xcrun simctl spawn
  <sim> log show --last 40s --predicate 'eventMessage CONTAINS
  "CLEWJS"'`. The script is a FUNCTION BODY: `return` an async IIFE; the
  resolved value prints as `CLEWJS smoke ok: <value>` — the ONLY channel.
  **No backslashes in the smoke JS** (regex escapes get eaten by the
  quoting — use character classes); a stray `"` inside a `-m` commit
  message likewise breaks the shell — use `git commit -F file`.
- App-page surface: `__clew` = workspaceStore/vaultStore/editorPool/
  settingsStore/ipc/actions/registry/officeDock; `__clewNative` =
  renderNote/renderFragment/externalDiff/flush/sessionId.
  `renderNote(rel)` is the fastest engine assertion; `registry.
  runCommand('file:history' | 'app:settings' | 'editor:fill-paragraph')`
  drives UI. Notes via `actions.openWikilink(name, { mode })`; drawings
  need the FULL name `X.excalidraw.md` (the explorer hides `.md`);
  PDFs/office via `workspaceStore.openFile(path, {})`; canvases via
  `openCanvas`. Same-path tabs are REUSED — `closeTab` first.
- On-disk checks: `xcrun simctl get_app_container <sim> <bundle> data`
  (rotates on every install); `ls` in this shell is GNU — use
  `/usr/bin/stat -f "%Sm %N" -t "%Y-%m-%d %H.%M.%S"` for mtimes.
  `textutil -convert docx` makes a real Word file for office probes.
- Preview iframes and the PDF viewer page are unreachable from the app
  page (probe-plugin recipe in the previous handover still applies; all
  PDF viewer DOM is shadow DOM). Canvas nodes ARE app-page DOM
  (`.canvas-office-thumb img` etc.).

## 6. Build

`export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` first.
`npm run build`, then `xcodebuild -project ios/Clew.xcodeproj -scheme
Clew -destination 'id=<sim>' -derivedDataPath build/DerivedData build`.
Twelve guarded patches in scripts/build.js fail the build loudly on
drift (editor autofocus, explorer/tab touch drags, canvas webview,
settings PDF-viewer + office sections, preview iframe rebuild, preview
client ready/pageshow + pdf-core handles, office tab offer + button
label, canvas node Live choice). `buildPreviewClients` also emits
`wa.js`/`wa.css`; the app and services bundles inject `Buffer` from
`shims/buffer-inject.js` (never the worker's globals). Office files are
vendored but `zeta-page.js`/`zeta-thread.js` are NOT built and no
`clewzeta`/`zeta` asset root exists. `sync-upstream` regenerates
`AppIcon.png` non-deterministically — `git checkout --` it. npm deps do
NOT auto-merge (`@awesome.me/webawesome` was added by hand; the lockfile
matters for Xcode Cloud's `npm ci`).
