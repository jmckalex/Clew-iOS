---
tags: [guide]
---
# Editing

Notes are edited in **source mode** with full jmarkdown-dialect
highlighting: `/italics/`, `*strong*`, `**intense**`, `==highlights==`,
directives, `@begin(…)` environments, math, citations, and footnotes all
get faces (see [[Dialect Demo]] for a tour). The fences Clew typesets are
highlighted in their own languages too — TeX inside ` ```tikz `,
` ```latex ` and ` ```tex `, MetaPost inside ` ```metapost ` (see
[[Diagrams]]).

Everything auto-saves about a second after you stop typing, and on
blur/tab-switch. **Undo history survives navigation** — leave a note and
come back, and ⌘Z still works.

## Completions

- `[[` completes note names, aliases, and (after `#`) headings. The
  query matches the **path as well as the name**, and the letters need
  not be adjacent: `[[mkrbrc` finds *Marking Rubric*, and
  `[[Teaching/Rubric` finds it by folder (spaces and all). Typing a `/`
  inserts the full vault path, so the link means the file you chose.
- `#` completes tags, including nested ones like `#project/clew`.
- `\cite{` (and `\citep`, `\fullcite`, …) completes citation keys from
  every `.bib` file in the vault, showing author, year, and title.

## Links and files

- **⌘-click** a `[[wikilink]]` to follow it (⌥ for a new tab).
- **Paste or drop** images and files straight into a note — they're saved
  to the attachment folder and embedded (see [[Attachments and Files]]).
- ⌘F searches within the note.

## The Format menu

The **Format** menu is a map of the whole jmarkdown dialect — every
label shows the syntax it produces, so it doubles as a discovery tool:
inline styles (including sub/superscript and underline), headings,
lists and quotes, the alignment forms (`>> text <<` centers, `>> text`
right-aligns), GFM alerts, table insertion, footnotes/citations/labels,
and every block container from mermaid and TiKZ to `:::TeX`,
`:::game`, and `:::comment`. Styles and lists **toggle** (apply again
to remove; a bullet list converts straight to a task list), containers
**wrap the selection**, and every item is also a palette command you
can give a hotkey in Settings.

See also: [[Reading Mode]], [[Links and Embeds]].
