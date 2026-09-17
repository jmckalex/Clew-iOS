---
tags: [guide]
---
# Links and Embeds

Obsidian-style wikilinks, resolved by shortest path, aliases included:

- `[[Welcome]]` — link by name
- `[[Clew Design|the design note]]` — with display text
- `[[Math and Theorems#Dialect extras]]` — to a heading
- `[[Syntax Showcase]]` — via a frontmatter alias
- Unresolved links are dashed; **clicking one creates the note**.

## Embeds (transclusion)

`![[Note]]` embeds a note's rendered content in a styled box —
`![[Note#Heading]]` embeds just that section. Embeds nest (cycle-safe).

Media embeds render natively: `![[clew-gradient.png]]` shows the image,
`![[sample.pdf]]` embeds a PDF viewer you can annotate, and audio/video
get players — see [[Attachments and Files]]. `![[Demo Canvas.canvas]]`
embeds a live, read-only canvas view — see [[Canvas]].

An embed stays current: edit the embedded note and this one re-renders,
however deeply the embeds nest.

### How much frame an embed draws

The default box — accent stripe, hairline border, rounded corners, title —
is right when the embed is a *quotation of somewhere else*. Two keywords
turn it down when it isn't. `quiet` keeps the stripe and the title and
loses the panel:

![[Reading Mode#Interactions|quiet]]

`bare` keeps nothing at all, so the other note's words sit in this one's
flow, spaced exactly as if they had been typed here:

![[Reading Mode#Interactions|bare]]

That last one is the composed document: a syllabus assembled from week
notes, a paper whose sections live in their own files.

### Embeds that fold

Add `collapsed` or `open` as the last alias segment and the embed gets a
disclosure triangle. Click it and Clew writes the new state back into
*this* note, so the fold travels with the file — try it:

![[Reading Mode#Interactions|collapsed]]

A plain `![[Note]]` has no triangle at all, which is why unfolding writes
`|open` rather than removing the keyword: otherwise the fold would vanish
the first time you used it. An earlier segment is still the title, as in
`![[Reading Mode#Interactions|What reading mode does|open]]`.

## Opening a file in another app

A file link normally opens *in Clew* — [[sample.pdf]] gets the built-in
viewer. Add an `external` alias segment to hand it to the operating
system instead: [[sample.pdf|external]] opens in your default PDF app,
and [[sample.pdf|the sample paper|external]] does the same while
reading as prose (`external` alone is a mode, not a caption). It works
in reading mode and on ⌘-click in the editor.

Obsidian's `file://` links work too, for notes that came from there —
and unlike the alias they may point anywhere on disk, not just inside
the vault. Either way, **programs are refused by name**: a link that
opens a `.app` or `.exe` would be one click from running code, so Clew
says so instead of launching it.

## Block references

A heading link points at a section; a **block reference** points at one
paragraph, list item, table or code block. Mark the block with a
`^identifier` and link to it with `[[Note#^identifier]]`. ^what-a-block-ref-is

That paragraph is marked, so `[[Links and Embeds#^what-a-block-ref-is]]`
links to it and `![[Links and Embeds#^what-a-block-ref-is]]` transcludes
just it:

![[Links and Embeds#^what-a-block-ref-is]]

The marker goes at the end of the block's last line, or — for a table or
a fenced code block, which have no room for a trailing word — on a line
of its own directly beneath:

| Marker position | Suits |
| --- | --- |
| End of the last line | paragraphs, headings, list items |
| Its own line beneath | tables, code blocks |
^marker-positions

You rarely type one. Put the cursor in a block and run **Copy Link to
Block** (Edit menu, or the command palette): Clew writes a six-character
identifier if the block has none, and copies the link. Run it twice and
you get the same link — the block is only named once. Typing `#^` after
a note name in a `[[` link completes the identifiers already in it.

Markers are invisible in reading mode, and they are Obsidian's own
syntax, so a vault that already uses them opens here unchanged. One
Clew-specific note: `^` is superscript in the jmarkdown dialect (`x^2`),
which is why a marker must be preceded by a space — `x^2` at the end of
a paragraph stays an exponent.

Images (and video) take Obsidian's size syntax after a `|` — a width, a
width`x`height, or an alt text and then a size:

![[clew-gradient.png|200]]

![[clew-gradient.png|A stretched gradient|320x60]]

Renaming or moving a note rewrites every link to it, across the whole
vault. The backlinks panel shows who links *here* — see [[Panels]].
