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
