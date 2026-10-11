# The iPad's HTML share — plan and record

**STATUS: BUILT and VERIFIED, 2026-10-11.** Clew-boss approved the plan on
2026-10-10, and the owner's freeze for the colon-directive work paused it
on 2026-10-11. Clew-boss lifted the freeze, verified phases 1 and 2, and
asked for this record and a fast-forward of main. The push waits for the
owner's word typed in this window.

The chain, off main 52cd16a (the f959799 build commit):
- `share-p1-palette`: aa2d655.
- `share-p2-snapshot`: b9acd32.
- `share-p3-record`: this record, and one fix found while measuring it (below).

## Why

The manual promises that "Export as HTML" gives a standalone page whose
diagrams draw. Until now the iPad shared the engine's HTML, which carried
none of what reading view draws: on Features/Diagrams it was 0/11 figures
(UPSTREAM-F959799-PLAN.md), and its styles and scripts resolved only inside
Clew.

## What it is

- **Phase 1, the palette:** the commands "Export book as PDF (via LaTeX)",
  "… as LaTeX" and "… as HTML" only ever refused on the iPad. build.js
  narrows books.js's export loop to the print, as the Book panel already
  is. "Export book as PDF (reading view)" stays, and EXPORT_BOOK still
  refuses the other formats by name. tests/no-latex-ui.test.js reads the
  loop's list in the built bundle.
- **Phase 2, the share:** "Export as HTML" shares a snapshot of the note as
  reading view drew it.
  - The bridge's `snapshotHtml` loads the note's clew-preview document in
    the PDF export's hidden web view (PrintPDF.swift), and waits on the
    same ready probe: figures drawn, Mermaid's SVGs in, fonts loaded.
  - It then runs html-share.js's `SNAPSHOT_SCRIPT` in a content world of
    its own (`clew-share`). The script copies the drawn page into an inert
    document (DOMParser), so nothing it removes ever runs.
  - The shim checks the finished string (`shareLeaks`) and refuses to
    share it if a script, a handler or an internal path is still there:
    "the page was not shared: it would have carried …".
  - **A book's HTML is not a snapshot:** EXPORT_BOOK refuses it by name,
    and the palette offers the print alone.

## Clew-boss's conditions, and how each is met

| Condition | How |
|---|---|
| No scripts | `<script>`, `<noscript>`, `<template>`, `<base>`, frames and applets are removed; the CSP has `script-src 'none'`; `shareLeaks` refuses a page with a script |
| No handlers or javascript: | every `on*` attribute is dropped; `javascript:`, `vbscript:` and `data:text/html` values go; SVG `set`/`animate` on href go; `shareLeaks` refuses either |
| No path leaks | any attribute naming clew-preview:, `/__clew_`, file://, blob:, `/vault/` or the session id goes; `shareLeaks` also refuses the vault's path and an app-container path |
| Images: 2 MB each, 10 MB a page | vault images become data: URLs within both caps; past either, a line names the file by its vault-relative name ("too large to include (2.9 MB)", "over the 10.0 MB this page allows for images") |
| Embeds as named placeholders | apps, PDFs, drawings, canvases, office documents, decks, frames, embeds and objects each become one line: `[App: Apps/Flashcards — not included in this page]` |
| Wikilinks as plain text | a link is unwrapped unless it is http(s), mailto:, tel: or a #anchor on the page |
| A restricted vault shares the same | the snapshot is reading view's own document, which already holds a restricted vault's apps back; the app is a placeholder all the same |
| No book HTML snapshot | refused by name; the palette offers the print alone |

The hidden view now lets only the note's own document into its main frame.
A note's `<meta http-equiv="refresh">` had swapped example.com into the
share, and the PDF export had the same hole, so the print is hardened too.

## Measured in the simulator (iPad Pro 11" M4)

**Today, the merged code** (a fresh install of the Demo Vault; times include
the hidden view's load):

| Note | Bytes | Time | What it holds |
|---|---|---|---|
| Features/Diagrams.md | 353,722 | 6.5 s cold, 1.1 s cached | 11/11 figures and 2/2 Mermaid drawn; 10 scripts removed; 1 web link kept |
| Guide/Attachments and Files.md | 102,136 | 0.9 s | `[PDF: sample.pdf — not included in this page]`; 1 image inlined (11 KB); 3 links unwrapped |
| Guide/Apps in Notes.md | 93,163 | 0.9 s | `[App: Apps/Flashcards — not included in this page]`; 1 link unwrapped |

In all three: 0 scripts, 0 handlers, 0 javascript: URLs, 0 frames, 0
`<link>`s, the CSP present, and `shareLeaks` clean. A scan for the session
id, CoreSimulator, Containers/Data, file:, clew-preview, `/vault/` and
Documents/ finds nothing. The one `__clew` substring is the preview's CSS
selector `#__clew_err`, a name, not a path.

**Fix found while measuring (p3):** the PDF's placeholder read
"sample.pdf⟷". The viewer adds its controls to the embed's title bar (a ⟷
button and a status chip), and the name was the bar's text. The name now
comes from the bar without them, and the test names the piece.

**Phase 2's own run (2026-10-10, on fixtures in scratchpad):**
- A maths note: 25/25 drawn.
- Image caps: five of 1.9 MB inlined, a 2.9 MB image held as too large,
  and a sixth held as over the page's 10 MB.
- A hostile note: a script, handlers (`onerror`, `onclick`, SVG
  `onload`), javascript: links (one spaced and mixed-case), an SVG `set`
  on href, an iframe, an `<object>` PDF, a form with a javascript:
  formaction, a javascript: url() in a style, and a meta refresh. Nothing
  active was left, nothing ran in the app, and the redirect no longer
  reaches the share or the print.
- A restricted vault's note with an app block (trust v2, untrusted):
  `[App: Apps/Picker — not included in this page]`, no scripts.
- The saved pages, opened in macOS WebKit with scripts off: 11/11
  figures, 2/2 Mermaid, 25/25 maths. Quick Look's thumbnails show them
  drawn.

**Tests:** npm 778; Swift all passing; xcodebuild OK.

## Not included, by design

- A PDF, an app, a deck, a drawing or a canvas is a one-line placeholder,
  never its content.
- Audio and video stay only when their sources are web URLs; a vault
  file is a placeholder.
- A wikilink is its text.

## Upstream, not changed

Two image embeds on one line render the first as "!" plus a link (the
engine). The fixture puts one per paragraph.

## iPad checks

- Share Features/Diagrams to Files, open the file in Safari: every figure
  and both Mermaid diagrams drawn.
- Share a note with an image over 2 MB: the line names it.
- Mail the share to a Mac and open it there.
