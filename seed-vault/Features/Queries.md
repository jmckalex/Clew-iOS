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

Query tables are **editable**: any frontmatter cell can be clicked,
retyped, and committed with Enter — Clew writes the value into that
note's own frontmatter (numbers stay numbers, lists stay lists). Two
more powers, and one thing that is deliberately not one:

- **Date arithmetic**: `where: due < today + 7d` (units d/w/m/y).
- **Grouping**: `group: status` renders one section per value.
- **Not inline fields.** Dataview's `Rating:: 8` on its own line and
  `[chapter:: 5]` mid-sentence are not read as data here: `::` is this
  dialect's *description list*, so a `Key:: value` line renders as a
  term and its definition — like the one just below — and a bracketed
  field swallows its sentence as the term. A line cannot be both, and
  description lists won. Data lives in frontmatter, where the
  properties panel and every query cell can edit it.

Rating:: not a field but a description list — `<dt>Rating</dt>`, then this text as its `<dd>`.

## Kanban

```` ```kanban ```` projects the same data as a board: columns are the
values of a frontmatter field, cards are notes. **Dragging a card to
another column rewrites that note's field** — and every query view
follows, because they all read the same files.

````
```kanban
group: status
from: Projects
columns: planned, active, done
show: due
```
````

## Live views

Open notes containing query, tasks, or kanban fences **re-render
whenever any note in the vault changes** — a dashboard tracks the vault
in real time.

## Opening a vault that uses Dataview

Vaults arriving from Obsidian carry **Dataview** queries, and rewriting
somebody's queries is not a migration path — so Clew runs them. A
```` ```dataview ```` fence is parsed and executed against the same
index the fences above use:

```dataview
TABLE status, priority AS "Pri"
FROM "Projects"
WHERE status
SORT priority ASC
```

`TABLE` (with `WITHOUT ID` and `AS` aliases), `LIST`, `TASK`; `FROM` over
folders, `#tags`, `[[links]]` and `outgoing()`, combined with `and`/`or`
and negated with `!`; `WHERE`, multi-key `SORT`, `GROUP BY`, `LIMIT`; the
whole `file.*` namespace; `this`; and about thirty functions. Cells over
real stored fields stay editable, exactly as in Clew's own tables.

An inline query works too — this note's name is `= this.file.name`.

What Clew does **not** implement is refused by name rather than guessed
at, because a query that silently drops a clause shows numbers that are
wrong. `FLATTEN`, `GROUP BY … rows`, `file.lists`, `file.day` and
`CALENDAR` all say so in the note.

```` ```dataviewjs ```` blocks are JavaScript rather than queries, so
there is no telling in advance what one will do. Clew can run them —
**Run dataviewjs blocks** in this vault's settings — with a `dv` object
over its own index (`dv.pages`, `dv.current`, `dv.table`, `dv.list`,
`dv.taskList`, `dv.view` …). It is off by default, per vault, and
anything with no Clew equivalent — `dv.app`, `dv.io`, `dv.luxon` — says
which one when a block reaches for it.

## Obsidian Bases

`.base` files — Obsidian's first-party database view — are read too.
Embed one with `![[Board.base]]`, or a named view with
`![[Board.base#Recent]]`; table, list and card views render, with the
base's own display names, filters, formulas, sorting and limits. A
```` ```base ```` fence holds the same YAML inline:

```base
filters:
  and:
    - file.folder == "Projects"
properties:
  file.name:
    displayName: Project
  note.status:
    displayName: State
views:
  - type: table
    name: Projects
    order:
      - file.name
      - status
      - priority
    sort:
      - property: priority
        direction: ASC
```

## For script blocks: the `vault` API

jmarkdown script blocks run at build time and can query directly:
`vault.query({ from: 'Projects', where: 'status = active' })` returns
note objects (`path`, `name`, `fm`, `modified`); `vault.tasks()` and
`vault.notes()` complete the set. The programmable tier — build any
table or report, in any output format the engine targets.

**See it all working**: the repository ships a second vault,
`study-vault/`, staged as an academic term run entirely on these
features — start at its `Start Here` note.
