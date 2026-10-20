# A note's LaTeX exports on the iPad: plan (2026-10-20)

The owner's decision, typed to Clew-boss on 2026-10-20: "tex yes, pdf
yes, 1a 2a 3 allow 4 ok".

- **(1a)** Bibliographies go through a bibtex.wasm port, so the output
  matches the Mac's. mp-tikz-wasm builds it, and makeindex.wasm too.
- **(2a)** Code blocks are coloured like the Mac's. jmarkdown builds an
  opt-in minted stand-in (fancyvrb Verbatim coloured in JS), and Clew turns
  it on for the iPad's LaTeX builds.
- **(3)** PDF via LaTeX is allowed in EVERY vault, because the wasm TeX
  sees only the files Clew hands it. That is kept true: no shell escape,
  and no file from outside the vault ever reaches the engine.
- **(4)** The app grows by the 12–17 MB "latex-doc" bundle.

The owner's second word, the same day, also to Clew-boss: "Then let's fix
entities, (a), and uniform. I have two iPads: a big iPad Pro and an iPad
Mini."

- **(a), fonts without Clew's style (for the PDF):** a note that forces no
  engine runs LuaLaTeX, set in Latin Modern (OpenType, in the bundles); a
  note whose header forces pdfLaTeX gets `lmodern`, so no cm-super is
  needed. No cm-super ships, in any amount. §4 says how.
- **The two iPads for the memory check:** an iPad Pro 12.9-inch (5th
  generation, iPad13,8, M1) and an iPad mini (A17 Pro, iPad16,1). §4.
- **Entities and uniform:** jmarkdown's entity and URL-specials fixes
  change only the .tex's escaping, so nothing here waits for them.

The scoping behind this went to Clew-boss on 2026-10-20 (summary in §1).
This plan has three parts:

- §2: what is shared upstream first;
- §3 and §4: the iPad's phases;
- §5: the tests.

The work starts from the 0ada21d sync's tip, b1443f4, and nothing in it is
coded before Clew-boss has read this file.

## 1. Where things stand

- **The palette already offers** "Export note as LaTeX (.tex)" and "Export
  note as PDF (via LaTeX)" (upstream builtin.js). On the iPad,
  src/shim/ipc.js#EXPORT_NOTE throws "… needs a LaTeX toolchain and is not
  available on iOS". A book's LaTeX, PDF and Proof are not registered here,
  and stay so: this plan is a NOTE's two exports.
- **The Mac's pipeline:** main/export.js#exportNote →
  runWorker(engine/export-worker.mjs, a forked Node) →
  processFile(note, { to: 'latex', output, normalSyntax, bibliography,
  cacheDir, copyFigures, figureEngine }).
  - The engine's Obsidian links come with resolveEmbed, which gives an
    image's path relative to the output's folder.
  - It writes `<base>.tex` and `<base>-figures/`.
  - For a PDF, latexmk runs in a temporary folder (bibtex, reruns), and
    only the PDF is delivered. compilePdf reports the first error.
- **What jmarkdown's LaTeX holds:**
  - TikZ is written natively into the .tex, so nothing needs drawing.
  - MetaPost becomes `<hash>-N.pdf`, made by the figure engine
    (mp-tikz-wasm: the figure's eps through `latex(…, {output: 'pdf'})`).
  - Mermaid needs mmdc and is left out with a warning, as on the Mac.
  - Citations are natbib plus `\bibliography`, so bibtex.
  - Code is minted, which needs shell escape. This is why (2a) exists.
- **What mp-tikz-wasm 0.4.0 does:**
  - `core.latex(source, { output: 'pdf', engine: 'latex' | 'lualatex' |
    'plain', files, jobName })` is ONE TeX run. It returns `{ pdf,
    artifacts, texLog, diagnostics }`.
  - The files handed in persist on the instance, so each export gets a
    fresh instance.
  - Measured on an M4 Max under Node:
    - pdfLaTeX: 0.26 s a pass, 128 MiB;
    - LuaLaTeX with EB Garamond: 4.3 s a pass, 459–551 MiB peak.
  - It has no xelatex, no HarfBuzz and no emoji fallback.
- **Where wasm may run on the iPad:** only in clew-preview documents. That
  origin's CSP carries `'wasm-unsafe-eval'` and `worker-src 'self' blob:`
  (SchemeHandler.swift, preview-csp.js). The app page has had no wasm since
  the 0.8 sync. The render worker (src/worker/engine-worker.js) is the app
  page's, so neither the figure engine nor TeX can run in it.
- **A hidden web view already exists** for "Export as PDF (reading view)"
  and the HTML share (PrintPDF.swift#PdfPrinter): a hidden WKWebView on the
  preview scheme, driven by scripts from the JS side.

## 2. Upstream first: a shared pure module (for Clew-boss to brief Clew-app)

Clew-app's unpushed 0038ec3..2675150 added export settings the iPad needs
as much as the Mac. Today they live in desktop-only files: export-worker.mjs
(a forked Node process) and main/export.js (Electron). Copying them into
the iPad shim would fork them. What follows should move into pure modules,
with no Electron, no `node:fs` and no `process.platform` read at load time,
so both hosts import the same code. vendor/clew carries it verbatim.

**U1 (the main one). `src/engine/export-config.js`, new.**
`configureExportBuild(configManager, { to, latexStyle, biblify, defaults })`
is the build-time configuration block of export-worker.mjs, moved out
whole:
- `Header style: fenced` for every export (cdde7df);
- for HTML, the vault's `Biblify` keys set over the user's config, except
  `bibliography` (afbf933);
- `LaTeX maketitle: true` for LaTeX (5c6caae);
- Clew's LaTeX style (latex-style.js), decided before the build and again
  at the engine's first header merge. This is the `mergeMetadata` wrapper,
  limited to the engine's own configManager and never a book's trial
  copies (`Object.create(configManager)`), with the STYLE_KEYS restored
  first.

export-worker.mjs then calls it in one line, and the iPad's export worker
calls the same function. It needs only the engine's configManager (passed
in) and latex-style.js. **Tests upstream:** a fake configManager
(get/set/mergeMetadata) for:
- a header `LaTeX engine: pdflatex` → no style;
- a header `Lang: de` → `\usepackage[ngerman]{babel}`, with the region's
  paper;
- a header `LaTeX maketitle: false` wins;
- HTML's Biblify keys set, `bibliography` left alone;
- a trial copy's merge does not decide again (the German book case);
- `Header style` is `fenced` for html and latex.

**U2. `latexStyleWanted({ to, style, engine, locale, platform })`, into
latex-style.js.** This is export.js#latexStyle's decision, made pure:
- null unless the build is LaTeX;
- null when the setting is `none`;
- null when the engine is forced to pdfLaTeX;
- otherwise `{ locale, platform }`.

The Mac passes its settings, Intl's locale and process.platform. The iPad
passes its own settings, Intl's locale and `'ios'`. That platform has no
emoji face: `EMOJI[platform]` falls back to linux's, which
`\IfFontExistsTF` already guards, so nothing breaks. Upstream may prefer an
explicit `ios` entry, or `emoji: false`. **Tests:** the four cases above,
and `ios` → a preamble with no `add_fallback` once the face is missing.

**U3. citation-header.js's pure functions into `src/shared/` (posix
paths).** These are `vaultBiblify` (2675150's), `bibliographyList`,
`noteBibFiles` and `bibliographyDirs`. Today they use `node:path`. The
iPad already holds a hand copy of the first: src/shim/engine-config.js#
biblifyConfig, the same code as render-service.js#biblifyConfig before
2675150. With the move, reading view and the export use one object on both
hosts. The PDF needs `noteBibFiles` because bibtex.wasm must be HANDED each
.bib file; it cannot search BIBINPUTS. **Tests:** upstream's
citation-header tests run against the shared module, plus a posix-only run.

**U4. `exportEmbedPath({ abs, output, to, chapters, file, realpath })`.**
This is resolveEmbed's arithmetic, out of export-worker.mjs:
- relative to the output's folder;
- by realpath for LaTeX;
- in a book, relative to the chapter.

It uses `path.posix`, with realpath injected. The iPad passes the identity,
because the vfs has no links. The vault clamp stays where it is
(vault-files.js#resolveFileTarget). **Tests:**
- an output at the vault's root → `Attachments/x.png`;
- an output in a subfolder → `../Attachments/x.png`;
- a book chapter in a folder;
- `realpath` swapping a linked folder.

**U5. latex-engine.js's pure part into `src/shared/latex-engine.js`.**
This is `chooseLatexEngine`, `engineName` and `firstLatexError`, plus two
additions:
- **`available`:** `chooseLatexEngine(tex, setting, { available })`, so a
  host without XeLaTeX gets one worded answer. The iPad has only `latex`
  and `lualatex`. A document that needs XeTeX gets "this document needs
  XeLaTeX (line N: …), which Clew on the iPad does not have". That's better
  than running LuaLaTeX into an obscure failure.
- **`pdfViaLatexFailure({ engine, reason, log, error })`:** compilePdf's
  "PDF via LaTeX failed — X ran (reason). First error: …", so both hosts
  report a failure in the same words.

latexmkCommand and latexPdfRefusal stay desktop's. **Tests:** upstream's
latex-engine tests, plus the `available` cases and the failure text.

**U6. export-cache.js's pure part into `src/shared/export-figures.js`.**
This is `figuresFolder(output)`, `FIGURES_MARKER` and
`explainFiguresWarnings(warnings, { restricted })`. The rest of the file
(the cache folders, pruning, `texRefusalDir`) stays in main/. The iPad
needs the folder's name to lay out the zip, and the warnings' wording to
report what the figure engine said. **Tests:** upstream's, moved.

**U7. `noteExportOptions({ format, output, vaultSettings, vaultRoot,
cacheDir, figureEngine })`**, beside U1. It returns processFile's options
for a note export, including the vault's bibliography file (jmarkdown
455cb61), so the two hosts cannot drift on the option list. It is small,
but this is exactly the list that changed three times this week.

**For jmarkdown** (through Clew-boss):

- **J1. A figure library the host supplies.** Today the figure engine
  loads mp-tikz-wasm by `import(pathToFileURL(<MP-TikZ dist>/index.js))`
  and fingerprints it by reading the dist folder with `fs`. A browser
  worker has neither. Wanted: a processFile option such as
  `figureLibrary: { load: () => Promise<module>, fingerprint: string,
  bundles?: string[] }`, which a host can use in place of the path.
  Without it, the iPad patches figure-engine.js's `instance()` and
  `fingerprint()` at build time (scripts/build.js), which is the fragile
  kind of patch.
- **J2. The minted stand-in (2a):** an opt-in configuration key, named by
  jmarkdown. Clew-iOS sets it for every iPad LaTeX build: the .tex too,
  so the .tex compiles anywhere without `-shell-escape`.
- **J3 (a question).** Does the figure engine need `setImmediate` anywhere
  besides runAll()? The iPad's worker shims it with a macrotask (the
  ef5f7f2 lesson: never a microtask).

**For mp-tikz-wasm** (already agreed by the owner): the latex-doc bundle,
bibtex.wasm, makeindex.wasm and the third-pass fix. Two things to confirm
in writing, because (3) depends on them:
- `\write18` and every shell escape are off and cannot be turned on;
- `\input`, `\openin` and `\includegraphics` see only the in-memory file
  system: the bundles plus the files given. There must be no host
  filesystem passthrough in the WebAssembly build.

## 3. The .tex export on the iPad (branches chained off b1443f4)

**L1 `latex-p1-host`: the export host.** It needs no upstream change, so
it can start once Clew-boss has read this plan.

- **LatexHost.swift.** A hidden WKWebView on the preview scheme, modelled
  on PdfPrinter, loads `clew-preview://vault/<sid>/__clew_export__.html?job=<token>`.
  - **Why a web view of its own and not an iframe in the app page:** it
    runs in its own WebContent process. A LuaLaTeX pass of about 550 MiB,
    killed by jetsam, then takes down only the export, which reports "ran
    out of memory". The user's editor and unsaved text are untouched. The
    .tex export uses the same host, so there is one mechanism. To check
    in the simulator: the host shows up as a separate WebContent process
    (`ps` on the Mac, since simulator processes are Mac processes).
  - **The job:**
    - The app page posts the job to native: the note, the options, the
      engine config, and the vfs snapshot the render worker would get.
    - Native holds it under a single-use token, and the host page fetches
      it from `__clew_export_job__/<token>`.
    - Outputs go back as POSTs to `__clew_export_out__/<token>/<rel>`:
      binary-safe, nothing large through evaluateJavaScript.
    - Native writes them into a temporary folder of this export's own.
  - **Lifecycle:** one job per host. A timeout of 180 s, as on the Mac.
    Cancel on vault switch or backgrounding. The temporary folder is
    removed after the share or on any failure.
    `webViewWebContentProcessDidTerminate` becomes the error "PDF via LaTeX
    ran out of memory on this iPad" (or "the LaTeX export stopped", for
    the .tex).
  - **The host's CSP:** the preview's, plus `connect-src 'self'` for the
    job's endpoints. Nothing more.
- **The export worker** (src/export/export-worker.js, bundled like
  engine-worker.js) is a module worker of the host page, which is fine
  under clew-preview. It is the render worker's engine plus:
  - the figure engine, `wasm` only: mp-tikz-wasm from the app's bundled
    dist (`__clew_assets__/mptikz/`), through J1 or the build patch;
  - `setImmediate` shimmed with a macrotask.
- **The config** is desktop's rule, not the preview's generated one: an
  export reads the vault's own jmarkdown configuration from the note's
  folder. A vault this device does not trust exports from a folder whose
  configuration says `Run note code: false` and nothing else (desktop's
  restrictedExportDir). The user's ~/.jmarkdown doesn't exist here.

**L1 as built (2026-10-20).**

- **Pieces:**
  - ExportHost.swift is the hidden web view, the routes and the
    lifecycle;
  - ExportJobs.swift holds the rules: a single-use token, outputs only
    inside the job's folder, each written once, within 2,000 files and
    512 MB, and the page's last word must name exactly what was written;
  - src/export/ has host.html, host.js, export-worker.js and outputs.js;
  - src/shim/export-job.js and export-host.js build the job, and
    `__clewShim.services.exportHost` runs it;
  - tools/export-note.mjs is the Node harness.

  No command uses it yet: EXPORT_NOTE's `latex` and `pdf` still refuse.
- **Found on the way:**
  - mp-tikz-wasm decides it is in Node from the global `process`, which
    the worker's shim makes a Node look-alike. The export worker shows
    that global as a browser worker's (`versions: {}`, `type: 'renderer'`).
    The engine's own `process` is bound at build time and unchanged.
  - The engine evaluates strings when it loads, so the worker's own CSP
    (from its script's response) has `'unsafe-eval'` as well as
    `'wasm-unsafe-eval'`. The host page's CSP has neither. Both keep
    `connect-src 'self'`.
  - The fs shim lacked `mkdtempSync`, which the figure cache's run folders
    need.
  - The figure engine's library import is a build patch until J1 (the
    worker bundle only; the render worker is untouched).
- **Measured in the simulator** (iPad Pro 11", demo vault):
  - Features/Diagrams.md took 0.8 s wall (0.58 s in the host): its .tex
    (12,161 bytes) and its MetaPost figure as a PDF (39,409 bytes),
    byte-identical to the Node harness's. Welcome.md took 0.5 s.
  - Every export ran in a NEW WebContent process; the app page's stayed
    the same throughout. The host peaked at 196–515 MB for these notes.
  - Killing the host's process mid-export (a 40-figure note) gave "The
    export stopped: iOS ended its page, most likely because it ran out of
    memory". The editor carried on: a render worked and the next export
    succeeded. No job folder was left.
  - From a note's preview document, all five /__clew_export__/ routes
    answered 403.
  - The exported Diagrams.tex compiled on the Mac (latexmk -lualatex
    -shell-escape, for minted) to a 4-page PDF with no error, its MetaPost
    figure included.

**(sync)** The Clew-app commits that bring U1–U7 (and J1, if it comes
first) arrive as an ordinary sync. L2 waits for that sync, so nothing is
copied.

**L2 `latex-p2-tex`: Export note as LaTeX (.tex).**

- **EXPORT_NOTE `latex`:**
  - the options are `noteExportOptions(…)` (U7): `to: 'latex'`, `output:
    <vault>/<base>.tex` in the vfs, the vault's bibliography, `cacheDir`
    in the vfs, `copyFigures`, the figure engine `wasm`;
  - `configureExportBuild` (U1) with `latexStyleWanted` (U2);
  - the Obsidian links' resolveEmbed through `exportEmbedPath` (U4).

  The output sits at the vault's root, so every image path in the .tex is
  vault-relative (`Attachments/x.png`). The zip mirrors that.
- **MetaPost** is the engine's own fillMetapost, in the export worker:
  `<hash>-N.pdf` in `<base>-figures/` (U6's name).
- **Collected:**
  - the .tex;
  - the figures (bytes);
  - the vault files it references: the images resolveEmbed answered, every
    `\includegraphics` path, and the .bib files (U3's noteBibFiles plus
    the vault's), each clamped by resolveFileTarget.
- **Shared:**
  - nothing referenced → the bare `<base>.tex` (shareText);
  - otherwise a `<base>.zip`: Swift copies the clamped vault files by
    path, writes the generated ones into the job's folder, and zips it
    with NSFileCoordinator `.forUploading`, then the share sheet. The
    zip's paths are relative, never absolute and never `..`.
- **Warnings** reach the status bar as an export's do on the Mac,
  worded by U6. A Mermaid diagram is left out with the engine's warning.
- **Settings:** the "Style of LaTeX and PDF via LaTeX exports" row comes
  back. The 0ada21d sync's patch and its no-latex-ui assertion are
  removed. The latexEngine and exportFigureEngine rows stay dropped: the
  iPad's engine is `auto` among the two it has, and its figures are always
  mp-tikz-wasm.
- **Code blocks:** minted, as the Mac's .tex, until J2 lands. Then the
  stand-in for every iPad LaTeX build.

**L2 as built (2026-10-20,** `latex-p2-tex`, on the 0e773c3 sync: L1 and
this plan cherry-picked onto its build commit 527a245).

- **The build is desktop's, imported:**
  - src/shim/export-job.js takes processFile's options from
    `noteExportOptions` (U7), and decides Clew's style with
    `latexStyleWanted` (U2) and the vault's citations with `vaultBiblify`
    (U3).
  - The style's platform is `ios`, with no emoji face. The .tex may be
    typeset anywhere, and the iPad's own TeX has none.
  - src/export/export-worker.js applies them as desktop's export worker
    does: `configureExportBuild` (U1) on the engine's own configManager,
    then processFile with the engine's Obsidian links. resolveEmbed is
    `resolveFileTarget` (clamped in a restricted vault) and
    `exportEmbedPath` (U4); a [[link]] prints as its text.
  - So a .tex gets `LaTeX maketitle`, the fenced header (a first line
    `Note: …` is text) and Clew's EB Garamond preamble, as on the Mac.
- **The share:**
  - src/shim/export-references.js reads the .tex in the APP page, against
    the vault's mirror: each `\includegraphics` path the vault has, at its
    vault path (graphicx's extension search included), and each
    `\bibliography`/`\addbibresource` name matched to the build's .bib
    files (the vault's jmarkdown config, the vault setting, the note's
    header), to sit beside the .tex. Never the export's own figures, a
    path out of the vault, a URL, or a commented line. A name the vault
    lacks becomes a warning.
  - FSBridge `exportShare` → `ExportJobs.share`. Nothing named and only
    the .tex written: the .tex alone. Otherwise the outputs are moved
    into `<job folder>/.share/<note name>/`, and each vault file is copied
    in through VaultStore.materialize (clamped by realpath, iCloud
    downloaded) with a coordinated read, never over an output and never
    outside the stage. Then `NSFileCoordinator(.forUploading)` zips the
    stage: a zip whose one top folder is the note's name.
  - The folder goes when the share sheet closes, when a share fails, at
    the next export, and at launch.
  - The host page never decides what leaves the vault: it writes outputs
    into its own job folder only.
- **A `<base>-figures/` folder the vault already has at the output's
  place** (a desktop export saved at the vault's root, synced) stays out of
  the worker's vfs. The engine would otherwise refuse it as not its own
  and point the .tex at the vfs's cache.
- **Settings:** "Style of LaTeX and PDF via LaTeX exports" is back, its
  hint said for the iPad by two build patches: "this iPad's region", and
  "a note whose header asks for pdfLaTeX is left without it" (no engine
  row above it here).
- **Measured in the simulator** (iPad Pro 11", demo vault, the palette's
  own `export:latex`):

  | note | time | share | contents |
  | --- | --- | --- | --- |
  | Features/Media Gallery | 0.9 s | Media Gallery.zip, 2 MB | the .tex and 3 JPEGs under Attachments/ |
  | Features/Citations | 0.8 s | Citations.zip | the .tex and refs.bib beside it |
  | Features/Diagrams | 1.3 s | Diagrams.zip | the .tex and Diagrams-figures/ (one MetaPost PDF) |
  | Welcome | 0.9 s | Welcome.tex | the .tex alone |

  - Each share sheet came up ("ZIP Archive · 2 MB" for Media Gallery).
  - Every .tex is byte-identical to the Node harness's.
  - Each zip, unzipped on the Mac, typesets as it stands (latexmk
    -lualatex -shell-escape): 1, 4, 4 and 2 pages; no undefined citation
    and no missing file. Citations' references come from the refs.bib in
    the zip. Media Gallery's 3 images are in the PDF, set in EB Garamond.
  - The status bar's notice and ⚠ carry the engine's warnings (a film is
    not an image; Mermaid needs mmdc).
  - With the style set to "Your jmarkdown configuration only" in
    Settings, the next .tex has no style.
  - The previous run's job folder was gone after a relaunch.
- **Not checked in the simulator:** the share sheet's own close, which
  removes the folder. A tap is not something the kit does; the next
  export and the launch remove it in any case. That is a device check.
- **For upstream (wording):** the Mermaid warning says "install
  @mermaid-js/mermaid-cli", which no iPad user can do.

**L3 `latex-p3-verify`:** the record and the simulator (§5).

## 4. PDF via LaTeX on the iPad

This waits on mp-tikz-wasm's latex-doc bundle, bibtex.wasm,
makeindex.wasm and the third-pass fix, and on jmarkdown's J2.

**P1 `latexpdf-p1-assets`.** stage-mptikz.js and CI fetch and verify the
new release assets (sha256, as the ghostscript archive is), and the app's
growth is measured against the agreed 12–17 MB.

- **The bundles (Clew-boss, 2026-10-20, against the staged 0.5.0):**
  `MetaPost.create` loads default + opentype + **otf-fonts** + latex-doc.
  Clew's style loads unicode-math; Garamond-Math is not on the iPad, so
  unicode-math falls back to latinmodern-math.otf, which is only in
  otf-fonts (0.7 MiB). Without it every styled PDF that reaches maths
  setup fails ("The font "latinmodern-math" cannot be found").
- **The growth reported** against the owner's 12–17 MB includes
  otf-fonts.
- **A known 0.5.0 defect:** for a fontspec error, `latex()`'s diagnostics
  have an empty message (the text is on "(fontspec)" lines). Until
  mp-tikz-wasm's fix ships, the error is read from the log.

**P2 `latexpdf-p2-compile`,** in the export host:

- **A dedicated TeX worker per export:** a fresh `MetaPost.create` with
  the latex-doc bundle, disposed of at the end. Passes run strictly one
  after another, never two engines at once.
- **A NEW instance per export, never a reused one (mp-tikz-wasm's sandbox
  review, its test/e2e/sandbox.test.ts at its local 83d3d65).**
  - `removeFiles()` is not enough. Within one instance, /texmf-var
    (luaotfload's font cache, which it loads as Lua code) is writable by a
    document, and is carried into every later LuaTeX run on that instance.
    One untrusted note could change how a later note is typeset.
  - The passes of ONE export may share the instance.
  - The export host already gives each export a new web view, worker and
    instance (L1). The test below holds it to that.
- **An overall time limit, Clew's own.** mp-tikz-wasm's watchdog kills
  only a worker that has gone silent. A document that loops while
  printing runs until the host stops it, and an engine may grow to 2 GiB.
  - ExportHost stops any export after 3 minutes (L1). The message is "The
    export took too long (more than 3 minutes) and was stopped", and the
    job's folder goes.
  - 3 minutes is desktop's compilePdf limit. The device check below
    confirms that a real note's passes fit well inside it.
- **Fonts without Clew's style, (a):**
  - **No engine forced → LuaLaTeX, Latin Modern OpenType.** jmarkdown's
    own `LaTeX engine` key decides the preamble (preamble.js:
    `lualatex` → fontspec; anything else → inputenc and T1 fontenc). The
    iPad's PDF build sets `LaTeX engine: lualatex` as its configuration
    default before processFile, so the .tex loads fontspec, and
    `chooseLatexEngine` then picks LuaLaTeX. A header's `LaTeX engine`
    is merged later and wins. That is an existing key. Proposed upstream,
    so both hosts share it: an `engine` option for configureExportBuild.
  - **A header forcing pdfLaTeX → `lmodern`.** T1 fontenc without it
    wants cm-super, which ships in no amount, so TeX would fall back to
    bitmap Type 3 fonts. A configuration `LaTeX preamble` or `Packages`
    line does not survive: a header's own key replaces the
    configuration's (config-manager.js#mergeMetadata), and latex-style.js
    already leaves alone every key a header sets. This needs a hook
    upstream, which goes to Clew-boss as a proposal; nothing is copied
    here. For example, a jmarkdown key "Config or host only" that
    assemblePreamble emits after T1 fontenc, or `lmodern` there always.
  - mp-tikz-wasm checked against 0.5.0, and Clew-boss verified the
    unicode-math case:
    - pdfLaTeX with T1 and lmodern gives Type 1 Latin Modern only;
    - LuaLaTeX with fontspec gives Latin Modern OpenType text with CM
      Type 1 maths;
    - LuaLaTeX with unicode-math needs otf-fonts.
  - **Acceptance:** the same unstyled note, and that note forced to
    pdflatex, each give a PDF on the iPad. `pdffonts` lists only Latin
    Modern (and CM maths) fonts, and no Type 3.
- **The engine** comes from `chooseLatexEngine(tex, setting, { available:
  ['pdflatex', 'lualatex'] })` (U5):
  - Clew's style → LuaLaTeX;
  - a header `LaTeX engine: pdflatex` → pdfLaTeX, with no style (U1
    already decides that);
  - a document that needs XeTeX → U5's worded refusal.
- **The files handed in, and nothing else:**
  - the .tex;
  - its `-figures/`;
  - the referenced vault images, fetched by the host through the scheme
    handler's vault route. That route is clamped, refuses symlink escapes
    (644d887), and in a restricted vault answers only what reading view
    may read;
  - the .bib files (U3).

  There is no directory listing and no path the .tex names that is not
  in that set. That makes (3) a property of the code, not a hope.
- **The passes:**
  1. pass 1;
  2. bibtex.wasm when the .aux has `\bibdata`, with the .bst from the
     bundle;
  3. makeindex.wasm when there is an .idx;
  4. pass 2;
  5. pass 3 as mp-tikz-wasm's fix prescribes;
  6. one more pass only while the log asks for a rerun, capped at 5 in all.

  The artifacts are fed back through `files`.
- **Errors:** the first one, as compilePdf reports it (U5's
  `pdfViaLatexFailure` over `firstLatexError(texLog)`). A missing package
  is named, so "the iPad's TeX does not have X" is legible.
- **Out:** only the PDF goes to the share sheet. The .aux, .log and
  figures stay in the job's folder, which is removed. This is the Mac's
  rule since 2026-10-04.
- **The code stand-in (J2):** on.

**P3 `latexpdf-p3-verify`:** the record, the simulator, and the device
memory check below.

**The device memory check (before the PDF ships).** About 550 MiB a
LuaLaTeX pass is close to what an iPad's WebContent process may hold. In
the simulator, the host's process can be measured from the Mac (`ps`,
`footprint`), but the jetsam limit is the device's. The owner has two
iPads (from Xcode's paired-device list):

| | iPad Pro 12.9-inch (5th generation) | iPad mini (A17 Pro) |
| --- | --- | --- |
| identifier | iPad13,8 | iPad16,1 |
| chip | M1 | A17 Pro |
| RAM | 8 GB (16 GB on the 1 and 2 TB models) | 8 GB |

Neither's limit for a WebContent process is published, and it is not
the app's own limit. The mini is the likelier tighter one: a smaller
device, and iOS's limits follow the device class as well as its RAM. So
the plan measures both, the mini first:

1. **TestFlight, about 20 minutes, the owner (when P2 is ready).** On the
   mini, then on the Pro: PDF via LaTeX on five notes I name, each
   reported as done or the error's text, with roughly how long it took.
   - a plain note, without Clew's style (pdfLaTeX's path, font (a));
   - Citations (bibtex.wasm);
   - Diagrams (MetaPost, TikZ);
   - a long note with Clew's style (LuaLaTeX, EB Garamond, about 550 MiB
     a pass on the Mac);
   - the 40-figure note from L1's kill test, with Clew's style: the
     headroom case.

   The time against the 3-minute limit is part of the check. A note that
   comes near it says the limit, or the passes, need another look.
   Each export has a WebContent process of its own (L1), so memory does
   not build up from one export to the next. The order of the notes
   doesn't matter.
2. **Instruments, only if a note fails with the out-of-memory message on
   either iPad, or the numbers look close:** that iPad on a cable to this
   Mac, with Developer Mode on and unlocked. A Debug build under
   Instruments (Allocations and VM Tracker on the export's WebContent
   process) gives the real peak against the point jetsam ended it. The
   owner would be present for that. If only the mini fails, the fallback
   below can be decided for small iPads alone.

The fallback if LuaLaTeX does not fit: pdfLaTeX with a Type 1 Garamond,
which is a style decision for the owner.

## 5. Tests

**JS (node --test, in tests/):**

- **The export job:** `latex` options (to, output at the vault's root,
  figure engine `wasm`, copyFigures, the vault's bibliography,
  normalSyntax). A restricted vault's config has `Run note code: false`.
  An unknown format is refused.
- **The zip manifest:**
  - nothing referenced → a bare .tex;
  - otherwise exactly the .tex, its figures, the referenced images and
    the .bib files;
  - no absolute path and no `..`;
  - a symlink out of the vault, or an embed outside it, is never listed
    (the vault-files clamp).
- **A fresh instance per export:** an export whose document writes into
  /texmf-var (a luaotfload cache entry) has no effect on the next export:
  the next note typesets byte-identically with and without it before. Run
  under the Node harness and in the simulator.
- **The time limit:** a document that loops while printing is stopped at
  the limit with "took too long", and its folder is gone (the limit
  lowered for the test).
- **The pass planner:** from an .aux and a .log, bibtex yes or no,
  makeindex yes or no, rerun yes or no, and the cap. The first error comes
  out in the Mac's words (U5).
- **The engine choice:** the style → LuaLaTeX; a header pdflatex →
  pdfLaTeX with no style; a XeTeX document → the refusal's text.
- **tests/no-latex-ui.test.js:** the style row is back. The latexEngine
  and exportFigureEngine rows are still gone, the palette has a note's two
  exports, and a book's LaTeX, PDF and Proof are still absent.
- **The upstream tests run against vendor/** (the `.uptests` recipe):
  latex-style, latex-engine, citation-header, and U1's, once they exist.

**Swift (tests/swift):**

- LatexHost tokens are single-use and expire.
- The output endpoint refuses an absolute path, `..` or a second write
  after done.
- The vault-file collection refuses symlink escapes (VaultPaths' cases).
- The job's folder is gone after a share, a cancel and a timeout.
- The zip holds exactly the manifest.
- Termination of the content process becomes the out-of-memory error.

**Simulator (ClewSmokeJS plus Mac-side checks), per phase:**

- **The .tex of demo-vault notes:** Citations, Features/Diagrams (TikZ
  and MetaPost), a callout note, a code note, a title-block note and a
  `Lang: de` note.
  - Each is unzipped on the Mac and compiled there with latexmk, to prove
    the zip is complete. Missing files are the failure this catches.
  - Each .tex is diffed against the Mac's own export of the same note.
    Only the paths should differ, with the vault at the root on both.
- **The security cases (3),** in a restricted vault:
  - a note with `\input{/etc/hosts}`;
  - `\includegraphics{/System/Library/…}`;
  - an embed of a symlink pointing outside the vault;
  - a `LaTeX preamble` header naming an absolute path.

  For each: the zip doesn't hold it, and the PDF build fails or omits it
  with TeX's own "not found". The log is read to prove the content never
  arrived.
- **The PDF:** the four notes above, timed. The host's WebContent process
  is a separate pid with its footprint measured. A forced termination
  (kill the pid) reports the out-of-memory error and leaves the editor's
  text intact.
- **Throughout:** no System Events keystrokes. Clean up after every run.

## 6. Order

1. Clew-boss reads this plan, and the U-list goes to Clew-app.
2. L1 (the host) starts. It needs nothing upstream.
3. The sync that brings U1–U7 (and J1, if it comes first).
4. L2, then L3. Clew-boss verifies, and the push needs the owner's word.
   (L2 is built, 2026-10-20, on the 0e773c3 sync.)
5. P1–P3 once mp-tikz-wasm and jmarkdown have shipped their parts. The
   device memory check comes before that push.
