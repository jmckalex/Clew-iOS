---
tags: [guide]
---
# Vaults and Files

A **vault** is any folder of `.md`/`.jmd` files. Open one from the welcome
screen or with **File → Open Vault…** (⌘⇧O). Existing Obsidian vaults open
as-is: Clew never touches `.obsidian/` and keeps its own state (workspace
layout, caches, bookmarks) in a `.clew/` folder.

## The file explorer

- Click a note to open it — **in a new tab** by default (a file already
  open just gets focused, so tabs don't multiply); ⌘-click opens in the
  current tab instead. Settings → Appearance flips the default if you
  prefer Obsidian's replace-in-place.
- Click an image, PDF, audio, or video file to open a viewer tab.
- Right-click a file for **open in new tab / current tab / to the right
  (split)**; right-click anything for **new note/folder, rename, reveal
  in Finder, delete** (deletes go to the system Trash).
- **Drag** a note or folder onto another folder — or the empty tree
  background for the vault root — to move it. Renames and moves rewrite
  every `[[wikilink]]` that points at the moved notes.

## Symbolic links

Symlinked notes and folders inside a vault are first-class citizens: they
appear in the explorer, get indexed (links, backlinks, search, the quick
switcher), render, and save through the link to the real file — even when
the target lives outside the vault. The file watcher follows links too,
so external edits to linked files reload like any other. Link cycles are
detected and walked once; dangling links are skipped quietly. (This is a
deliberate improvement over Obsidian, which largely ignores symlinks.)

## Editing alongside other apps

Clew watches the vault. Files edited in another app reload in place when
your editor is clean. If you have **unsaved local edits** and the file
changes on disk, a banner appears and auto-save pauses until you choose
**Keep my version** or **Load disk version** — nothing is clobbered
silently.

## Note history

Auto-save can never eat your paragraphs: before a save displaces an
existing note (or canvas), the old text is snapshotted into
`.clew/history/` — at most one version per five minutes of editing,
pruned per note by count and age. Run **View note history…** from the
palette (⌘P) or the File menu to browse the versions of the current
note and restore one; the text a restore replaces is snapshotted first,
so restores are reversible. The snapshots are plain files you could
also recover by hand. Try it on this very note: make an edit, wait a
moment, and open the history. (Per-vault switch and tuning:
`history` in `.clew/vault-settings.json`.)

See also: [[Attachments and Files]], [[Navigation]].
