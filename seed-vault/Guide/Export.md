---
tags: [guide]
---
# Export

From the command palette (⌘P), any note exports through the jmarkdown
engine — the same source, three outputs:

- **Export note as HTML** — a standalone page using the engine's own
  templates and your jmarkdown configuration.
- **Export note as LaTeX (.tex)** — print-quality LaTeX: theorem
  environments, floats, citations via natbib, TikZ as native pictures.
- **Export note as PDF (via LaTeX)** — runs your TeX toolchain
  (latexmk/pdflatex) on the generated LaTeX.

Exports honour the normal jmarkdown config cascade (`~/.jmarkdown`, the
vault's `.jmarkdown/`, the note's own metadata header) — so a note like
[[Citations]] exports with its bibliography resolved.
