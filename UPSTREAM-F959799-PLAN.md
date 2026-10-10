# Upstream sync to Clew-app f959799 — plan and record

**STATUS: EXECUTED 2026-10-10, VERIFIED by Clew-boss.** Pinned by Clew-boss
under the owner's standing order to drive the port through to a TestFlight
build. Main is fast-forwarded to p4 with a build commit on top; the push
waits for the owner's word typed in this window.

The chain, off main 35c8922:
- `syncf959799-p1-vendor`: dc04437.
- `syncf959799-p2-build`: 38bf6b0.
- `syncf959799-p3-contract`: cbec7c6.
- `syncf959799-p4-verify`: this record.

**PIN: Clew-app `f959799`.** It was copied from `git archive f959799`.
`diff -rq` against the archive shows no difference in vendor/clew,
vendor/jmarkdown (21dee42), vendor/embedpdf, vendor/default-stamps or
seed-vault. The range 6b6fbbb..f959799 has 11 commits; 1eca9a5, 235b27a,
693bba2, 4c095fa and f959799 are docs.

**mp-tikz-wasm:** unchanged, v0.4.0 + Ghostscript, release-staged
("pinned v0.4.0 + ghostscript", the same two archive pins, 4,272 files).

**Version:** 0.12.0, unchanged. The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| jmarkdown cf5ed60 → 21dee42: the book map, the LaTeX include layout with `\includeonly`, and **figure-engine.js** (TikZ and MetaPost through mp-tikz-wasm in the engine, off unless asked) | p2: **bundled and inert.** Its imports (fs, os, path, crypto, url) go to the worker's shims. The library is a runtime `import()` of a file URL under `MP-TikZ dist`, which esbuild leaves alone, and it runs only when `Figure engine` is auto or wasm and a dist is named. The iPad's generated engine config sets neither key, so the worker never takes that path. A guard test holds this. |
| Proof this chapter (ef22b0b, book-proof.js; the Book panel row, the palette, the menu) | p3: **hidden.** build.js drops the palette command and never builds the row (`at` is -1). As a backstop, EXPORT_BOOK refuses `proof` by name: "Proof this chapter typesets with LaTeX, which the iPad does not have — proof it in Clew on a Mac". |
| Exports: what draws TikZ and MetaPost (2cc6d89; the exportFigureEngine setting, a restricted vault always on mp-tikz-wasm, the stand-ins) | p2 carries the key (`exportFigureEngine: 'external'`) so the defaults hold every upstream key; p3 drops its Settings row. The setting chooses between desktop's installed tools and mp-tikz-wasm for desktop's note and book exports, and the iPad has neither. |
| The parity gate (282fde3) | **n/a.** A desktop smoke over EXPORT_BOOK's HTML build with `bookMap`. The iPad has no HTML book build, and nothing the writer sees reads the engine's map. |
| The export cache (export-cache.js: figureEngineOptions, texRefusalDir, the stand-ins) | **n/a.** It serves desktop's LaTeX, PDF and HTML exports through Node and the installed tools. The iPad's exports are reading view's own document. |
| Menus (menu.js `needs: 'chapter'`, menu-bridge.js `chapterActive`) | Nothing: the iPad has no app menu, and the shim ignores the menu state. |
| render-service.js `CLEW_SMOKE_NO_TEX`; the smokes | Desktop scenarios only. |

**Latent, if the figure engine is ever turned on in the worker:**
figure-engine.js's runAll() awaits `setImmediate`, which the worker does not
define (HANDOVER §3 says so too). It is left unshimmed while nothing reaches
it.

## Results (simulator, iPad Pro 11" M4, iOS 18.6; ALL GREEN)

**(1) Proof this chapter is not offered, and a book still prints**
(Signals open at its chapter 2, Conventions):
- The palette, searched for "proof", lists only "Export book as PDF (via
  LaTeX)" and "Export book as PDF (reading view)": no Proof command.
- The Book panel shows "Build: Print PDF" and **0 proof rows**, with
  Conventions active (screenshot).
- `clew:export-book {format: 'proof'}` is refused with the sentence above.
- **Signals printed:** 1.0 s from the request to the share sheet, 5 A4
  pages.

**(2) Figures in the iPad's exports today** (Features/Diagrams: 9 TikZ and
2 MetaPost figures). Each count is from a probe in the document itself:

| Export | Figures drawn | How |
|---|---|---|
| Reading view (no export, the control) | **11 / 11** in 5.8 s | the preview's mp-tikz-wasm |
| Note → **PDF** (reading view's print) | **11 / 11** in 5.3 s; 6 A4 pages | the same preview code, in the print's own web view; the print waits for `__clewFiguresPending() == 0` |
| Book → **Print PDF** (a one-chapter book of Diagrams, `?book=1`) | **11 / 11** in 5.7 s; 6.8 s to the share sheet; 7 A4 pages, the chapter from page 2 | the same |
| Note → **HTML** (`Diagrams.html`, 34,250 bytes, shared as text) | **0 / 11** | each figure is a `<tikz-diagram>` or `<metapost-diagram>` holding its TeX or MetaPost source. The page's scripts and styles are `/__clew_assets__/…` URLs, which resolve only inside Clew. Opened elsewhere (Quick Look), the figures, the Mermaid diagrams and the maths all show as source text, unstyled. |
| Note → LaTeX, PDF via LaTeX | refused | "latex (pdf) export needs a LaTeX toolchain and is not available on iOS" |
| Book → PDF, LaTeX, HTML | refused | "building a book needs Clew on a Mac" |

**Would the figure engine draw them there? No, not as things stand.**
- Every iPad export path is the preview's render, and in it Clew's
  figures.js claims all six figure syntaxes as preview elements. The
  engine's own TikZ and MetaPost code, which is where figure-engine.js
  hooks in, never sees them. On desktop, exports run the user's own config
  cascade without figures.js, so the engine's syntax (`:::TiKZ`,
  `@begin(TiKZ)`, `@begin(metapost)`) reaches figure-engine.js, and
  Clew's fences do not (an open owner question).
- In the worker, the library would not load as written: `MP-TikZ dist` is
  `path.resolve`d and imported as a `file://` URL. Its output goes to a
  vfs cache that the shared single HTML file never carries, and
  `setImmediate` is missing.
- The PDF paths already draw every figure. Only the HTML export lacks
  them. The likelier route there is to carry the SVGs the preview has
  already drawn into the shared file, as desktop's site export bakes its
  figures, rather than to run the engine's figure engine in the worker.
  That is a plan for Clew-boss, not part of this sync.

**Tests:** npm test 773; Swift 154 + 44 + 18 + 9 + 47 + 36; xcodebuild OK.

## iPad checklist (after the push)

- In a book's chapter, the Book panel shows Print PDF and no Proof row.
- Print a book with figures (a chapter like Features/Diagrams): the figures
  are in the PDF.
