# Upstream sync to Clew-app a14ec13, then 3f0f667 (2026-10-22)

Clew-boss's brief: Clew-app main was at a14ec13 (confirmed with ls-remote).
It carries the owner's C1, A1 and C4, and jmarkdown d63a871. The sync runs
from this port's 146107c sync, on top of the export figure cache.

Clew-app main moved to 3f0f667 while the sync ran. What that adds in the
vendored paths is the demo vault and its history, so this record covers it
too. Everything here is local and `[ci skip]`, for ONE TestFlight push once
Clew-boss has verified the chain.

## The range

- **cfdf3ef:** jmarkdown d63a871.
  - Mathematica names its outputs by the END of the path.
  - A header Title's entities show as characters in `<title>`.
- **42bb9c8 (C1): Obsidian's `%%` comments hidden**
  (engine/obsidian-comments.js), inline and as a block, never inside code
  or maths. An unclosed `%%` is text.
  - The preview's generated config lists the two rules.
  - Every export registers export-config.js#EXPORT_EXTENSIONS.
- **076ddb0, c5931bf, 2018bb8 (A1): a file TeX could not find becomes a
  build warning.**
  - shared/latex-engine.js#texMissingFiles reads the log's not-found
    lines, joining TeX's broken lines as bytes.
  - missingFileWarnings says each one.
- **a14ec13 (C4):** engine/latex-style.js#mathFontOnlyWithMaths takes the
  style's Garamond-Math line out of a .tex that has no maths.
- **3f0f667, with 5d4d8ee, ecdf0bf and b36b656:** the demo vault and its
  history.
  - Guide/Export.md now says what PDF via LaTeX runs on each device. This
    port's review of 875e177 had found that "runs your TeX toolchain" was
    false on the iPad.
  - The proof in Math and Theorems loses its own `$\blacksquare$`.
- fa01bb0 and 7fbdb72 are docs, and are not vendored.

## Phases (chained off the figure cache dbfa00b)

1. **`sync-a14ec13-p1-vendor` d4847a4:** the vendor, from `git archive
   a14ec13`. diff -rq is clean and the icon was put back.
2. **`sync-a14ec13-p2-build` 35a59d1, the iPad side:**
   - **C1:** engine-config.js lists `obsidianComment, obsidianInlineComment`
     after Meta Bind's, as desktop's render service does, and the render
     worker's registry carries the module. The export worker registers
     EXPORT_EXTENSIONS after importing the engine.
   - **A1:** typeset.js passes the last pass's mp-tikz-wasm `result.log`
     (whole under LuaLaTeX) to texMissingFiles. It will use texLogBytes once
     released, and falls back to the diagnostics. missingFileWarnings join
     the export's warnings.
   - **C4:** the export worker runs mathFontOnlyWithMaths over the .tex it
     wrote, so the .tex export and the PDF match.
   - **tools/sim-pdf-checks.mjs:** the device-path note's images are in
     angle brackets. The vault's path holds a space, so before this the
     bare link was not an image at all. The check now requires each image
     named.
3. **`sync-3f0f667-p3-vendor` 1cedf20:** the demo vault and its history.
   diff -rq is clean.
4. **`sync-a14ec13-p4-verify`:** this record, HANDOVER and the LaTeX plan.

## Checks

- npm 817 pass, 2 skipped. Swift 462/462 (ExportJobs 123, DemoSync 47).
- CLEW_PDF_SLOW=1 tests/export-host.test.js: 24/24. The PDF-identity test
  still matches p3e's PDFs (pages, images, fonts, text) after C4: a prose
  note never embedded the maths face.
- Every build.js patch anchor held.
- New tests, each with a mutation that fails it:
  - reading view hides an inline and a block comment, and keeps code's
    `%%` and an unclosed one;
  - the .tex export leaves the comments out, drops the maths font from
    prose and keeps it with maths;
  - a device-path PDF names each missing file.
- **Simulator** (tools/sim-pdf-checks.mjs, headless): 15/15.
  - A device-path PDF names both missing images.
  - A link out of the vault gives "not in this vault" and TeX's own "could
    not find".
  - An untrusted vault's figure is never kept in the figure cache.
