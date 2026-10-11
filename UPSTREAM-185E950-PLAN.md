# Upstream sync to Clew-app 185e950 — plan and record

**STATUS: EXECUTED 2026-10-11; every acceptance check green in the
simulator.** Pinned by Clew-boss when the owner's freeze for the colon work
lifted. Clew-boss approved the iPad port of "Convert this vault" with
conditions (a)–(i), each answered below. Main is fast-forwarded to p4 with a
build commit on top. The push waits for the owner's word typed in this
window.

The chain, off main 0599ee0 (the HTML share):
- `sync185e950-p1-vendor`: 11155c0 (verified by Clew-boss).
- `sync185e950-p2-build`: 1976eb1.
- `sync185e950-p3-port`: 418fb42 (big-vault rescans), 00e4d6b ("Convert
  this vault").
- `sync185e950-p4-verify`: this record.

**PIN: Clew-app `185e950`.** It was copied from `git archive 185e950`.
`diff -rq` against the archive shows no difference in vendor/clew,
vendor/jmarkdown (src and package.json; at-migration 851e8e8),
vendor/embedpdf, vendor/default-stamps or seed-vault. The range
f959799..185e950 has 10 commits; 47bbd64, bbde7fc and 0aebcf8 are docs.

**Version:** 0.12.0, unchanged. mp-tikz-wasm unchanged (v0.4.0 +
Ghostscript, release-staged).

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| Colon phase 1: 42d6930 (numbering reads `@begin`'s sigils), acd9c27 (Inserts write the @ forms), 97d7f0d (the Game Matrix sample) | Vendored renderer code; nothing to port. p2 adds a worker test: every Insert's @ form, `@today` and a theorem draw through the iPad's engine (TiKZ is the preview's, Mermaid, the 2×2 game, Mathematica refused by name, the theorem numbered, no @ form left as text). |
| 65ef069: jmarkdown 851e8e8 (colon-to-at.js; `@begin(print)` keeps its LaTeX break) | p2: bundles as is. Every build.js anchor holds; index.js unchanged. colon-to-at.js is reached only by the conversion. |
| Colon phase 2, "Convert this vault": fcc7faf, ae6787e, 185e950 | p3: **ported** (below). The commands are in the palette; the iPad has no app menu. |

## Phase 2 on the iPad: what was built

Upstream's converter (main/colon-conversion.js) runs **verbatim in the
app page**, over the vault mirror, as history.js and the indexer already
do. The sheet is the vendored renderer/colon-conversion.js. What the iPad
adds is desktop's ipc.js adapter, src/shim/colon-conversion.js, over the
iPad's VaultManager and native code (ColonConversion.swift).

| Desktop | iPad |
|---|---|
| root = the vault's folder | a virtual `/colon-vaults/<hash of the device's vault identity>/<name>`: no device path anywhere, and stable when the app container moves (a), as trust's identity is |
| listNotes: the tree walk | one sliced pass over the mirror, with the same excludes; .md/.jmd, no Excalidraw drawing |
| read: the file | the mirror's bytes, which are exact for UTF-8: Swift keeps a BOM and CRLF. A note that is not UTF-8 is mirrored as "", so its bytes come from native before each scan and it is refused by name, as on desktop |
| readAsync | native `readNoteBytes`: the device now, never the mirror |
| write: writeNoteAsync | VaultManager.writeNoteAsync: history, then the atomic device write (AtomicFile, F_FULLFSYNC) through the vault's ordered queue, awaited; text, or exact bytes for undo; then the change announced as desktop's watcher does |
| keepVersion | history.js#keepVersion over the mirror |
| folder `.jmarkdown/config.json` | the mirror skips dot-folders, so native lists them before each scan (the mirror's own walk rules) and they are laid under the virtual root, where the converter reads them. The engine never sees them |
| `~/.jmarkdown/config.json` | none on the iPad: a path that does not exist |
| backups in userData | `Application Support/colon-conversion/<vault>-<hash>/<time>/` (ColonBackupStore): never in a vault or iCloud Drive; in the device backup (c). The converter writes them with fs under `/colon-conversion`, and VaultManager writes each one through on the same queue as the notes, so every backup and the manifest are on the device before the first note is written |
| the backup's path in the sheet | "Clew's own storage on this iPad (outside the vault)" (b) |

**Build** (scripts/build.js `colonPatches`, applied to the app bundle and
the test bundle alike):
- a `node:perf_hooks` shim (monitorEventLoopDelay from a timer's lateness);
- `tick` yields through a MessageChannel, since the page has no
  setImmediate;
- `process.memoryUsage` guarded (RSS is measured natively instead);
- **SLICE_MS 8 → 4** (d).

**The shims keep a BOM, as Node does** (h). Covered: buffer.js `toString`,
fs/fs-promises readFile with an encoding, createHash's `update`, and
VaultManager's write-through and readNote. Before, a BOM note was refused
as "not UTF-8", and its history lost the BOM. JSON reads are unchanged.
The full suite is green, and no other caller's behaviour changed.

### Clew-boss's conditions

| | Condition | Met by |
|---|---|---|
| (a) | backups survive a relaunch and an app update | the virtual root from the device identity. Test: a relaunch with the container moved finds and undoes the conversion, and another vault sees none. Simulator: the app updated (container FE41599E → B1CAF091), relaunched, LAST found the conversion, Undo restored 3/3 |
| (b) | no device path reaches the renderer | the backup said in words; errors and write failures scrubbed. Test: no vault path, /var/mobile, Containers or CoreSimulator in any COLON reply, event, error or manifest, including a device error naming its path. Simulator: none in any sheet text |
| (c) | backups stay in the device backup | Application Support, not excluded |
| (d) | frames during scan and apply | below; SLICE_MS shrunk to 4 |
| (e) | peak phys_footprint ≤ ~1 GB | ≤ 513 MB (WebContent), ≤ 288 MB (the app) |
| (f) | note bytes only at UNDO | LAST and FINISH read manifests; UNDO loads only the notes that conversion wrote, 200 a call. Tested |
| (g) | 4,001-note apply under ~3 min | 118 s; no native batching needed |
| (h) | the BOM change named | above |
| (i) | measurements, tests | below; tests/colon-conversion.test.js (7), ios/Tests/ColonConversion (31 checks) |

## Results (simulator, iPad Pro 11" M4, iOS 18.1; ALL GREEN)

Driven by upstream's smoke/colon-convert-scenario.js, nearly verbatim
through the sheet's own buttons. Its options come from the smoke hook (the
mirror does not carry the dotfile), and it adds an undo frame count.
Memory is phys_footprint, sampled every 250 ms from the host
(`footprint --sample`), for the simulator's WebKit content process and the
app.

**Frames.** The simulator draws at 60 Hz. Its idle baseline, with the 5k
vault open and nothing running, is median 17 ms, p99 17 ms, max 33 ms, and
399 of 599 frames read over 16.7 ms. "p99 ≤ 16.7" therefore cannot be met
even at rest. The figures below are against that baseline: p99 at about
one frame period, and nothing over 50 ms that is the conversion's.

**Demo vault round trip** (upstream's: cycles none and all, Guide/Live
Edit.md open in source mode):
- The sheet: `Same output (3)`, `Output changes (1)`, button "Convert all
  but the output changes (3)". Its words agree with the counts.
- `editor converted=true dirty=false disk=doc`; after undo `doc=original`.
- `again none` gives `Output changes (1)`; `again all` gives nothing left.
- `undo identical=true notes=60/60` both cycles. Every file but `.clew/`
  and the kv store hashed natively before and after: **byte-identical (96
  files)**.

**make-colon-vault.mjs, 5,006 notes** (restricted: opened after first
launch):
- The sheet: `Same output (10,001)`, `Output changes (2,000)`, `Notes that
  load directives (6)`, `Left as written (2,000)`, `Notes not converted
  (1)`.
- `loads Loads/Header.md by=header`;
  `Loads/Folder/Note.md by=folder(Loads/Folder/.jmarkdown/config.json)`.
  The folder config came from native.

| Run | Wall | Frames in the phase | Peak footprint |
|---|---|---|---|
| Dry run | 1.8 s | 86: over 20 ms 2, over 33 ms 1, max 42 | 445 MB / app 162 MB |
| Convert, default (4,001 notes, 10,001 directives) | 117.9 s | 7,053: p99 20, over 20 ms 32, max 39 | 340 MB / 121 MB |
| Undo | 94.3 s | 5,631: p99 20, max 156 (*) | 513 MB / 115 MB |
| Dry run (second cycle) | 2.0 s | 88: max 35 | 435 MB / 193 MB |
| Convert, every box (5,003 notes, 12,007 directives) | 149.1 s | 8,927: p99 20, over 20 ms 64, max 41 | 359 MB / 243 MB |
| Undo | 112.5 s | 6,717: p99 21, max 174 (*) | 503 MB / 209 MB |

- Both undos give `identical=true notes=5006/5006`. Natively, all 5,007
  files are **byte-identical** to before.
- Three dry runs straight through IPC, without the sheet: the worst frame
  25–26 ms, none over 33.
- (*) The one long frame in each undo is not the conversion's. It is the
  indexer's cache save (vendored main/indexer.js `#persistSoon`): 2 s after
  the last changed file it stringifies the whole index into
  `.clew/cache.json`, synchronously. Here it falls 2 s after the convert's
  last write. Probed alone, undo's own frames peak at 45 ms, and the
  153 ms frame comes 2 s after its end. Any save in a vault this size does
  the same today.

**Edge cases** (Demo vault):
- A Latin-1 note with `:::note` is refused by name ("it is not UTF-8 text,
  and writing it back would change its bytes"), its bytes untouched.
- A note starting with a BOM is converted, the BOM kept on disk.
- A note written natively behind the mirror after the dry run is
  `changed`, planned again, and not written. The other edit is still on
  disk.

**After an app update**:
- Converted, then the app installed over itself; the container moved to a
  new path.
- Relaunched, COLON_LAST found the conversion, and Undo restored 3/3.
- Every file is byte-identical to before, except the note another
  "device" edited, which keeps that edit.

**A conversion cut off** (unplanned):
- A smoke ran in the wrong vault and its run was terminated mid-convert.
- Its manifest was on the device. Undo, after the relaunch, restored
  4,001/4,001, and the vault is byte-identical to before.

## Found on the way

- **Fixed (418fb42): a big vault's rescans never drained.**
  - One rescan of 5,006 notes took 57 s: each file's listing asked
    iCloud's conflict flag, one synchronous File Provider round trip per
    file.
  - The 20 s timer stacked rescans on the serial IO queue every write
    waits on. The first convert managed 4 writes in ten minutes; nothing
    was written out of order, and the vault was unchanged.
  - Now the key is asked only of an iCloud vault, and a timer rescan is
    skipped while one is queued. The rescan takes 46–65 ms.
  - Editor saves in big vaults waited behind it too.
- **The indexer's cache save** (above): a 150–175 ms frame 2 s after the
  last change, in a 5,006-note vault. It is upstream's indexer, the same
  on desktop's main thread; the iPad has no other thread for it. An
  upstream candidate: save the cache off the frame, or in slices.
- **The sheet's folded 4,001-note list**, opened, lays out at a median
  56 ms a frame for about 2.5 s (max 157). It is the vendored sheet:
  every frame lays out the whole growing list, as Clew-app's own notes
  say. Desktop measured 4 frames over 16.7 ms at 120 Hz. An upstream
  candidate (content-visibility, or a windowed list).
- **The converter writes its first manifest before any note.** A
  conversion cut short lists every planned note as written. Undo then
  leaves each never-written note alone as "changed", since its bytes are
  still the originals. This is upstream's design ("a note never written is
  not 'as written'"). Kept.

## iPad checks

- A real iCloud Drive vault: a dry run and a convert, so the conflict key
  is asked there, and the rescan's time is noted.
- Convert and Undo on the device in a large vault; frames at 120 Hz.
- The sheet under a finger: ticking boxes, a folded list, Esc from a
  hardware keyboard.
- An open note converted in its editor, then Undo, on the device.
