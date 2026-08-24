---
tags: [guide]
header-html: "[[matrix-rain.html]]"
header-title: Note Headers
header-subtitle: banners, and backgrounds that move
header-height: 200
---
# Note Headers

The banner at the top of this note is not part of Clew. It is drawn by
the **Note Headers** plugin that ships with this vault
(`.clew/plugins/header/`), and it is running a live HTML page — the
falling-glyph animation in [[matrix-rain.html]]. Scroll, edit, save:
it keeps going. See [[Plugins]] for how plugins work in general; this
note is about what this one does.

## An image banner

The original form. Any note can opt in from its frontmatter:

```
---
header-image: "[[clew-gradient.png]]"
header-title: A Grand Title
header-subtitle: with a subtitle
header-height: 240
header-position: center 30%
header-align: bottom
---
```

`header-height` is in pixels (170 if unsaid), `header-position` takes
any CSS `background-position` so a photo whose subject is off-centre can
still be framed properly, and `header-align` puts the text block at the
`top`, `center`, or `bottom`. A title that matches the note's first `#`
heading replaces it, so you don't get both. Titles may carry `$math$` —
MathJax is already in the document. [[Welcome]] uses this form.

## An HTML banner

`header-html` points at an ordinary `.html` file in the vault instead,
and loads it into the banner behind the title:

```
---
header-html: "[[matrix-rain.html]]"
header-title: Note Headers
header-height: 200
---
```

Anything a browser can draw will do — a `<canvas>` animation like this
one, CSS keyframes, an inline SVG, a gradient that drifts. Write it as
a standalone page sized to 100% width and height; the banner is its
viewport. If a note sets both keys, `header-html` wins.

Two things make it behave rather than merely work:

- **It is sandboxed.** The page runs with `allow-scripts` and nothing
  else, so it gets its own opaque origin: it can animate, but it cannot
  read this note, reach the vault, touch the surrounding document, or
  use the [[Note API]]. A decoration should not have the run of the
  place. It is also click-through, so it never swallows a scroll meant
  for the note.
- **It survives re-rendering.** A preview re-renders every time the note
  is saved, and the patch that updates the document would ordinarily
  throw away a banner the incoming HTML knows nothing about — restarting
  the animation every few seconds as you type. The banner carries
  `data-clew-keep`, which tells the preview client to leave it alone,
  and the plugin reuses the existing banner whenever the frontmatter it
  reads hasn't changed. Any plugin that adds lasting furniture to a
  preview can use the same attribute.

## A wrinkle worth knowing

`header-image` and `header-html` both accept either a `[[wikilink]]` or
a plain vault path — `header-image: Attachments/banner.jpg` works
identically, and a bare name is looked for in `Attachments/`.

But the wikilink form here is a *convention*, not a tracked link. Clew's
indexer deliberately skips frontmatter when it scans for links, so a
banner image doesn't appear in the [[Graph View]] or in backlinks, and
**renaming it will not rewrite the reference** the way [[Links and
Embeds]] describes for links in the body. Nothing breaks loudly; the
banner just stops loading. Worth remembering before reorganising an
`Attachments/` folder.
