# Upstream sync to Clew-app f0aeaa4 (2026-10-15)

Approved by Clew-boss on 2026-10-15, after the 07810a8 push's cloud build
passed (Clew-app f0aeaa4 pushed and verified upstream).

## The range, ef5f7f2..f0aeaa4 (5 commits)

- d83b49b: a PDF via LaTeX runs latexmk and biber with the user's own
  configuration, never a file in the build folder. A book compiles in the
  vault's build/, where a planted `latexmkrc` ran as Perl in a restricted
  vault.
- f23173d: the TeX tools' PATH keeps absolute folders only
  (fs-utils.js#absoluteSearchPath).
- 0520b2c: no PDF via LaTeX in a vault this device does not trust. A
  note's, a book's and a chapter proof are refused by name, pointing to
  the reading-view PDF or Trust (the owner's decision). The renderer shows
  `result.refused` as a notice.
- c2c3fb4: EmbedPDF's card for a PDF it cannot open stays whole in a
  narrow viewer (preview-client/pdf-card-fit.js; the iPad's 208 px
  report).
- f0aeaa4: the colon sheet's folds go into a div of their own
  (`.clew-colon-rows`), and the content-visibility rule on them is gone
  (the iPad's measurement: 65 s to fill 4,001 folds, and find blind to
  skipped ones).

## Phases (one branch each, chained off main 07810a8)

1. `sync-f0aeaa4-p1-vendor` 1614e3f: vendor from `git archive f0aeaa4`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
   package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
   The regenerated icon was put back.
2. `sync-f0aeaa4-p2-build` 708da28: the only anchor that moved is the
   figures row's hint (0520b2c), whose row this port drops. Every other
   patch holds.
3. `sync-f0aeaa4-p3-verify`: this record.

## Checks

- npm test 789/789. Upstream's latexmk-command, latex-engine and pdf-size
  tests against vendor/clew: 42/42. Swift 339/339 in 7 suites. xcodebuild
  for the simulator: succeeded.
- **The desktop's guards are inert here.** The app bundle holds no
  `absoluteSearchPath`, `toolchainPath`, `latexmk` or `biber`. They live in
  desktop main's export.js, export-book.js, latex-engine.js and
  render-service.js, which the page does not import. iOS runs no TeX tool
  and cannot spawn a process.
- **The refusal.** iOS has no PDF via LaTeX in any vault, so the new
  `refused` answer is never sent here. Measured in the simulator:
  - `clew:export-note` with `pdf` or `latex` throws "… export needs a
    LaTeX toolchain and is not available on iOS";
  - `clew:export-book` with `pdf` throws "building a book needs Clew on a
    Mac".
  The new hint words are on the figures row, which iOS drops. A book's PDF,
  LaTeX and HTML commands and Proof are not registered
  (tests/no-latex-ui.test.js).
  - **But the palette still offers the note's two:** "Export note as
    LaTeX (.tex)" and "Export note as PDF (via LaTeX)" (builtin.js). No
    iOS patch removes them. Run, they alert "Export failed: … needs a
    LaTeX toolchain and is not available on iOS". That has been so since
    the port began (UPSTREAM-F959799-PLAN.md lists them as refused).
    Dropping them, as the book's were dropped, is the owner's call.

**In the simulator** (iPad Pro 11", portrait):

- **EmbedPDF's cards**, through the `test-pdf-size` hook and pdf-card-fit's
  own `cardFit` (fits, px past, width):

  | note | viewer | view | card height | fits | past | width |
  | --- | --- | --- | --- | --- | --- | --- |
  | BrokenNarrow (`#width=208`) | 208 | live | 284 | yes | 0 | 183 |
  | BrokenNarrow | 208 | reading | 284 | yes | 0 | 183 |
  | LockedNarrow (`#width=208`) | 208 | live | 430 | yes | 0 | 183 |
  | LockedNarrow | 208 | reading | 430 | yes | 0 | 183 |
  | Broken (sidebars open) | 208 | live | 284 | yes | 0 | 183 |
  | Locked (sidebars open) | 208 | live | 430 | yes | 0 | 183 |
  | Broken (sidebars closed) | wide | live / reading | 262 | yes | 0 | 260 |
  | Locked (sidebars closed) | wide | live / reading | 388 | yes | 0 | 384 |

  At 208 px "FPDF_LoadMemDocument failed" wraps inside the card, and the
  prompt's Cancel and Open both sit inside it (at ef5f7f2 the error card
  was 222 px in 208 and Open ran past the edge). At the wide width the
  prompt is EmbedPDF's own 384 px (`max-w-sm`) and 388 px tall, the
  height the desktop measured before.
- **The colon sheet's folded 4,001-note list** (the 5,006-note vault):

  | | ef5f7f2 (rule on, folds in the details) | f0aeaa4 (as shipped) |
  | --- | --- | --- |
  | unfold: wall, frames | 65,199 ms, 1,056 | 178 ms and 187 ms, 19 |
  | unfold: median / p99 / max | 63 / 72 / 77 ms | 17 / 39–43 / 39–43 ms |
  | scroll to the bottom (90 steps): median / p99 / max | 17 / 19 / 33 | 17 / 18–25 / 25–34 |
  | fold back, reopen: median | 17 | 17 |
  | find an off-screen fold (`window.find`) | not found | found, and scrolled into view |
  | focus an off-screen fold | focused, in view | focused, in view |
  | scrollIntoView a middle fold | lands at 0, no drift | lands at 0, no drift |

  The folds compute `content-visibility: visible`. The list is 100,629 px
  tall (23 px a fold).
- **Regressions:** the f4feb68 table pair (9 / 11 live classes, 4 / 12
  cells) and "this article" (callout, 4 KaTeX, TikZ, table, nothing raw),
  with no errors or warnings. The TikZ and mermaid frames' edges are 6 px
  with no grip.

## Found

- Nothing new for upstream.
- For the owner: the palette's "Export note as LaTeX (.tex)" and "Export
  note as PDF (via LaTeX)" (above).

## iPad checks

- A password-protected PDF and a broken one in Live Edit with both
  sidebars open: the card whole, and Open reachable under a finger.
- "Convert this vault" on a big vault: the folded list opening at once.
