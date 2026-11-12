# Upstream sync to Clew-app cfa279b (2026-11-12)

Clew-boss's brief relayed the owner's words: "Please ask Clew-iOS to update
the iOS app to contain the File Explorer adjustment." The explorer is Clew-app
cd39a81 + cfa279b, on origin/main at cfa279b. The route was this port's call;
it is everything since the last sync, so the range runs from the vendor's
3f0f667 to cfa279b (20 commits). The explorer comes in its own two phases, so
it can be checked on its own. Everything here is local and `[ci skip]`, for
ONE TestFlight push once Clew-boss has verified the chain.

## The range

Before the explorer, 3f0f667..21d6d0f, five vendored files:
- **shared/latex-engine.js:**
  - firstLatexHelp (461cc46): a failure gives the first error's help;
  - the first error and its help without TeX's terminal instructions
    (9d21f55, 8ea4594);
  - a LaTeX3 error's help on the Mac too (21d6d0f);
  - texMissingFiles' comments name 0.5.1's texLogBytes (cb0231e).
- **shared/mptikz-manifest.json:** mp-tikz-wasm 0.5.1 (a90dad9). Only
  its JavaScript changed: what `latex()` says when a document fails,
  `result.texLogBytes`, and a package's error whole.
- **jmarkdown at-migration 794cc9c** (58b8331, 80b6f20):
  - a proof's ∎ ends its last paragraph;
  - Mathematica: a failed run is an error box and a build warning in
    jmarkdown's own words (failureMessage); an inline result is read from
    the cache folder; results escaped.

The rest of that part of the range is not vendored: fixtures, smoke
harnesses, GitHub's test workflow, stage-mptikz's Linux tree, and HANDOVER
and release notes.

The explorer, 21d6d0f..cfa279b (the owner's ask, 2026-11-12):
- renderer/components/panels/clew-file-explorer.js and
  renderer/styles/panels.css: every row has the chevron's 12 px slot, a
  level is 16 px (`--tree-depth`), and a 1 px guide runs under each open
  folder's chevron.
- renderer/lib/file-icons.js and file-icons-data.js: Material Icon Theme's
  icons by name, with the `_light` variants on a light page. The keys are
  lowercased (cfa279b).
- vendor/material-icons/: 631 SVGs, LICENSE (MIT) and VENDOR.md, 524 KB.

## Phases (chained off origin/main 0b7c028)

1. **`sync-cfa279b-p1-vendor` b777db1:** the vendor from `git archive
   21d6d0f`. diff -rq is clean; the icon was put back.
2. **`sync-cfa279b-p2-build` 69a9156:**
   - **typeset.js** hands pdfViaLatexFailure the last pass's
     `diagnostics` with the log (461cc46's contract), so the first
     error's own help is read there first, or none.
     - Through the pinned build, a missing package, no
       `\begin{document}` and a primitive `\input` give the Mac's words
       exactly (Clew-app's SIDE_BY_SIDE).
     - `log: r.texLog` and Clew-app's `log: r.log` give the same message
       on all five probes (those three, a missing family, a body
       `\usepackage`), so the log stays.
   - **Mathematica's words:** jmarkdown's new failureMessage never reads
     an error's message (on a Mac that is the command line, naming the
     user's folders), so the iPad's sentence became "ENOENT", in the
     block's "Show Error Log" and the export's new warning.
     - The no-processes shim's error carries the sentence as
       `hostMessage`.
     - scripts/build.js has failureMessage say it first, in both workers.
     - **Upstream candidate:** failureMessage reads a host's own words
       (`error.hostMessage`), which retires the patch.
3. **`sync-cfa279b-p3-explorer-vendor` 1b9a213:** the vendor from `git
   archive cfa279b`, vendor/material-icons/ included. scripts/sync-upstream.js
   copies that folder now. diff -rq is clean.
4. **`sync-cfa279b-p4-explorer` 54a3a64:** stageStatic copies
   vendor/material-icons/ to webroot/file-icons/, beside index.html, the
   LICENSE with them.
   - The explorer's touch-drag patch still applies.
   - The iPad has no acknowledgements list to add Material Icon Theme
     to: the app ships no third-party notices yet (an App Store item,
     UPSTREAM-146107C-PLAN.md). The set's LICENSE ships in the app with
     the icons.
5. **`sync-cfa279b-p5-verify`:** this record and HANDOVER.

## Checks

- npm test 822 pass, 2 skipped (at p4). Swift 462/462 (at p2; nothing
  native changed after it).
- CLEW_PDF_SLOW=1 tests/export-host.test.js: 27/27 (at p2). The
  PDF-identity test still matches p3e's PDFs under 0.5.1: pages, images,
  fonts and text.
- Every build.js patch anchor held.
- New tests, each failing under a mutation:
  - typeset: the diagnostics' first help paragraph ends the message
    (fails without the diagnostics passed);
  - the pinned build's three failures in the Mac's words;
  - a Mathematica block's error log, and a trusted vault's LaTeX export
    warning, say "wolframscript cannot run on iOS: …", never ENOENT
    (both fail without the build patch);
  - every icon the table can name is beside the app page in both themes,
    byte for byte, with the LICENSE (fails without the copy).
- **Simulator** (iPad Pro 11" M4, headless, every run ending uninstalled
  and shut down):
  - **tools/sim-explorer-checks.mjs: 9/9.** Clew-app's
    explorer-icons-scenario checks on its fixture:
    - indent over 29 rows, and guides;
    - every icon loaded in both themes;
    - each row's icon the one its name gives;
    - page.jinja is jinja.svg, then jinja_light.svg on a light page, then
      jinja.svg again.
  - Rows are 22 px (desktop 21). The 16 px icon is no taller than the
    text line, so the row's height is still the text's, and touch
    targets are as before. Screenshots: explorer-dark.png and
    explorer-light.png.
  - **The boot:** the demo vault opens, its explorer draws 55 icons, a
    note and a block render, and Math and Theorems' proof ends with
    `qed">∎</span></p>`.
  - **tools/sim-pdf-checks.mjs under 0.5.1: 15/15** (texmf, the limit
    at 30 s and 90 s, restricted).

## Findings

- **Upstream candidate (both hosts): a long path in the first error is
  cut by spaces.** The restricted preamble case's message reads
  "File `/Users/…/Devices/90DCB 612-1B85-…/Application/D5013CED-082F-
  4043-…/secret.tex' not found." TeX ends a log line after 79 bytes
  (LuaTeX after 80), and shared/latex-engine.js#firstLatexError joins its
  lines with a space, so a space lands where TeX broke the line.
  texMissingFiles already joins such lines whole, and so do 0.5.1's
  diagnostics. The Mac reads latexmk's .log with the same breaks. A real
  iPad's paths (/private/var/mobile/Containers/Data/Application/<UUID>/…)
  are as long. The check passes, since it looks for "secret.tex' not
  found" alone.
- **Upstream candidate:** jmarkdown's failureMessage reads a host's own
  words (p2).

## iPad checks

- The explorer under a finger: a tap on a row, a slow drag scrolls (the
  touch-drag patch), a long vault's scroll.
- Both themes, and a switch between them, on the device.
