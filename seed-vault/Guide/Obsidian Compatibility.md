---
done: false
status: drafting
tags:
  - guide
---
# Obsidian Compatibility

Clew opens Obsidian vaults. Not by embedding Obsidian's code — by
implementing the **formats** an Obsidian vault leaves on disk, measured
against real public vaults rather than worked through a reference page.
One rule governs all of it: **what is not supported is refused by
name.** A query that silently dropped a filter would show numbers that
are wrong, which is worse than showing nothing.

## What an Obsidian vault gets

Wikilinks and embeds, properties, callouts, block references, tags —
the core language. Then the plugin formats that put data in files:
**Dataview** (DQL with FLATTEN, real GROUP BY and lambdas; `dataviewjs`
behind a per-vault switch), **Bases** (tables, cards, and map views),
**Kanban** boards (open [[Project Board]] in reading mode), the
**Tasks** plugin's query dialect and emoji metadata, **Excalidraw**
drawings with embedded images, **Charts** (see [[Charts]]),
**TikZJax**'s ` ```tikz ` fences — typeset by a real LaTeX in the
preview, so every PGF library works and nothing has to be installed
(see [[Diagrams]]) — `obsidian://` links, GitHub-style `#anchors` — and
the three below.

One Dataview idiom is refused on purpose: **inline fields**. `Key::
value` is jmarkdown's description-list syntax, and a line cannot be
both a definition and a datum, so Clew renders it as a description
list and reads no field from it — a bracketed `[key:: value]`
mid-sentence becomes a term, sentence and all. Put the value in
frontmatter; every query, board and panel reads it there (see
[[Properties]]).

## Admonitions

The callout syntax vaults used *before* Obsidian had callouts. An
` ```ad-type ` fence renders as the callout it always meant:

```ad-tip
title: Old syntax, same box
collapse: open
This box is written as an Admonition fence — switch to source mode to
see it. `title:` and `collapse:` work; `icon:` and `color:` were the
plugin's cosmetic overrides, and the callout's own styling applies.
```

## Embedded searches

Core Obsidian's ` ```query ` block holds a *search*, not a database
query. Clew tells the dialects apart by the colon: `key: value` (with a
space) is [[Queries|Clew's query language]], `operator:value` (without)
is a search. This one finds guide notes mentioning callouts:

```query
tag:#guide "callout"
```

Terms combine with AND, `"quotes"` make phrases, `tag:`, `path:` and
`file:` scope the search, `-` negates, `OR` offers alternatives, and
`[property:value]` matches frontmatter. Regexes, parentheses and
`line:`/`section:`/`task:` scopes are refused by name.

## Meta Bind widgets

The Meta Bind plugin's `INPUT[…]` syntax renders live controls
two-way bound to a note's properties — and in Clew, to its *text*, via
block references. They have a whole page of their own: **[[Widgets]]**,
with every control live on it. One taste, bound to this note's
frontmatter:

Done: INPUT[toggle:done] · Status: INPUT[inlineSelect(option(drafting), option(review), option(shipped)):status]

Unsupported input types, `VIEW[…]` expressions, and the plugin's
button system are refused by name.

## Where the line is

This is where explicit compatibility work **stops**. The formats above
are owned and tested; plugin *behaviors* beyond them are not chased.
Clew is GPL — the extension story for everything else is the code
itself: a vault plugin (see [[Plugins]] — the engine surface can add
syntax, which Obsidian plugins cannot), a vault script, or a patch.
A named refusal is the signal a gap exists; real demand against a real
refusal is what reopens the question, and nothing else does.
