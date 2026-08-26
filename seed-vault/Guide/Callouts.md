---
tags: [guide]
---
# Callouts

A callout is a blockquote that announces what kind of thing it is. Write
`> [!type]` on the first line and the rest of the quote becomes a
coloured box with an icon.

> [!note]
> This is a callout. The type goes in brackets after the `!`, and it is
> case-insensitive — `[!note]`, `[!Note]` and `[!NOTE]` are the same.

## Giving one a title

Anything after the type becomes the title, and it may contain markdown:

> [!tip] Titles can carry *emphasis* and even [[Welcome|links]]
> Without a title, the type's own name is used — "Tip", above would have
> read "Tip".

## Folding

Add `-` to start collapsed, or `+` to start expanded. Both are
collapsible; click the title to toggle.

> [!question]- What is the `-` for?
> It means "start minimised", not "no callout" — which catches everyone
> out once. This callout was collapsed when the page loaded.

> [!example]+ Starts open, still foldable
> Useful for something worth reading but worth hiding once read.

Folding is native `<details>`, so it works with no JavaScript, survives a
live re-render, works in an [[Publishing|exported site]], and prints
expanded.

## The types

> [!abstract] Aliases
> Several types answer to more than one name: `abstract` is also
> `summary` and `tldr`; `tip` is also `hint` and `important`; `success`
> is also `check` and `done`; `question` is also `help` and `faq`;
> `warning` is also `caution` and `attention`; `failure` is also `fail`
> and `missing`; `danger` is also `error`; `quote` is also `cite`.

> [!info]
> info — for context the reader may not have.

> [!todo]
> todo — something still to do.

> [!success]
> success — it worked.

> [!warning]
> warning — mind this.

> [!failure]
> failure — it did not work.

> [!danger]
> danger — this will hurt.

> [!bug]
> bug — a known defect.

> [!example]
> example — a worked case.

> [!quote]
> quote — someone else's words.

## What happens to an unknown type

> [!nonsense]
> A type Clew does not know stays an ordinary blockquote rather than
> being invented — which is the honest failure, and keeps the note
> readable.

Clew's callouts use the same class names Obsidian does (`callout`,
`data-callout`), so a vault's own CSS snippets keep working, and the same
`markdown-alert` names the jmarkdown engine uses, so nothing that
targeted those breaks either.
