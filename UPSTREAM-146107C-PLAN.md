# Upstream sync to Clew-app 146107c (2026-10-22)

Clew-boss's brief came after Clew-app main was pushed at 146107c, which
Clew-boss confirmed with ls-remote. The sync runs from this port's 0768f36
sync (UPSTREAM-0768F36-PLAN.md). It is stacked on PDF via LaTeX's P3
branches, with every commit local and `[ci skip]`.

The goal is a chain ready for a TestFlight push that carries PDF via LaTeX
for the owner's iPad mini test. That push needs the owner's word, typed in
this window.

## The range, 0768f36..146107c (2 commits)

- **48aea4d: mp-tikz-wasm pinned to 0.5.0** (tag v0.5.0 = d44aeeb) in
  shared/mptikz-manifest.json.
  - The pinned assets are the published ones: main 76b5591a… (50,933,680
    bytes), Ghostscript d820e454… (8,629,227), and the source offer
    2096e4fc….
  - shared/latex-engine.js#BUILT_IN_TEX names what a host's built-in TeX
    asks of the library: default + opentype + otf-fonts + latex-doc, with
    `date: 'now'`.
  - Upstream also adds tests/built-in-tex.test.js and the notices for
    BibTeX, makeindex, EB Garamond and Garamond-Math.
- **146107c: jmarkdown 2928d5d.** In LaTeX, a `%` the HTML shows is
  written `\%` in a note without front matter. Before this, TeX took it as
  a comment: the rest of the line was lost, and inside an argument the
  build stopped.

## Phases (chained off p3f 9fe2665, local, `[ci skip]`)

1. **`sync-146107c-p1-vendor` 901378b:** the vendor, from `git archive
   146107c`.
   - diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
     package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
   - The regenerated icon was put back.
2. **`sync-146107c-p2-pin` 254fb82:**
   - typeset.js imports `BUILT_IN_TEX`, for its bundles and default date.
   - mptikz-assets/ is restaged with `stage-mptikz.js --release --force`
     from the pin the vendor now carries. The published assets are
     sha256-verified, and STAGED.json says `release`.
   - The staged tree is byte for byte the old local override's (4,854
     files), so the override is gone without a change.
   - Xcode Cloud's ci_post_clone.sh stages from the same manifest.
   - A test for jmarkdown's `%` fix runs through this port's own build.
3. **`sync-146107c-p3-verify`:** this record and HANDOVER.

## Checks (on the pinned assets)

- npm 810 pass, 2 skipped (the PDF-identity test runs only under
  CLEW_PDF_SLOW).
- Swift 426/426.
- CLEW_PDF_SLOW=1 tests/export-host.test.js: 20/20. That includes the same
  PDFs as p3e by pages, images, fonts and text, for Citations, Long, Media
  Gallery, Diagrams and Many, styled and unstyled.
- Every build.js patch anchor held. The build's one warning, a duplicate
  "Highlight theme" key in jmarkdown's config-manager.js, predates this
  sync (it is in the 0768f36 build's log). It is an upstream nit.
- Upstream's own tests for the changed modules, run in the archive with
  `CLEW_MPTIKZ_DIR` on the pinned tree: 91/91. They were built-in-tex
  (not skipped), latex-engine, latex-style, latexmk-command,
  shared-export-modules, figures and figure-errors.
- **jmarkdown's `%` fix, end to end.** A note without front matter, `# 100%
  Sure` with `%` in its prose, italic, strong and a link, gives a PDF via
  LaTeX whose text reads "100% Sure" and "The rest of this line survives."
  It does so styled and unstyled. Against the old jmarkdown the PDF fails
  to build (the new test's mutant).
- **Simulator:** `node tools/sim-pdf-checks.mjs` on a Debug build whose app
  bundle's mptikz STAGED.json says `release`. Headless; 14/14:
  - texmf;
  - limit (Clew's 30 s; the watchdog at 60 s in desktop's words);
  - the restricted cases.

## For the App Store list (not for TestFlight)

- The iOS app ships no third-party notices. 0.5.0 adds BibTeX and
  makeindex as wasm, and EB Garamond and Garamond-Math (OFL) in latex-doc.
  Upstream's THIRD-PARTY-NOTICES now carries makeindex's distribution
  notice, byte for byte.
- This belongs with the Ghostscript (AGPL) decision that is already owed
  before the App Store.
