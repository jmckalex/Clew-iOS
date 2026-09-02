---
done: false
rating: 6
status: drafting
stars: 3.5
ink: "#8b7ec8"
due: 2026-09-15
url: https://clew-app.com
tags:
  - guide
---
# Widgets

A widget is a **live control in a rendered note, two-way bound to
something in a file**. Flip it and the file changes; change the file and
the widget follows on the next render. The file is always the truth —
a widget is just a view of it, exactly like an
[[Queries|editable query cell]], and it writes through the same
machinery, frontmatter safety valve included.

The syntax is the Obsidian Meta Bind plugin's, so widget-carrying notes
travel between apps; the controls themselves are
[Web Awesome](https://webawesome.com) components (MIT, bundled,
loaded only when a note carries one).

## Bound to properties

These are bound to this very note's frontmatter — flip them and watch
the Properties panel follow:

Done: INPUT[toggle:done] · Rating: INPUT[slider(minValue(0), maxValue(10)):rating] — currently VIEW[{rating}] · Status: INPUT[inlineSelect(option(drafting), option(review), option(shipped)):status]

Stars: INPUT[rating(stepSize(0.5)):stars] · Ink: INPUT[color:ink] · Due: INPUT[datePicker:due] — VIEW[relativeTime:{due}] · Progress: INPUT[progressBar(minValue(0), maxValue(10)):rating]

The full set: `toggle`, `slider`, `text`, `textArea`, `number`,
`inlineSelect`/`select`, `datePicker`, `time`, and read-only
`progressBar` are Meta Bind's own vocabulary; **`rating`** (half stars
via `stepSize(0.5)`) and **`color`** are Clew-native additions —
Obsidian's plugin will show its unknown-type error for those two. A
binding can also reach *another* note's property:
`INPUT[toggle:[[Some Note]]#done]`.

## Bound to text

Widgets can edit **prose**, not only metadata. Give a block a
[[Reading Mode|block reference]] marker and bind a text widget to it —
the widget holds the block's text, and typing in it rewrites that exact
block in the file, marker preserved:

Plain text and a little courage survive every app. ^motto

Edit the line above from here: INPUT[text:^motto]

Change it in either place — the widget, or the paragraph in source
mode — and the other follows. The widget holds the marker's LINE
verbatim, so plain paragraphs are the natural targets (a blockquote's
`>` or a list's `-` would ride along). Only `text` and `textArea` bind
to blocks; the value stays one block (newlines flatten), and a marker
inside a code fence is never a target. For anything more ambitious than
a block, the [[Note API]] can rewrite whole notes from a script — that
is the programmable tier of the same idea.

## Displaying values: VIEW

`VIEW[{prop}]` shows a bound value inline. Clew adds formatter kinds:

- VIEW[relativeTime:{due}] and VIEW[formatDate:{due}] for dates
- VIEW[formatNumber:{rating}] and `formatBytes` for numbers
- Status as a badge: VIEW[badge:{status}]
- And `qr` — a bound URL as a scannable code:

VIEW[qr:{url}]

## The rules

Everything unsupported is refused by name: remaining Meta Bind input
types, `VIEW[…]` expressions, and the plugin's button system (buttons
run commands — that tier in Clew is the [[Note API]] and
[[Plugins|plugins]]). In a website export widgets render disabled — a
static page has no write path. And playing with this page edits *this
file*: `git status` will show it, which is the whole point.
