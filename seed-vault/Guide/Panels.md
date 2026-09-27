---
tags: [guide]
---
# Panels

The **left sidebar** holds Files, Search, and Marks (bookmarks — add one
with "Bookmark this note" in the palette).

The **right sidebar** tools all track the active note:

- **Links** — backlinks, grouped by source with the line each link sits
  on; click a snippet to jump to that exact line. Below them, **unlinked
  mentions**: places where this note's name (or an alias) appears in
  plain text. Hover a mention and press **Link** to turn it into a
  wikilink right where it stands. (Open the Links tab on the Reading
  Mode note — the plain words reading mode in this sentence show up
  there.)
- **Props** — the note's frontmatter as editable rows ([[Properties]]).
- **Out** — outgoing links, resolved and unresolved (click an unresolved
  one to create the note).
- **Tags** — every tag in the vault with counts; click to list the
  tagged notes. Nested tags like `#project/clew` work.
- **Outline** — the note's heading tree; click to jump.
- **Graph** — a local graph of the active note's neighborhood.

Under the workspace there is one more, and it is not a sidebar tool:
**the shell panel** (⌃\`, or View → Shell Panel). It is a terminal
running your own login shell, started in this vault's folder — so `ls`,
`grep`, `git status` and a build all happen where the notes are. Drag its
top edge to resize it; the height is remembered per vault. One shell per
window, and it keeps running while the panel is hidden: start something
slow, press ⌃\`, carry on writing, and press it again to see how it got
on. Pressing ⌃\` while the caret is *in* the terminal closes the panel
rather than typing a backtick.

See also: [[Search]], [[Graph View]].
