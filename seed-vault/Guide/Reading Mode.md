---
tags: [guide]
---
# Reading Mode

Every note tab is in one of **three modes**: **source** (the markdown as
written), **live edit** (the markup concealed until the cursor touches it
— see [[Live Edit]]), and **reading** (the rendered page). **⌘E** toggles
reading mode and returns to whichever editing mode the tab last used;
**⌘⇧E** flips between source and live edit; the View menu's Mode submenu
and the mode switch on the toolbar reach all three. Reading mode is the full
jmarkdown engine — MathJax, TikZ, MetaPost and whole LaTeX snippets
(typeset in the page by a wasm TeX, with no TeX installation), mermaid,
theorem environments,
citations, transclusion — not an approximation of it.

While you type in a source pane of the same note, the reading pane
updates **in place**: scroll position and rendered math survive, and only
changed blocks re-typeset.

## Interactions

- Click a wikilink to follow it (⌘ for a new tab).
- **⌘-click any block** to jump back to that exact line in the editor
  (inverse search) — in source or live edit, whichever the tab last used.
- Click a **task checkbox** and Clew writes the `[x]` back to the source
  file — try it in [[Tasks]].
- Source and reading panes of the same note **scroll in sync**, both
  directions, and reading mode opens at your cursor line.

See also: [[Editing]], [[Links and Embeds]].
