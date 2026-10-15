# Upstream sync to Clew-app ef5f7f2 (2026-10-15)

Ordered by Clew-boss on 2026-10-15, after the c0f2a20 push's cloud build
passed. Pinned to Clew-app `ef5f7f2` after its own check (origin/main
ef5f7f2; a clean export: npm 1283/1283).

## The range, f4feb68..ef5f7f2 (15 commits)

- **Step C** (3267bf5, b7ad70a, 320b310, 73f92eb, b1b5d33): a trusted
  vault's export figures are drawn by the built-in TeX by default
  (`exportFigureEngine` 'auto'), with the installed tools for what it
  cannot draw; a stored 'external' counts only when the user chose it.
  jmarkdown c82d206 and 1cce2c1: strict wasm never runs the tools; a
  refused figure says "[TiKZ figure not drawn]".
- **The inline layer's guard** (e38c179): a construct the inline layer
  cannot draw stays source, and every other mark, chip and line class is
  drawn. `guarded()` moved to its own module (guarded.js).
- **PDF embeds:** `#page=N` opens the embed at page N's top (c7417b9). A
  PDF EmbedPDF cannot open is as tall as its card, measured (f47ae05; the
  iPad's report). No ⟷ in a live-edit block frame (a7b9940).
- **Live tables:** cells wrap at words, and a table wider than the column
  scrolls (9a5c896; the iPad's report): `overflow-wrap: normal` on the
  cells, `contain: inline-size` on `.le-table-wrap`.
- **The figures hint** in Settings says only what is true (72af6a2).
- **figureFonts** (bdae92a, jmarkdown 9fb3d1c; 1a5ab6e): an export hands
  the engine a family as the preview does, whole.
- **An image within a line** is drawn in place in reading view
  (1406ffc, `wikiembedImage`): two on a line no longer show "!" and a
  link. That was an upstream candidate from the HTML share.
- **The indexer's cache** is saved in slices and written off main's thread
  (ef5f7f2; the iPad's 150–175 ms frame on 5,000 notes).

## Phases (one branch each, chained off main c0f2a20)

1. `sync-ef5f7f2-p1-vendor` acc8b1b: vendor from `git archive ef5f7f2`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
   package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
   The regenerated icon was put back.
2. `sync-ef5f7f2-p2-build` facf011:
   - **The index cache saves in the page.** It now goes through
     fs-utils.js#writeFileAtomicAsync. The vfs's fs.promises had no `open`
     (it threw "not available in the render worker") and no `rename`, so
     every save on the iPad would have failed and .clew/cache.json would
     never have been written again. The shim opens for writing (one vfs
     write on close, as fs.js#closeSync), renames, and takes rm's `force`.
     A services test saves the cache and reads it back from disk; it fails
     on the old shim with exactly that error.
   - **indexerPatches** (scripts/build.js): the JSON's slices yield by a
     MessageChannel message where there is no setImmediate (never a
     microtask); 4 ms slices, as colonPatches; `process.env` is read through
     `globalThis.process?.` (the build's bare-process check caught it).
   - engine-config.js lists `wikiembedImage`.
   - The figures row's patch follows its new order and hint. The settings
     shim's `exportFigureEngine` default is upstream's, 'auto' (unused on
     iOS).
3. `sync-ef5f7f2-p3-verify`:
   - bd795b5: **the vfs's writes copy with the typed-array constructor**
     (below, "The index cache's frame");
   - this record.

## Checks

- npm test 789/789 (788 + the cache test). Upstream's new and changed
  tests, run against vendor/clew with this tree's node_modules: 63/63
  (font-families, index-cache, live-inline-layer, pdf-size,
  settings-store, wikilink-embeds, export-cache).
- Swift: all 7 suites green (339 tests). xcodebuild for the simulator:
  succeeded, before and after bd795b5.

**In the simulator** (iPad Pro 11", portrait, both sidebars open, so the
editor column is 276 px and a PDF viewer 208 px):

- **Tables** (Wrap.md, upstream's live-table-wrap fixture):
  - a three-column table with a long cell: columns 72/69/106 px, no word
    drawn over two lines, the long cell wrapped at words;
  - a URL table: 616 px of content scrolls inside its 276 px wrap;
  - `.le-table-wrap` computes `contain: inline-size`; the note's scroller
    (276/276) and the page (834/834) do not overflow;
  - the owner's "this article": "A heading / Another heading / And this",
    no longer a letter a line. Its callout, maths (4 KaTeX), TikZ frame and
    table are drawn, nothing raw, no errors;
  - the f4feb68 pair: NoTable 9 live classes, WithTable 11 (4 cells),
    Table.md 12 cells, no errors and no warnings (as before).
  - A WebKit note for anyone measuring: a word's Range ending at a line
    break gives an extra zero-width rect on the next line, so count only
    rects wider than 1 px (upstream's smoke counts them all).
- **PDFs**, through upstream's `test-pdf-size` hook (host height; ⟷ shown;
  viewport top; the page wanted / shown; that page's top):

  | note | view | host | ⟷ | top | page | page top |
  | --- | --- | --- | --- | --- | --- | --- |
  | Page (`#page=3`) | live | 307 | no | 492 | 3 / 3 | 492 |
  | Page | reading | 286 | yes | 450 | 3 / 3 | 451 |
  | PageSized (`#page=2&height=400`) | live | 400 | no | 246 | 2 / 2 | 246 |
  | PageFar (`#page=99`) | live | 307 | no | 738 | 99 / 4 | 739 |
  | Embed (no page) | live | 307 | no | 0 | – / 1 | 0 |
  | Embed | reading | 286 | yes | 0 | – / 1 | 0 |

  ⟷ is absent in every live-edit block frame and present in reading view:
  SchemeHandler.swift marks a block document's `<html>` with
  `data-clew-block="1"`, which `IN_BLOCK` reads.
- **The cards** (measured inside the frames by a temporary vault plugin):
  - the password prompt at a 208 px viewer: the card 516 px tall in a
    631 px host, whole top to bottom (the lock icon and the bottom edge
    were clipped at f4feb68);
  - but its "Open" button runs past the card's right edge, cut off at the
    viewer's side (the card's content is 183 px wide in a 144 px card);
  - Broken.pdf's error card is 222 px wide, in a 208 px area in live edit
    and 192 px in reading view: 7–15 px clipped on each side. Upstream's
    own `card.fits` reports false.
- **Images within a line** (TwoImages.md, reading view): `![[a]] ![[b]]`
  draws two `img.internal-media` (width 120, loaded), with no "!" left;
  "Alone: ![[c|100]] and text after." draws the image in place; an
  own-line embed is still a block; a note embedded mid-line is still "!"
  and a link, as upstream intends.
- **A diagram in Live Edit, no grip:** the TikZ and mermaid frames' edges
  are 6 px with no `::after`. Each frame sits flush on its body. The
  "Edit source" icon (0.6 opacity on touch) reveals the TikZ source, and a
  long-press on the mermaid frame reveals its source.

### The index cache's frame (5,006 notes, a 5.4 MB cache)

A note is written, and the save follows 2 s later. Each run records every
frame for 8 s:

| build | the frame at the save | upstream's smoke log |
| --- | --- | --- |
| before: c7e1f88 (the indexer and shims of c0f2a20) | 133, 141, 146 ms | (one synchronous save) |
| facf011, upstream's save as ported | 115, 126 ms | build 23 ms, write 114 ms |
| bd795b5, the copy fixed | 21, 35 ms | build 22 ms, write 15 ms |

The write was the iPad's own. fs-promises.js's handle copied the bytes
with `Uint8Array.from`, as fs.js#writeSync always had, and WebKit walks a
Buffer (a Uint8Array subclass) byte by byte. On 5.4 MB that took 117 ms,
against 2 ms for a plain Uint8Array and under 1 ms for
`new Uint8Array(buffer)`. Most of the 150–175 ms frame of 2026-10-11 was
that copy. Both shims now use the constructor, so every writeFileAtomic in
the page (kv-store, history, rename-links) is faster too. The other steps,
timed alone on the same index: a whole-index stringify 23 ms, the slices
9 ms in total, the join 2 ms, the encode under 1 ms, the decode 2 ms, and
the bridge post 6 ms on the page's side (a raw 5.4 MB bridge write makes a
28 ms frame).

## Answers for Clew-boss

1. `wikiembedImage` is in src/shim/engine-config.js.
2. The indexer's yield: a MessageChannel message where setImmediate is
   missing, never a microtask; the 5,000-note frame is above.
3. The scheme handler sets `data-clew-block="1"` (SchemeHandler.swift,
   the block document's `<html>`). ⟷ is hidden in every block frame
   measured.
4. **`contain: inline-size` in WebKit:** it works. At a 276 px column the
   table wraps at words, a wider one scrolls inside its wrap, and nothing
   widens the note or the page.
5. **figureFonts:** iOS keeps today's behaviour, which is already
   upstream's rule. `figureFonts` is processFile's option for an EXPORT
   (export-worker.mjs). The iPad has no export that draws figures with
   TeX: its HTML share and its PDFs are the drawn preview. So nothing
   passes the option. The preview's figures ask
   `__clew_assets__/systemfonts/`, which SystemFonts.swift serves: a
   family's faces from CoreText, whole (a file per face, so bold and
   italic come with it), nothing for a family the device lacks, and
   nothing past `familyLimit`, 64 MB (upstream's FAMILY_LIMIT).
6. **How iOS makes a book's PDF:** EXPORT_BOOK takes only `print`. The
   engine renders the book (renderBook) in a one-shot Web Worker over a
   vfs snapshot, and a hidden WKWebView paginates that preview document
   into the share sheet. There is no latexmk and no TeX installation, and
   the worker's child_process refuses every call (`noProcesses`). iOS
   cannot spawn a process anyway. A book's PDF, LaTeX and HTML builds are
   refused ("building a book needs Clew on a Mac"), and Proof this chapter
   is refused by name. Nothing reads or writes build/.
   - **Config or code from a working folder:** the worker's cwd is
     `<vault>/.clew/engine`. The snapshot skips `.clew/` wholesale, then
     adds the generated `.jmarkdown/config.json` there. jmarkdown's other
     config path, `os.homedir()/.jmarkdown/config.json`, is `/home`, which
     is not in the snapshot. So a planted config never reaches the engine.
     Engine extensions are registry keys for pre-bundled modules, plus the
     engine surfaces of plugins the vault's access enables. A `latexmkrc`
     has no text extension, so it enters the snapshot as an empty stub,
     and nothing would run it anyway.
7. **A PDF via LaTeX in a restricted vault:** iOS has none, in any vault.
   A note's export other than HTML or the reading-view PDF throws "needs a
   LaTeX toolchain and is not available on iOS". The LaTeX engine row is
   dropped from Settings, and a book's PDF and Proof are refused (above).
   The only PDFs are the reading-view ones (WKWebView), which is where the
   Mac's refusal points. When the refusal arrives, check that its wording
   reads right on the iPad, or that no LaTeX command is offered to reach
   it (tests/no-latex-ui.test.js).

## Found, for upstream (not fixed here)

- **The password prompt's "Open" button** runs past the card's right edge
  at a 208 px viewer and is cut off at the viewer's side (content 183 px
  in a 144 px card). The height fits now. `card.fits` checks the card's
  box, not what is inside it.
- **A broken PDF's card is wider than a narrow viewer:** 222 px in a
  208 px area (192 px in reading view), clipped on both sides. The
  unbroken "FPDF_LoadMemDocument failed" sets its minimum width. Upstream's
  check already reports `fits: false`.
- Not re-measured in this sync: f4feb68's "`#height=` leaves the PDF 6 px
  down". With a page as well (`#page=2&height=400`), the viewport stands
  exactly at the page's top.

## iPad checks

- The index save on a big vault on the device: the frame 2 s after an
  edit (the simulator's 21–35 ms is on a Mac's CPU).
- The owner's "this article" table in Live Edit.
- A `#page=N` link in a note, in Live Edit and in reading view.
- Two images on one line in reading view, and in the HTML share.
- The password prompt at the narrow width: is "Open" reachable, or does
  Return in the field open it?
