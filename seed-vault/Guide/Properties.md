---
status: published
reviewed: true
priority: 2
tags:
  - guide
  - properties
aliases:
  - Frontmatter
---

# Properties

Notes can carry structured metadata in a *frontmatter* block — the
`---`-fenced YAML at the very top of the file. This note has one; open
the **Props** tab in the right sidebar to see it as editable rows.

## The panel

- Every property is a key/value row. The editor is typed: booleans get a
  checkbox, numbers a numeric field, lists become chips.
- **+ Add** creates a property; the **×** that appears on hover removes
  one. Rename a key by editing it in place.
- For list properties, type in the trailing field and press **Enter** to
  add an item; **Backspace** in the empty field removes the last one.
- Edits go through the open editor when the note has one — so **⌘Z** in
  the editor undoes a property change — and straight to disk otherwise.

## The format

Clew reads and writes a deliberate subset of YAML: strings, numbers,
booleans, empty values, and flat lists (inline `[a, b]` or `- item`
lines). `tags` and `aliases` feed the vault index — the tags above make
this note show up under `#guide` in the tag pane, and the alias means
`[[Frontmatter]]` resolves here.

Anything beyond that subset (nested maps, comments, multi-line strings)
is left exactly as written: the panel shows it read-only rather than
risk rewriting data it doesn't fully understand.
