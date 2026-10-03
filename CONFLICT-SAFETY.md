# Edit-conflict safety for synced vaults

FEATURE-IDEAS #1, built 2026-10-03 on branch `conflict-safety`. The rule:
when the same note is edited on two devices, neither version is ever lost
silently. Both go to `.clew/history` first, under history.js's naming, so
the note-history browser lists them. Then the user chooses.

## What is detected, and where

| Case | How it shows itself | Detected by |
|---|---|---|
| Another device's edit lands between two rescans, then the iPad saves | Nothing: the save would overwrite it unseen | `VaultStore.write`: the disk mtime is not the one this app last saw, and the text differs. Nothing is written; the answer is `{conflict, disk}` |
| Another device's edit lands while the editor has unsaved edits | The shared editor's banner ("Load disk version" would drop the unsaved text) | `editorPool` `conflict-changed`, hooked by `conflict-sheet.js` |
| iCloud Drive's own conflicts | `NSFileVersion` unresolved conflict versions | The vault walk reads `ubiquitousItemHasUnresolvedConflictsKey` on open and on every rescan |
| Dropbox (File Provider) | `Note (Name's conflicted copy YYYY-MM-DD).md` beside the note | A name scan on open and on every tree change |
| git through Working Copy | `<<<<<<<` / `=======` / `>>>>>>>` in the note | A text scan on open, on tree changes, and as each note changes. These get a notice only: the markers are the note's own text |

The guard covers user files only. Vault state (`.clew/`, `clewdata.json`)
is never guarded.

## The choices

The sheet (`conflict-sheet.js`) offers Keep Mine, Keep Theirs, Keep Both
and Compare, a line diff with unchanged runs folded. iCloud and Dropbox
cases also offer Later; the palette's "Review conflicting versions…"
brings deferred ones back.

- **Keep Both:** the other version is saved beside the note as
  `Note (conflict YYYY-MM-DD).md`, deduplicated with ` 2`, ` 3`.
- **A refused save holds the note.** Later saves stay in the mirror and
  none is written. A newer disk version arriving meanwhile becomes the new
  "theirs" and is also kept. Keep Mine writes the latest of the user's
  text with `force`.
- **iCloud:** both texts go to history, and the files are flushed. Only
  then does native mark the versions resolved and remove them
  (`resolveCloudConflict`), never before the choice.
- **Dropbox:** Keep Mine or Keep Theirs moves the copy to the Trash, after
  history. Keep Both leaves both files.

## A race fixed along the way

A rescan used to snapshot the known mtimes on the main thread, walk on
the IO queue, and assign the new ones back on main. A save landing in
between was forgotten. Before this change that only caused a harmless
echo. With the write guard it would have caused a false conflict. Rescans
now run wholly on the IO queue, where every write runs. The walk reports
iCloud conflicts through a callback, so the global-plugin walk no longer
adds its paths to the vault's set.

## A false conflict found in integration, and fixed

`AtomicFile` replaces a file with a POSIX `rename`, which Foundation
doesn't see. A URL that has read its resource values keeps answering the
old mtime. The guard read the mtime before writing and recorded it on the
same URL afterwards, so it recorded the pre-write time. The next save
then looked like another device's edit: a false conflict on about every
second save.

The first round of simulator tests missed it. Continuous typing keeps
resetting the 1 s autosave, so it saved only once. The integration pass
found it: a save made just before a vault switch was refused.

Mtimes now come from stat(2) (`AtomicFile.mtimeMs`). The Swift test
writes three times on one URL, and the simulator test saves ten times,
each after a pause longer than the autosave delay: 0 conflicts.

## Verified

- **Node:** 719 JS tests, 13 of them new: 5 on the pure functions in
  `conflict-text.test.js`, and 8 in `services.test.js` against a fake
  bridge that models the guard and NSFileVersion. They cover a refused
  save, held writes, mine/theirs/both, a newer version while held, the
  same edit on both sides (no conflict), a Dropbox copy, git markers, the
  iCloud ordering (history writes before `resolveCloudConflict`), and a
  link rewrite through upstream's atomic write.
- **Swift:** 154 + 23 tests. The app build succeeds.
- **Simulator** (iPad Pro 11" M4), with the host playing the other device
  by editing files in the container:
  - **Refused save:** the Mac's text was not overwritten. The sheet's
    buttons are 44 pt and it sits inside the viewport; Compare showed 2
    lines only in mine and 3 only in theirs. Keep Both left the iPad's
    text, including what was typed while held, in the note, and the Mac's
    in `Conflict Demo (conflict 2026-10-03).md`. History has both.
  - **Dirty editor:** Keep Both resolved the banner and wrote the sibling;
    history has both.
  - **git markers:** the notice appeared.
  - **Dropbox copy:** found by the next rescan. Keep Theirs put the copy's
    text in the note and removed the copy; history has both.
  - **iCloud:** both native calls answer.
  - **45 s of typing across two timer rescans:** 0 false conflicts.
- Upstream's banner now wraps on iPad, and its buttons are 44 pt.

**Not measured:** real iCloud conflict versions. The simulator has no
iCloud account, so `cloudConflictVersions`/`resolveCloudConflict` were
checked only on a file without versions, plus the fake-bridge tests. A
device with two iCloud-signed-in machines is the real test.

**Known limit:** a note still evicted (only `.Note.md.icloud` is local)
is written without a guard. iCloud then keeps the server version as a
conflict version, which the next rescan offers.

## What the desktop analogue needs (Clew-app)

1. **A guarded write in main.** `NOTE_WRITE` (and upstream's
   `writeFileAtomic` callers that touch notes) should remember the mtime
   it last read or wrote per path. If the disk's mtime differs and the
   text differs, it should refuse with `{conflict, disk}` and accept
   `force`. Chokidar makes the window small, not zero: a save inside the
   autosave debounce, or before `awaitWriteFinish` fires, can still
   overwrite a sync client's write.
2. **The same hold-and-ask in the renderer.** Hold the note, keep both in
   history, and offer the sheet. The text helpers in `conflict-text.js`
   are platform-neutral and could be shared as they are.
3. **The banner's "Load disk version"** should snapshot the unsaved text
   to history before it reloads. iOS does this from outside, through
   `conflict-changed`; upstream could do it in `pool.resolveConflict`.
4. **Dropbox copies and git markers** are detectable on any platform. The
   scans could live in main's watcher or indexer.
5. **iCloud on the Mac:** Electron has no `NSFileVersion`. Seeing iCloud's
   conflict versions would need a small native helper, such as a Swift CLI
   or an N-API addon. How Finder-level iCloud Drive surfaces conflicts for
   apps that don't use NSDocument is unmeasured.
