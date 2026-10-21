# Upstream sync to Clew-app 0768f36 (2026-10-21)

Clew-boss's brief, on the owner's "Go with the plan" (typed in Clew-boss's
window, about 15:26Z): sync Clew-app 0768f36, which is LOCAL there (its
origin is still 0e773c3), on a new local branch from 841ca1f, then PDF via
LaTeX in the simulator. No push and no device install.

## The range, 0e773c3..0768f36 (4 commits)

- a9284a9: jmarkdown ba83371. Under `LaTeX maketitle` the body's title
  block is the PDF's Title. Two opt-in features come with it:
  `LaTeX highlighter: highlight.js` (J2, the coloured code stand-in) and
  setFigureLibrary (J1).
- 2fc3459: in live edit, a numbered item's hang is its number's box
  (`--le-mark`). This fixes this port's report: in Menlo, a quote in a
  numbered item stood 5.6 px left of its text.
- c504a9e: `explainMermaidWarning(warning, platform)`, through
  explainFiguresWarnings' new `platform`.
- 0768f36: jmarkdown 551485a. It brings:
  - entities in LaTeX, and `%` in the title, author and date;
  - GIF, WebP, BMP and AVIF images as links with a warning, as SVG;
  - `LaTeX T1 fonts: lmodern` (config or host only, off by default);
  - code containing `\end{minted}` set in a minted environment of its own
    (\newminted);
  - source lines after multi-paragraph notes.

## Phases (chained off 841ca1f, local)

1. `sync-0768f36-p1-vendor` 7c9270a: vendor from `git archive 0768f36`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
   package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
2. `sync-0768f36-p2-build` b76b2c0:
   - EXPORT_NOTE `latex` passes `platform: 'ios'`, so a Mermaid diagram
     left out of the .tex says the iPad cannot draw it for print and
     reading view still shows it;
   - the L2 record's SVG sentence is corrected (Clew-boss's run): an SVG
     is a link and always was, and GIF was the fault, a link now too;
   - every build.js patch anchor held, the figure engine's
     library-by-URL patch among them.
3. The PDF work follows on `latexpdf-p2-compile` (UPSTREAM-LATEX-EXPORT-PLAN.md
   §4, "P2 as built").

## Checks

- At p2: npm 800/800, Swift 411/411. Upstream's own tests for the changed
  modules (export-cache, shared-export-modules, live-columns, live-model,
  export-config, latex-style), run in the archive: 88/88.
- **In the simulator** (iPad Pro 11", quotes in lists, px from the item's
  text):

  | quote | Avenir Next | Menlo |
  | --- | --- | --- |
  | in `1.` | 0.39 | 0.89 (was −5.6) |
  | in `10.` | 0.72 | 0.53 |
  | nested | 0.39 | 0.66 |

  A "more of item ten" line after the quote measured −10 in Avenir and 0
  in Menlo, but in that fixture the line is the quote's lazy continuation,
  not the item's. It is not a finding; it needs a clean fixture.

## For the owner, on TestFlight (once pushed)

- A quote under a numbered item, in a monospace editor face, stands under
  the item's text.
