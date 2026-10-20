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
  (latexmk, with LuaLaTeX, XeLaTeX or pdfLaTeX as the document needs) on
  the generated LaTeX.

Exports honour the normal jmarkdown config cascade (`~/.jmarkdown`, the
vault's `.jmarkdown/`, the note's own metadata header) — so a note like
[[Citations]] exports with its bibliography resolved.

The LaTeX and the PDF via LaTeX come out in **Clew's style**: EB Garamond
with matching maths, 12pt on A4 (US Letter where your region uses it),
curly quotes from straight ones, hyphenation in the note's language — its
`Lang`, else your configuration's, else English, British or American by
your region — quieter lists and headings, long quotations a size smaller,
emoji in colour. Your jmarkdown configuration still applies on top — its
packages and macros — except that the style's fonts win over a font it
sets; and a note's own header keys (`Lang`, `Class options`, `Geometry`,
`LaTeX preamble`, …) win over the style — a header saying
`LaTeX engine: pdflatex` gets no style at all. *Settings → Appearance →
Style of LaTeX and PDF via LaTeX exports* turns it off ("Your jmarkdown
configuration only").

A note's **title block** — `@title[…]`, `@subtitle[…]`, `@author[…]`,
`@institution[…]` and `@date[…]` on lines of their own at the top —
becomes LaTeX's own title (`\title`, `\author`, `\date` and
`\maketitle`) in every LaTeX export and PDF via LaTeX, styled or not: in
Clew's style the title large and centred, each author in small capitals
with the institution beneath, several authors side by side. A part the
block leaves out stays out — no author line, and no date, where LaTeX
would otherwise print today's. Only the first such block is the title (a
book's is its master's); any other title line prints as it is. A note's
header `LaTeX maketitle: false` keeps the lines as plain lines.
