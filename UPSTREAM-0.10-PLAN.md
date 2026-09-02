# Upstream 0.10 Sync + On-Disk Contract Parity — Plan for Clew-iOS

**STATUS: in progress (started 2026-09-02).** Two arcs, executed in order:
first the on-disk contracts both apps must share, then a sync that pulls
everything upstream has except the ZetaOffice subsystem. Read `README.md`
and `PORT-PLAN.md` for architecture, `HANDOVER.md` for session state.
`UPSTREAM-0.9-PLAN.md` §0's ground rules apply verbatim: never push
without the owner's OK; never edit `vendor/`; non-iOS improvements go
upstream, recorded as candidates in PORT-PLAN.md; guarded build patches
must FAIL the build when upstream drifts; one branch per phase, chained.

Brings the port from upstream `8422a45` (v0.9.0) to `e64cf06` — **39
commits, 463 files, +8,776 / −1,515**, of which roughly half is the office
suite this plan deliberately leaves unported.

## 1. Arc A — on-disk contract parity (branches `contracts-p1…p3`)

Desktop changed three things about what a vault looks like on disk, and
iCloud means both apps write the same vaults. These land BEFORE the sync
because they are independent of the renderer version, and because the
first one changes how every byte reaches disk.

### A1. Atomic writes — `contracts-p1-atomic`

Desktop (`5b70193`) writes everything durable as temp + fsync + rename,
the temp being `.<basename>.clew-tmp` beside the target. The same shape
on iOS means each app's walks skip the other's temps (dotfile) and a
crash-orphaned temp is swept by the next save of the same file (fixed
name).

On iOS the durable write is Swift's: every mirror write reaches disk
through `VaultStore.write` / `writeBinary` / `updateBinary`. All three
gain one helper, `writeAtomically(_:to:)`: open the temp `O_TRUNC`,
write all, `F_FULLFSYNC` (what libuv gives Node's `fsyncSync` on Darwin;
plain `fsync` as the fallback), close, `rename(2)` — inside the existing
`NSFileCoordinator` `.forReplacing` scope, so file providers still see
one replacement. Symlinks are followed and the target's mode is copied
onto the temp, as upstream does, though neither can occur in an iOS
vault in practice.

Foundation's `write(atomically:)` was already temp+rename, but with
Foundation's own temp name and no fsync; the point of this phase is the
shared shape, not new safety.

### A2. Note history — `contracts-p2-history`

Desktop (`22c59b4`) keeps `.clew/history/<note path>/<stamp><ext>` copies
of the pre-write content of every `.md/.jmd/.canvas`, rate-limited,
pruned, moved along with renames. Reference: `src/main/history.js`.

**The iOS implementation IS the reference implementation.** History is
fs+path code with no Electron in it — the same shape as the indexer,
search and kv-store, which already run verbatim over the vault mirror
through the bundle's `node:fs` alias. Running `history.js` unmodified
over the vfs makes the on-disk format identical by construction, and
lets upstream's nine unit tests port with a path rewrite. The cost is
that `.clew/history/` is mirrored in memory like the rest of `.clew/`
(Swift's walk already includes it; pruning caps it at 40 versions per
edited note). A Swift reimplementation was considered and rejected:
same bytes on disk only by careful re-derivation, and no unit harness
to prove it.

What the vfs and its write-through hooks need for `history.js` to run:

- `fs.readFileSync(p)` with no encoding must return something with
  `.equals()` (the identical-content check). `BufferShim` moves out of
  `globals.js` into `shims/buffer.js`, gains `equals`, and encoding-less
  reads return it — zero-copy view over the same bytes. Nothing in the
  app bundle read without an encoding before, so this is additive.
- `fs.utimesSync` (snapshots are mtime'd for their content time) →
  `vfs.utimes` → new `onUtimes` hook → new bridge op `setMtime`.
- `fs.rmSync` (pruning) → `vfs.rm` → the existing `onRemove` hook,
  which VaultManager now honours for `.clew/history/` paths only → new
  bridge op `remove`. User files still delete only through `trash()`;
  Swift refuses `remove` outside `.clew/history/` as a second guard.
- `fs.renameSync` on a DIRECTORY (`renameHistory`) → a real
  `vfs.rename` (files and dirs, moving `dirs` entries too) → new
  `onRename` hook → the existing bridge `rename`. VaultManager.rename
  drops its hand-rolled mirror move for the same call.

`VaultManager.writeNote` becomes upstream's: `snapshotHistory(rel)` then
write. Three channels, keyed by upstream's constants —
`shared/channels.js` and `main/history.js` are cherry-vendored from
`e64cf06` (the EmbedPDF precedent; the sync overwrites them with
identical bytes). `HISTORY_RESTORE` additionally calls `fileChanged`,
because on iOS a renderer-originated write must ripple explicitly
(desktop gets that from chokidar).

Swift's `rename` also starts moving `knownMtimes` entries along, so a
rename (now two of them, note + history dir) stops echoing as a spurious
change on the next rescan.

### A3. Welcome.md on first open — `contracts-p3-welcome`

Upstream (`dd703e7`) opens a vault's root `Welcome.md` when it opens
with no saved workspace — in the renderer's `EV_VAULT_OPENED` handler
only. iOS boots through the `VAULT_CURRENT` branch (desktop's "window
reload" path), which never fires that event, so the seeded demo vault
came up on an empty pane the first time. `ios-ui.js` applies the same
rule after the boot restore (the restore's `layout-changed` commit, the
hook the compact-sidebar code already uses) and after every
`clew:ev-vault-opened`. Idempotent with the upstream handler once the
sync brings it: whichever runs first opens the note, the other sees a
tab and does nothing.

## 2. Arc B — the 0.10 sync, minus office (branches `sync10-p1…p5`)

| Arc | Upstream change | iOS work |
|---|---|---|
| Note history UI | `clew-history-modal.js`, builtin command, settings toggle, panels.css | none — rides the vendor drop onto Arc A's channels |
| Atomic writes in vendored modules | indexer cache, kv-store, rename-links now call `writeFileAtomic` | **fd-based fs shim** (`openSync`/`writeSync`/`fsyncSync`/`closeSync`/`fchmodSync`), `Buffer` injected into the app bundle, and VaultManager collapsing temp-write + rename-over-target into one bridge write (Swift is already atomic) — see §2.2 |
| First-run | welcome-screen Create/Demo buttons, `VAULT_CREATE_DIALOG`/`VAULT_OPEN_DEMO` | two handlers: create = mkdir in Documents, demo = the seeded vault (Swift already seeds it) |
| Meta Bind widgets are Web Awesome | `29e3a3b` + `8e2fe7d` + `8317184`: engine emits `wa-*` elements, `preview-client/wa-bundle.js` + `wa-styles.css` build to `wa.{js,css}`, fetched lazily from `/__clew_preview__/` by `meta-bind.js`; new npm dep `@awesome.me/webawesome` | **new dep + two preview bundles** in build.js; SchemeHandler's `__clew_preview__/` route becomes the same closed set (api, client, wa.js, wa.css) |
| Editor fill-paragraph / auto-fill | `editor/fill.js`, settings, registry | none (vendored); port `fill.test.js` |
| Engine: MetaPost labels as glyph paths, libgs detection | `dfec137`, jmarkdown `config-manager.js` + `metapost.js` | none (desktop-cached SVGs in the seed vault re-hashed; TikZ/MetaPost still cannot run here) |
| `openWikilink`: a URL is not a note name | `9be1252` | none (vendored) |
| Explorer folders anchor hierarchy, demo content, canvas-cards trap fix | renderer + demo-vault | none (vendored + seed) |
| Engine re-sync | jmarkdown at `at-migration@748bd70` | watch the duplicate-key esbuild warning; re-run engine tests |
| `smoke/` committed | desktop scenarios | not copied; mined for iOS smoke ideas |
| **ZetaOffice** | main: office-convert/slot/thumbs, zeta-assets/icons; renderer: office-dock, file-view offer panel, settings section, canvas nodes, tab bar; preview: office-embed, zeta-page/thread; engine: wikilinks office embeds; 11 channels | **not ported** — §2.1 |

`shared/channels.js` gained 17 constants; `package.json` changed
upstream (npm deps do NOT auto-merge — diff it in p1). All 9 guarded
patch anchors were pre-checked at `dbe8348`.

### 2.1 What "except ZetaOffice" means mechanically

The vendor mirror stays dumb — `sync-upstream` copies the office files
like everything else, and the app bundle carries whatever the renderer's
module graph imports (office-dock, the offer panel, the embed bridges).
What is NOT built: the `zeta-page.js` / `zeta-thread.js` preview
bundles, any wasm download, any LibreOffice boot. LibreOffice-in-wasm is
~1.6 GB resident on desktop; the iPad content process is killed well
short of that, and the decision to spike it at all is the owner's.

So the office surface degrades honestly instead of dead-ending:

- Channel stubs, in the pattern of `PDF_FONTS_*`: `OFFICE_ENGINE_STATUS`
  answers "not installed, no desktop LibreOffice"; `DOWNLOAD`/`REMOVE`/
  `CONVERT_PDF`/`WRITE`/`SLOT_*` throw "not available on iOS";
  `OFFICE_THUMBNAIL` answers `{ ok: false, reason }` so embeds paint
  their placeholder card; `CONFIRM_DISCARD` answers `'cancel'` (only
  reachable with a dirty office document, which cannot exist here).
- `OFFICE_OPEN_EXTERNAL` → the `quickLook` bridge: iOS's native
  read-only office viewer IS the "open externally" rung.
- **`OFFICE_THUMBNAIL` is real** (decided in p2): `QLThumbnailGenerator`
  renders Word/Excel/PowerPoint with the system's own previewers, and
  the PNG is cached exactly where desktop caches its own —
  `.clew/cache/office-thumbs/<rel>.png`, by mtime — so a vault shared
  over iCloud reuses either side's thumbnails. OpenDocument formats have
  no previewer and report the reason. Office embeds in notes and canvas
  office nodes therefore show a picture, not an error string.
- Three guarded patches: the settings view's office section is dropped
  (like the CJK font section); the office tab's download offer says
  what iOS does instead and its button reads "Open in Quick Look" (the
  upstream offer's download button would spin forever, since
  `downloadEngine` never repaints after a rejected download); the canvas
  node's Thumb/Live choice is dropped (Live would be a blank frame).
- `VAULT_CREATE_DIALOG` asks the name in a native sheet and makes the
  folder in Documents; `VAULT_OPEN_DEMO` opens the seeded vault.

### 2.2 `writeFileAtomic` over the vfs

After the sync, three vendored modules the app bundle runs (indexer,
kv-store, rename-links) call `writeFileAtomic`, which uses fd APIs the
fs shim never had, references `Buffer` (absent from the app page), and
renames a temp over its target. Rather than patch three call sites:

1. `fs.openSync/writeSync/fsyncSync/closeSync/fchmodSync/realpathSync`
   in the shim over a small fd table; `closeSync` commits the buffered
   bytes as one `vfs.write`.
2. `Buffer` injected into the app bundle (and the services test bundle)
   from `shims/buffer.js` — the identifier only, no globals.
3. VaultManager's hooks recognise the contract's own temp shape: a write
   to `.<name>.clew-tmp` never reaches the bridge, and a rename FROM
   such a temp becomes a bridge `write` of the target. The vendored
   module gets atomic semantics; Swift performs the one real atomic
   write. A services test asserts exactly one bridge write per
   `writeFileAtomic` and no temp on disk.

### 2.3 Phases

- **`sync10-p1-vendor`** — `npm run sync-upstream` at `e64cf06`;
  `git checkout --` the AppIcon; diff package.json; §2.2; register any
  new engine extension (compare `main/render-service.js#writeEngineConfig`
  against `src/shim/engine-config.js`); refresh already-ported suites
  that upstream evolved; build + tests green.
- **`sync10-p2-office`** — §2.1: stubs, QuickLook routing, settings
  patch, offer-panel decision, VAULT_CREATE/OPEN_DEMO handlers.
- **`sync10-p3-features`** — simulator verification of what rides the
  drop. DONE 2026-09-02, all by content or screenshot on a clean
  install: history modal lists a fresh snapshot with Restore; settings
  carry the history row and the fill-column controls, no PDF-viewer or
  office sections; Welcome greeting on first launch; fill-paragraph
  wrapped a 60-word line to six lines ≤ 69 columns on disk; explorer
  folders bold and anchored; a `.docx` tab shows the iOS sentence and
  "Open in Quick Look", which presents the document; an office embed
  in a note and a canvas office node both show the Quick Look
  thumbnail (600×980, cached at upstream's path); the Widgets guide
  renders thirteen kinds of `wa-*` element (wa.js through the closed
  set); Dashboards renders queries + widgets + charts with no errors;
  an `https://` target handed to openWikilink creates no note;
  VAULT_OPEN_DEMO answers the seeded vault and VAULT_CREATE_DIALOG
  presents the native name sheet.
- **`sync10-p4-tests`** — port `atomic-write`, `fill`, and the office
  additions to `workspace-tree`; re-diff every ported suite.
- **`sync10-p5-verify`** — clean-install sweep + regressions; PORT-PLAN
  milestone; README gaps; HANDOVER rewrite; memory.

## 3. Seam-shaped questions (answered during the phases)

1. Does the history modal need anything from `EV_FILE_CHANGED` timing
   that iOS's explicit `fileChanged` after restore does not provide?
2. `zeta-manifest.json` — imported by the renderer's settings view, or
   main-only? (Bundles fine either way; only matters for the patch.)
3. Office embeds inside canvases: does `node-content.js` reach for
   `zetaOfficeUrl` eagerly (a 404 in the scheme handler) or only on
   "make live"?
4. `.clew/history/` on the rescan walk: 40 extra stats per actively
   edited note every 20 s — measure on the 5k stress shape before
   worrying.

## 4. Definition of done

1. Arc A: services tests prove snapshot/list/read/restore/rename/prune
   on disk through the channels; upstream's history suite ported green;
   simulator shows `.clew/history/…` by content and no `.clew-tmp`
   survivors; a clean install greets with Welcome.md.
2. Arc B: `vendor/` + `seed-vault/` at `e64cf06`; every table row
   demonstrated in the simulator or deferred with a reason; office
   surfaces degrade honestly, nothing reaches an unknown channel.
3. No vendored file edited; iOS deltas are guarded patches or `src/`/
   `ios/`; upstream candidates recorded in PORT-PLAN.md.
4. Docs updated; nothing pushed.

## 5. Deferred, unchanged

The ZetaOffice runtime itself (a feasibility spike is the owner's call:
wasm size, memory, the iPad content-process limit); `\citefile` BibDesk
attachments; third-party notices surface; native CJK font download;
Xiaolai CJK prune; ```kanban fence touch drag; "Move to folder…"
long-press; empty folders in explorer; iCloud conflict surfacing; TikZ
preamble-hash reuse; stale recents pruning; canvas toolbar undo/redo.
