---
tags: [guide]
---
# Reading Mode

**⌘E** toggles between source and reading mode. Reading mode is the full
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
  (inverse search).
- Click a **task checkbox** and Clew writes the `[x]` back to the source
  file — try it in [[Tasks]].
- Source and reading panes of the same note **scroll in sync**, both
  directions, and reading mode opens at your cursor line.

See also: [[Editing]], [[Links and Embeds]].
