# Upstream sync to Clew-app 6b6fbbb — plan and record

**STATUS: EXECUTED 2026-10-10.** Pinned by Clew-boss under the owner's
standing order to drive the port through to a TestFlight build. Commit
locally; the push waits for Clew-boss's check and the owner's word typed in
this window.

The chain, off main 94f0571:
- `sync6b6fbbb-p1-vendor`: 5a11f45.
- `sync6b6fbbb-p2-build`: d2a910e.
- `sync6b6fbbb-p3-contract`: 815b18f.
- `sync6b6fbbb-p4-verify`: this record, and DEBUG asset probes.

**PIN: Clew-app `6b6fbbb`.** It was copied from `git archive 6b6fbbb`.
`diff -rq` against the archive shows no difference in vendor/clew,
vendor/jmarkdown (ff7facd), vendor/embedpdf (now with licenses/),
vendor/default-stamps or seed-vault. The range fb3635a..6b6fbbb has 15
commits; 416c031 and the handovers are docs.

**mp-tikz-wasm: v0.4.0 + Ghostscript**, staged from the GitHub release with
`--release --force`. STAGED.json reads `source: release`, "pinned v0.4.0 +
ghostscript", two archive pins (6cae11a6… and 7134bc06…), 4,272 files.
Every measurement below is from that build (the s3 worktree).

**Version:** 0.12.0, unchanged. The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| mp-tikz-wasm 0.4.0 with its Ghostscript archive (fa78cc0) | p2: stage-mptikz.js stages both pinned archives, each SHA256-verified. `--no-ghostscript` leaves the module out, and `--release` ignores local builds. CI (ci_post_clone.sh) takes the release, Ghostscript included. |
| PostScript figures (the postscript merge, e00dabe; preview-client/figures.js) | Nothing more: the mptikz route serves `ghostscript/gs.wasm` as application/wasm, and it reads `url.path`, so a `?v=` query is ignored. |
| System font families (system-fonts.js; protocol.js `systemfonts/`) | p3: **SystemFonts.swift.** CoreText finds a family's faces by name and writes each as its own sfnt (NoteFonts.buildFace), cached per iOS version, capped at 64 MB, served in protocol.js's URL shape. |
| The engines' cache stamp (asset-stamp.js) | p3: **AssetStamp.swift**: the app's version and build plus the staged STAGED.json, compared at launch. On a change, WebKit's disk, memory and fetch caches are cleared before the page loads. |
| jmarkdown d134995 + ff7facd (cache options; a text-less `:target`) | They arrive with the vendor. |
| The dashboard chart that follows its target; live edit following front matter (478cfdf) | Shared renderer code: nothing. |
| Export figures cached outside the vault (export-cache.js, d4eae20) | **Nothing to cache:** it serves desktop's LaTeX/PDF exports only, and the iPad has none (its HTML export is reading view's document). |

## Licence (Clew-boss, 2026-10-10)

The Ghostscript module is GNU AGPL v3. Shipping GPL-family code through
Apple (TestFlight, the App Store) is a known tension. It is not new with
Ghostscript: dvisvgm, pdfTeX and LuaTeX are GPL and already ship.
Clew-boss's decision: ship it in this build. TestFlight is internal and
reversible build by build. **Before the first App Store submission, decide
the GPL/AGPL engines (Clew-boss and the owner).** Ghostscript can be dropped
with `--no-ghostscript` in ios/ci_scripts/ci_post_clone.sh.

## Results (simulator, iPad Pro 11" M4, iOS 18.6; ALL GREEN)

Each memory figure is the RSS of the simulator's WebKit content process on
a FRESH install (the figure cache empty), sampled every 100 ms from the
host. These are simulator numbers on a Mac, not a device's.

**(1) PostScript.md and Families.md** (Clew-app's
smoke/make-figures-vault.mjs):
- PostScript.md: **4/4 `mpw-ok`.** PSTricks draws blue #00f and red #f00;
  the EPS box green #090; the rotated text and the TikZ control render.
  **gs.wasm loaded** (`ghostscript/SOURCE.md` → `gs.mjs` → `gs.wasm`), and
  only for this note. The Diagrams and LatexPlain runs fetched SOURCE.md
  alone.
- Families.md: **2/2 `mpw-ok`.** "Avenir Next" was handed over as 12
  faces and **Optima** as 5. The fixture's comment that Clew never hands
  Optima over predates the families feature.
- An extra fixture, FamiliesMore.md: **Gill Sans** (9 faces), **Hoefler
  Text** (4) and **STIX Two Math** (1 face, through unicode-math) are each
  `mpw-ok`.

**(2) Families iPadOS gives the figure engine** (faces handed over):
- Avenir Next 12
- Optima 5
- Gill Sans 9
- Hoefler Text 4
- STIX Two Math 1
- Palatino 4
- Baskerville 6
- Didot 3
- Charter 6
- Georgia 4
- Times New Roman 4
- Helvetica Neue 14
- Futura 5
- Menlo 4

Two names give nothing: "Hoefler" (the family is "Hoefler Text") and
"Iowan Old Style" (not a CoreText family name on this runtime). The
simulator runtime carries iOS's installed fonts. Families iOS downloads on
demand are not among them.

**(3) Memory and the 40-chapter book print**
- Baseline (Welcome, idle): **315 MB**.
- Features/Diagrams (11 TikZ, MetaPost and LuaTeX figures, no PostScript):
  peak **1,285 MB**.
- PostScript.md (4 figures, Ghostscript loaded): peak **831 MB**.
- LatexPlain (the same kind of LaTeX figures without PostScript, the
  control): peak **772 MB**.
- **Ghostscript's footprint is therefore about 60 MB**, its 64 MiB initial
  memory.
- **The 40-chapter book** (Clew-app's gen.mjs: 185,668 words, Books/Big),
  its **Print PDF**. The iPad builds no split HTML; this is its only
  whole-book build:
  - **5.9 s** from the request to the share sheet;
  - the app's content process, which holds renderBook's engine worker, went
    333 → **800 MB** during the build;
  - the print's own web view (a second content process) peaked at **386 MB**
    for its 2.3 s;
  - together about **1.19 GB at the same moment**;
  - **588 A4 pages**, chapter 1 opening page 2, and 1 warning.
- Desktop, for comparison (Clew-app, M4 Max): the engine build ~1.0 s at a
  peak of ~320–335 MB, and the print window ~1.6 s at a peak of ~543 MB;
  2.75 s for 533 pages.

**The cache stamp:** each fresh install cleared WebKit's caches once, at
its first launch ("asset cache cleared": 8 installs, 8 clears). The second
launches had a matching record and did not clear.

**Tests:** npm test 770; Swift 154 + 44 + 18 + 9 + 47 + 36; xcodebuild OK.

## Findings

1. **The figure engines are the iPad's biggest memory cost, not
   Ghostscript.** A note of 11 TikZ, MetaPost and LuaTeX figures peaks at
   about 1.3 GB in the simulator's content process; Ghostscript adds about
   60 MB. A device check matters here. iPadOS ends a content process that
   outgrows its limit, and the preview then reloads.
2. A 40-chapter book's print holds about 0.8 GB in the app's process and
   about 0.4 GB in the print's, at once. This is fine on the simulator; a
   device check is on the checklist.

## iPad checklist (after the push)

- A note with a PSTricks figure (PostScript.md in the record's fixture):
  it renders.
- A figure with `\setmainfont{Optima}` (or Gill Sans, Hoefler Text, STIX
  Two Math as the math font): it renders in that face.
- **A heavy figure note on the device:** Features/Diagrams in reading view
  (11 TikZ, MetaPost and LuaTeX figures; it peaks at **1,285 MB** in the
  simulator's content process). Every figure appears, and the preview does
  not go blank or reload. If it does, iPadOS ended the content process.
- Print a long book (Books/Signals, or longer): the share sheet appears,
  and Clew stays up.
