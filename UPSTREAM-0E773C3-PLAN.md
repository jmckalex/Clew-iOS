# Upstream sync to Clew-app 0e773c3 (2026-10-20)

Clew-boss's notice, 2026-10-20, after the owner pushed Clew-app 0e773c3.
Scope: its own chain off b1443f4 (the 0ada21d sync's build commit), kept
off main until Clew-boss has verified it. b1443f4 itself was pushed the
same afternoon, on the owner's word in this window.

## The range, 0ada21d..0e773c3 (14 commits)

- 0038ec3: jmarkdown at-migration efd8a39. `LaTeX maketitle` (opt-in): a
  body's title block becomes `\title`, `\author`, `\date` and `\maketitle`
  where it stands. A bare web address's `%` no longer ends a LaTeX line.
- 5c6caae: the export worker turns `LaTeX maketitle` on for every LaTeX
  build. Clew's style sets `\maketitle` through titling.
- cdde7df: exports read a header as reading view does (`Header style:
  fenced`), and HTML exports resolve citations with the vault's
  bibliography.
- afbf933: an HTML export cites in the vault's style, one decision
  (`vaultBiblify`) shared with reading view.
- 7c46c38: a list's indentation column in live edit is the font's space,
  measured (live/columns.js, `--le-col`). This fixes the 2 px this port
  reported for a quote in a nested item.
- 89bbbed: a TAB-indented list item's indentation is a box of its own
  (`le-indent-tabs`), four columns. The column follows a new face through
  a ResizeObserver.
- 330c74a (U3), 7af1883 (U5), 556f384 (U6), c4bd0f4 (U2), 12cff10 (U1, U4,
  U7): the export pipeline's decisions, factored so this port imports
  them (UPSTREAM-LATEX-EXPORT-PLAN.md §2):
  - src/shared/citation-files.js, src/shared/latex-engine.js and
    src/shared/export-figures.js, held to no Electron, fs or process;
  - engine/latex-style.js#latexStyleWanted, with an `ios` platform that
    names no emoji face;
  - engine/export-config.js: configureExportBuild, exportEmbedPath and
    noteExportOptions.
- 2675150, 366c32f, 0e773c3: smoke and tests only.

## Phases (one branch each, chained off b1443f4)

1. `sync-0e773c3-p1-vendor` 73ca10c: vendor from `git archive 0e773c3`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
   package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
   The regenerated icon was put back.
2. `sync-0e773c3-p2-build` 7ae2924:
   - noteBibFiles moved out of main/citation-header.js, which the build
     caught. src/shim/render-service.js imports it from
     shared/citation-files.js.
   - src/shim/engine-config.js's hand copy of desktop's #biblifyConfig is
     now `vaultBiblify` itself (U3). The two differed in one corner: the
     copy took `.CSL` off a style's name case-blind, and desktop's
     `path.basename(file, '.csl')` does not. This port follows desktop.
   - Every build.js patch anchor held. On this chain nothing patches
     export-worker.mjs or export.js; the L1 branch's patch is on
     jmarkdown's figure-engine.js, and comes back with L2. The app-bundle
     tripwire found no unguarded `process` read in the new shared modules
     (node:path only, aliased).
3. `sync-0e773c3-p3-verify`: this record.

## Checks

- npm test 791/791. Swift 339/339 in 7 suites. xcodebuild for the
  simulator: succeeded.
- Upstream's own tests for the changed modules (citation-header,
  export-config, latex-engine, latex-style, live-columns,
  shared-export-modules, list-keys, live-model), run in the archive whose
  src is byte-identical to vendor/clew: 111/111.
- **Nothing LaTeX changed on the iPad yet.** `LaTeX maketitle`, the fenced
  header and the export-config functions reach only desktop's export
  worker here. L2 (the .tex export) is their first iOS caller.

**In the simulator** (iPad Pro 11", portrait, demo vault, a fresh install).
The input is synthetic: no keystrokes. Clicks were measured with
CodeMirror's own posAtCoords, which a tap uses.

- **Boot:** Welcome.md renders (23,664 B, 95 ms). A block renders too: 17 KB
  in 125 ms, with its `\cite{lewis1969}` resolved under
  Features/Citations.md's header.
- **Quotes in lists** (upstream's live-list-quote scenario, with its new
  `deep` and `tabbed` cases), px from the item's text to the quote's border:

  | quote | Avenir Next (`--le-col` 0.25em) | Menlo (0.6021em) |
  | --- | --- | --- |
  | bullet | 0 | 0 |
  | numbered | 0 | **−5.6** |
  | nested | 0 (was **2**) | 0.66 |
  | deep (three levels) | 0 | 0.92 |
  | tabbed | 0 | 0.92 |
  | top (from the margin's text) | 0 | 0 |

  The nested item's later line and the text after a quote line up with
  their item's (0). Unrounded, every Avenir case is 0.39. The column
  followed the face change within the wait (the ResizeObserver).
- **A TAB-indented list** (upstream's live-list-tabs scenario). Every
  figure is the desktop's:
  - in Avenir Next: space step 16, tab steps 16 and 16, mixed vs tab 0;
    the tab is drawn 16 wide;
  - in Menlo: 39, 39, 39 and 0; the tab is drawn 39 wide;
  - `le-indent-tabs` is on the tab-indented lines (including ` \t`) and
    not on the space-indented one;
  - a point on the tab's left half maps to position 0 and its right half
    to 1, and the caret after the tab is drawn at its right edge (0). The
    desktop's real clicks gave `[0,1]`.
- **The vault's bibliography, through the shared module:**
  - with none set, a headerless note's `\citet{lewis1969}` stays raw;
  - with the vault's set to Features/refs.bib in APA, it reads "Lewis
    (1969)", and the reference list carries "Harvard University Press";
  - a note's own header still resolves (Features/Citations.md).
- **Settings:** the LaTeX export style's row stays dropped.

## Found

- **For upstream (small):** in a monospace editor face (Menlo), a quote
  in a NUMBERED item stands 5.6 px left of its item's text. The number is
  drawn in Menlo, 28.9 px wide, while the item's hang is a fixed 22.4 px
  (`text-indent: -22.4px`, `padding-left: 46.4px`), so the text moves
  right and the quote doesn't. In Avenir Next the number is 22.39 wide
  and the case is 0. The desktop's scenario measures only nested, deep
  and tabbed in Menlo, so this looks like the desktop's too. No iOS patch
  touches live edit.
- Menlo's sub-pixel remainders (0.66–0.92 px) round to 1. The desktop
  logs 0. They are below a pixel and not a finding.

## iPad checks (the owner, on TestFlight)

- A quote under a nested list item in Live Edit stands under the item's
  text (it stood 2 px right before).
- A note indented with tabs (Obsidian's default) in Live Edit: each level
  is four columns in, and a tap on either half of a tab places the
  caret as the desktop does.
