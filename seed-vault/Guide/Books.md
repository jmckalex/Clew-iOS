# Books

A *book* is a set of ordinary notes read as one: chapters in an order, one
title, one list of what is done and what is still a draft. Every chapter
stays a note like any other — it opens, links and previews as before, and
Obsidian sees nothing it cannot read. [[Signals]] in `Books/` is a small
one to try things on.

## The master note

A book lives in a *master* note: a note whose front matter says
`book: true` and lists the chapters, in order, as links:

```yaml
---
book: true
title: "Signals: A Short Book"
numbering: per chapter
chapters:
  - "[[Senders and Receivers]]"
  - "[[Conventions]]"
  - "[[Deception]]"
---
```

It is the `chapters:` key that makes a note a master: a note that says
`book: true` with no `chapters:` at all — notes ABOUT a book — is just a
note.

The master's own text is what comes before the first chapter — a
dedication, an epigraph, or nothing — except its `@bibliography` (and an
`@index`), which go after the last chapter: the book's one list of
references, as Signals' master has it. `numbering` is `per chapter` (Figure
2.3, Theorem 4.1) unless it says `continuous`.

A chapter's *title* is its first `#` heading; failing that, the `title` in
its front matter; failing that, its file name. Renaming a chapter renames
it in the list too, as it does every other link to it.

Only chapters for now. A master that lists `parts`, `frontmatter` or
`appendices` is read without them, and the Book panel says so by name.

## The Book panel

A vault with a book has a *Book* tab in the right sidebar (the command
`Book: show the Book panel` opens it). It shows the book of the note you
are in — the master or one of its chapters — or, from anywhere else, the
book you opened last; a vault with several books has a list to pick from.

Each chapter is a row: its number, its title, its length in words, and
its status.

- *Words* are prose: front matter, code, maths and comments are not
  counted. (The status bar counts every word of a note, so its number is
  larger.)
- *Status* is the chapter's own `status:` property — `draft`, `revised` or
  `done` — chosen from the row's menu. The totals under the list add the
  words up and count the chapters at each status.
- *Drag* a row by its grip to move the chapter, or focus a row and press
  Alt+↑ or Alt+↓.
- *×* takes a chapter out of the book; the note itself stays where it is.
- *Add …* puts the note you are in at the end of the book.
- A chapter whose link finds no note is shown in red, as `[[Name]] — no
  such note`.

Every change is an edit to a note — the master's `chapters` list or a
chapter's `status` — made the way you would make it yourself: an open
editor takes it as an edit (it can be undone), and a note changed
elsewhere at the same moment is held for you to resolve, as always. A
master whose front matter Clew cannot rewrite safely (comments, unusual
YAML) is shown but not changed.

## Inside a chapter

In a chapter, the status bar says where you are — *Ch. 2 of Signals: A
Short Book*; a click opens the Book panel. A note may be a chapter of
two books: the status bar names the one you opened most recently, adds
"also in …", and a click switches to the other.

`Book: next chapter` and `Book: previous chapter` move through the book.
They have no keys of their own; give them some in *Settings → Hotkeys*.

## Building the book

*Build* in the Book panel — PDF, LaTeX or HTML — or *File → Export → Book
as …* makes the whole book ONE document: the master's text, then each
chapter in order, every chapter's front matter left out and its `#`
heading made a chapter (a chapter with no `#` heading gets one from its
title). Figures, equations and theorems are numbered by chapter — Theorem
2.1, equation (2.1) — or straight through the book when the master says
`numbering: continuous`. It goes into a `build/` folder beside the master,
named after it —
`build/Signals.pdf`, `build/Signals.tex` — and a rebuild replaces it.
LaTeX's own files (`.aux`, `.log` …) stay in `build/` too, so nothing lands
beside a chapter. HTML is a small website, one page per chapter: the folder
`build/Signals/` holds `index.html` (the master's text and the contents)
and a page for each chapter, with previous, contents and next links on
each; Clew opens it in your browser when the build is done — except in a
vault you haven't trusted, whose pages could carry its notes' own scripts:
those are shown in Finder instead, and the notice says why. Each HTML build
replaces the folder, the old one going to the Trash.

A chapter that links to no note stops the build, by name. What the build
had to say is listed under the panel's *Last build* — click the ⚠ — and a
chapter's row carries its own count: each warning names its chapter and
line, and choosing it opens the chapter there.

A chapter may set a few things for itself in its front matter: its own
`Bibliography` (it joins the book's — Conventions cites from
`Features/refs.bib` this way), `Packages` and `LaTeX preamble` (they join
the book's one preamble), `Lang` or `Language` (hyphenation and quotation marks), `Math
macros`, and its own `<style>` (on its own page only). Anything else a
chapter sets is the master's to decide, and the build says so by name —
unless the chapter sets it to the very value the book uses, which is why
Conventions can keep `Resolve citations` for its own reading view and the
master says the same.
