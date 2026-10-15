# Upstream sync to Clew-app f4feb68 (2026-10-15)

Ordered by Clew-boss on 2026-10-15, pinned to Clew-app `f4feb68` after its
own check (npm 1251/1251; the new live-block-field tests 0/5 on the old
main, 5/5 here). One sync, two reasons:

- **A note holding a table lost its whole live edit.** Clew-app 8619a67
  (book numbering) handed `tableWidget` a `numbering` it did not have.
  The throw escaped the block field's create, so the editor kept no live
  edit at all for the note while the tab still said Live: raw `**bold**`,
  images as `![[…]]`, callouts as `> [!note]`, tables as pipes. On the
  iPad it came with the 5abf52d sync (bc75a13) and has been on TestFlight
  since 94f0571 (2026-10-10). The owner hit it on the device ("this
  article", 2026-10-15).
- **The PDF embed's height went upstream** (ed6ffb0, 2e80ff4): the iPad's
  module (9b0b67e), with desktop fixes. The iPad's 7 build patches, its
  src/preview/pdf-size.js and its tests go.

## The range, 185e950..f4feb68 (6 commits)

- 6b97acb: jmarkdown at-migration 389b3a1 (LaTeX for feedback, sources
  and targets, markdown-demo, title-box and the title page; one title
  when the body prints its own).
- 89d6a8b: handover (docs only).
- ed6ffb0 + 2e80ff4: preview-client/pdf-size.js and pdf-embed.js; a
  scenario hook (`test-pdf-size`) the desktop's smoke and this sync's
  probes use. Upstream's additions to the iPad's module:
  - a PDF EmbedPDF cannot open (broken, or behind a password) is held
    at toolbar + 440 px, EmbedPDF's own card or prompt; a password that
    opens it makes it one page again;
  - a one-page PDF gets ⌈page⌉ + 10 px (the line box under the pages);
  - fit width is asked at the viewport's top-left corner;
  - corrections are counted per width since the last quiet.
- e7d03c6: `tableWidget` is handed the note's numbering.
- f4feb68: each construct is drawn under `guarded()`. A throw takes back
  what that construct pushed, leaves it as source, and warns once per
  kind and message ("[clew live edit] a table could not be drawn; it
  shows as source"). The numbering is asked for lazily, only by tables
  and numbered equations.

## Phases (one branch each, chained off main 9b0b67e)

1. `sync-f4feb68-p1-vendor` 57f8959: vendor from `git archive f4feb68`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src
   and package.json), vendor/embedpdf, vendor/default-stamps or
   seed-vault. The regenerated icon was put back.
2. `sync-f4feb68-p2-build` 8e12ea7: the 7 pdf-embed patches,
   src/preview/pdf-size.js and tests/pdf-size.test.js go. Every other
   patch anchor holds. In the bundle, tableWidget takes the numbering as
   an argument, and no preview client has `70vh`.
3. `sync-f4feb68-p3-verify`: this record.

## Checks

- npm test 788/788: main's 802, less the 14 local PDF tests. Upstream's
  new tests, run against vendor/clew with this tree's node_modules:
  live-block-field 5/5, pdf-size 20/20.
- Swift: all 7 suites green (339 tests). xcodebuild for the simulator:
  succeeded.

**In the simulator** (iPad Pro 11", portrait, both sidebars open, so the
editor column is ~450 px):

- **Tables.** The same note, with and without a 3-line table: before
  (9b0b67e), the table version had 0 live classes, raw bold, the image
  as text and the callout as source, plus "Can't find variable:
  numbering". Now both versions draw the image, the callout and hidden
  bold marks (9 live classes without the table, 11 with it), the table
  is drawn (4 cells; a 4×3 table gives 12), and there are no errors and
  no warnings.
- **The owner's note** ("this article", rebuilt from the screenshot:
  callout, `*test*`, inline `$\displaystyle…$`, `:::TiKZ`, a pipe
  table):
  - before (9b0b67e): every construct raw, as in the owner's
    screenshot;
  - now: the callout, italics, maths (4 KaTeX), the TikZ frame (the
    arrow drawn) and the table are drawn; nothing raw; no errors.
- **The guard.** The original bug was put back into the INSTALLED app's
  bundle (`qm(…,t,i)` → `qm(…,t,numbering)`, in the simulator only;
  nothing committed). In WithTable the image, the callout and the bold
  stay live (9 live classes) and only the table is undrawn. In the
  owner's note the callout, the maths and the TikZ frame are drawn and
  only the table shows as source. One warning came across both notes.
- **PDF sizes**, through upstream's `test-pdf-size` hook:

  | case | live edit | expected |
  | --- | --- | --- |
  | Paper.pdf (4 letter pages) | viewport 256, fit-width, top 0 | ⌊256.4⌋ |
  | `#height=400` | host 400 | 400 |
  | A4 `#width=60%` | viewport 137 in a 228 column | 60% |
  | Wide.pdf (landscape) | 157 | ⌊157.6⌋ |
  | One.pdf (1 page) | 274 | ⌈263.3⌉ + 10 |
  | Broken.pdf | host 496, status error, EmbedPDF's card | 56 + 440 |
  | Locked.pdf (qpdf, "secret") | host 496, the password prompt | 56 + 440 |
  | Locked.pdf, password entered | host 325, viewport 274, fit-width | as One.pdf |

  Reading view: Paper.pdf 235 = ⌊235.4⌋ at width 192; Broken and Locked
  496. The password was entered by a temporary vault plugin inside the
  block frame (the native value setter, then a click on Open).

## Found, for upstream (not fixed here)

- **The password prompt does not fit at the iPad's narrow width.** At a
  208 px viewer, EmbedPDF's card is 516 px tall in a 445 px area: the lock
  icon is clipped at the top, and Cancel and Open are cut off at the bottom
  (Open also overflows to the right). The 440 px was measured on the
  desktop (prompt 388 px). Measure the card instead, or allow a minimum
  height by width.
- **With `#height=` set, the document sits 6 px down** (viewport top 6).
  The return for a set height comes before the settle-to-top step.
- **The live table squeezes its columns letter by letter** beside a long
  cell at the iPad's narrow column ("A / h / e / a…"). live-edit.css sets
  no wrapping on `.le-table` cells, so they inherit CodeMirror's
  `.cm-lineWrapping` (`word-break: break-word; overflow-wrap: anywhere`).
  A cell's min-content width is then one letter, and the table's auto
  layout gives the long cell everything else. Reading view wraps at words.
  A likely fix is `overflow-wrap: normal; word-break: normal` on
  `.le-table th, td`.
- The demo vault's `Attachments/Holiday/Colosseum.jpg` is a small copy of
  Waterhouse's Ariadne (content, not code).

## iPad checks

- The owner's "this article" in Live Edit on the device.
- A password-protected PDF in Live Edit with the sidebars closed, and in
  landscape.
- From the PDF height (9b0b67e): the owner's 373-page PDF in landscape;
  annotating in a one-page embed.
