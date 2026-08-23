# Queries

Two fences turn the vault into a database — Clew's built-in answer to
Obsidian's Dataview and Tasks plugins.

## Notes as rows

```` ```query ```` filters notes by folder (`from:`), tag (`tag:`), and
frontmatter fields (`where:`, repeatable), with `sort:` and `limit:`.
`table:` names frontmatter columns; omit it for a plain list. Built-in
fields: `name`, `path`, `modified`.

```query
table: status, priority, due
from: Projects
sort: priority asc
```

A list instead — every guide note:

```query
tag: #guide
limit: 6
```

## Tasks across the vault

```` ```tasks ```` gathers checkbox items from every note (`not done`,
`done`, or `all`; same `from:`/`tag:` filters; `group: none` for one
flat list). **The checkboxes are live** — ticking one writes back to
the note it came from.

```tasks
not done
```

Queries re-run whenever this note re-renders; edit any listed note and
reopen (or touch this note) to refresh.

## The writable layer

Query tables are **editable**: any frontmatter or inline-field cell can
be clicked, retyped, and committed with Enter — Clew writes the value
into that note's own frontmatter (numbers stay numbers, lists stay
lists). Three more powers:

- **Inline fields**, Dataview-style: `Rating:: 8` on its own line, or
  `[chapter:: 5]` mid-sentence. Queries read them like frontmatter, and
  editing one in a table rewrites that very line.
- **Date arithmetic**: `where: due < today + 7d` (units d/w/m/y).
- **Grouping**: `group: status` renders one section per value.

## Kanban

```` ```kanban ```` projects the same data as a board: columns are the
values of a frontmatter field, cards are notes. **Dragging a card to
another column rewrites that note's field** — and every query view
follows, because they all read the same files.

```
```kanban
group: status
from: Projects
columns: planned, active, done
show: due
```
```

## Live views

Open notes containing query, tasks, or kanban fences **re-render
whenever any note in the vault changes** — a dashboard tracks the vault
in real time.

## For script blocks: the `vault` API

jmarkdown script blocks run at build time and can query directly:
`vault.query({ from: 'Projects', where: 'status = active' })` returns
note objects (`path`, `name`, `fm`, `modified`); `vault.tasks()` and
`vault.notes()` complete the set. The programmable tier — build any
table or report, in any output format the engine targets.

**See it all working**: the repository ships a second vault,
`study-vault/`, staged as an academic term run entirely on these
features — start at its `Start Here` note.
