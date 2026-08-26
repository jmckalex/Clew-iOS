---
tags: [guide]
---
# Drawings (Excalidraw)

Clew has [[Canvas|its own canvas]], and for most work it is the better
tool — it holds live note previews, web pages, PDFs, ink and shapes on
one infinite board. But hundreds of thousands of people draw in
**Excalidraw**, and an Obsidian vault is very likely to be full of
`.excalidraw.md` files. Clew opens them, edits them, and hands them back
in a form Obsidian still reads.

The editor is the real Excalidraw, embedded unmodified — same tools, same
shortcuts, same library format. Nothing about it is a reimplementation, so
it behaves exactly as it does on excalidraw.com.

![[Round Trip.excalidraw.md]]

## Making one

**File → New Drawing (Excalidraw)**, the command palette, or right-click a
folder in the explorer. Drawings open in their own tab; clicking one in
the file explorer opens the editor, not a wall of JSON.

## Two extensions, and why

| Extension | Who writes it | Why |
|---|---|---|
| `.excalidraw.md` | Obsidian's plugin, and Clew by default | Markdown is the only thing Obsidian indexes, so the wrapper is what gives a drawing backlinks, tags and searchable text *there* |
| `.excalidraw` | Clew, if you ask | Plain JSON — the honest extension for a vault Clew has to itself |

Set `excalidrawFormat` in Settings → This vault to choose. The default is
Obsidian's convention, because a shared vault should look native in both
apps.

**In Clew it makes no difference.** Clew reads the words straight out of
the drawing, so both forms are indexed identically: a `[[wikilink]]`
typed inside a drawing is a real link that shows up in the target's
backlinks and in the [[Graph View]], and a `#tag` inside a drawing is a
real tag. The drawing above links to [[Welcome]] — look at Welcome's
backlinks and this drawing is there.

## Embedding and pinning

`![[Round Trip.excalidraw.md]]` embeds a drawing in a note, as above. An
embed is **read-only**: reading should not put you one stray click from
altering a diagram. The title bar opens the real editor when you mean it.

Drawings can also be dropped onto a [[Canvas]] as file nodes, where they
*are* editable once you double-click to engage the node.

## Shape libraries

Drop a `.excalidrawlib` onto the canvas, or use *Load library* in the
library panel. Clew remembers it per vault, in
`.clew/excalidraw-library.json` — Excalidraw on its own keeps libraries in
browser storage, which in a note app means "until something clears it".
A shape set is a working vocabulary that belongs with the notes it
illustrates, so it travels with the vault.

## What is preserved

Saving splices the drawing back into the file it came from and changes
nothing else: frontmatter, any prose you wrote above the drawing, the
`## Text Elements` section, and the compression Obsidian used are all
left exactly as found. An unedited drawing saves back byte-for-byte, so
opening one never shows up as a change in git.
