# Upstream sync to Clew-app c37ce1c (2026-11-24)

Clew-boss's brief relayed the owner's words, typed in Clew-app's window
the same day: "ask Clew-boss to tell Clew-iOS to add the new features".
The range is cfa279b..c37ce1c, read by sha (git archive), since Clew-app's
tree was packaging dev.22. Everything here is local and `[ci skip]`, for ONE
TestFlight push once Clew-boss has verified the chain.

## The range

- **No changes** to vendor/, demo-vault, package.json or scripts, and no
  new npm dependencies.
- **Pins unchanged:** jmarkdown 794cc9c, mp-tikz-wasm 0.5.1.
- **None of these is new:** a preload API, a scheme, an iframe or
  postMessage path, a setting, a vault file type.

1. **PDF via LaTeX's log** (f094a58, 245f41c, 467fca0, a386cc3; 88b495d is
   test-only), in shared/latex-engine.js.
   - TeX's lines are read as bytes and joined whole across its 79-byte
     breaks.
   - The empty line a full line leaves is dropped.
   - A failure's help is the log's. A host's diagnostics count only where
     the log has no first error.
2. **Folders start closed** (0045b24, the owner's ask of 2026-11-17).
   - The workspace records `expandedFolders` in place of
     `collapsedFolders`.
   - revealRow opens the folders above a path.
3. **Live edit** (47f399a, the owner's report on dev.21).
   - A wikilink's `|external` is hidden.
   - Nothing inside a link, maths, a citation or a {{var}} is formatted.
4. **`@begin(clew-only)`, `@clew-only[…]`, `@clew-only+[…]`** (50c2e2e,
   renamed in c37ce1c), the owner's ask: an essay's marking controls.
   - Drawn in reading view and live edit.
   - Left out of everything that leaves Clew.
5. **"Export notes as PDF (reading view)"** (393d482), the owner's ask: a
   folder of marked essays, each to go back to its writer. Many notes, a
   PDF each, into one folder.

## Phases (chained off origin/main 0456399)

1. **`sync-c37ce1c-p1-latex` 03c0af1:** the vendor from `git archive
   88b495d`.
   - src/export/typeset.js hands pdfViaLatexFailure
     `r.texLogBytes ?? r.texLog` (Clew-boss, 2026-11-12).
   - The help test follows 467fca0.
   - Through the pinned build:
     - a 120-byte container path whole;
     - "Devices/9é0DCB612" whole (pdfTeX splits the é at the break);
     - X3's "Your command was ignored." after a long context line.
   - Both tests fail with `log: r.texLog`.
2. **`sync-c37ce1c-p2-folders` 8d7acd8:** the vendor from `git archive
   0045b24`.
   - **iPad-only, fixed:** the explorer marks a new row's rename on the
     create's REPLY, and renames it on the next tree it draws.
     - The Mac's tree comes from its watcher, after the reply. The shim
       sent it in a microtask, before the reply.
     - So on the iPad no "New note / canvas / drawing / folder" row was
       ever renamed. That was pre-existing.
     - Since 0045b24, a closed folder's New note would also not have
       opened the folder.
     - NOTE_CREATE and FS_CREATE_FOLDER now send the tree a task later.
   - workspace-tree and tree-window tests are upstream's.
   - tools/sim-explorer-checks.mjs has three more checks:
     - the vault opens closed;
     - a closed folder's long-press New note opens the folder and asks the
       name;
     - the open folders come back at the next launch.
3. **`sync-c37ce1c-p3-live` 97c556f:** the vendor from `git archive
   47f399a`.
   - live-model and inline-dom tests are upstream's. The iPad's copy of
     live-model had fallen behind by several tests.
   - New tools/sim-smoke.mjs runs a Clew-app smoke scenario as ClewSmokeJS
     on a fixture vault.
4. **`sync-c37ce1c-p4-clew-only` 9abb00c:** the vendor from `git archive
   c37ce1c`.
   - The preview:
     - the worker registry answers `/engine-assets/clew-only.js` (the
       namespace, whose default export the engine registers);
     - engine-config.js names it by its bare path, as render-service.js
       does.
   - The export host registers EXPORT_ENVIRONMENTS with
     begin-end-core.js#registerBlockEnvironment.
   - **The HTML share** is iPad-only: a snapshot of the drawn page, where
     print CSS does not apply.
     - The snapshot removes every `.clew-only` box first.
     - shareLeaks refuses a page that still has one.
5. **`sync-c37ce1c-p5-export-notes` d676821:** "Export notes as PDF" on the
   iPad (below).
6. **`sync-c37ce1c-p6-record`:** this record and HANDOVER.

## Export notes as PDF on the iPad

Upstream's sheet (renderer/export-notes.js) runs as it is, and so do its
plan and its loop (main/print-batch.js). src/shim/export-notes.js is the
twin of export.js#exportNotesPrint. Native (FSBridge.swift) gives it these
pieces:

- **The folder:** the document picker (Clew-boss: no design round; the
  Mac's is a one-folder dialog).
  - It opens on the notes' common folder.
  - The folder is held security-scoped for the batch.
- **What is there already:** the names in the folders the batch writes
  into, so a clash is asked about once and Keep Both numbers past every
  name taken, case aside.
- **The question:** the Mac's words, with Keep Both and Cancel.
- **Each PDF:** the single note's reading-view printer (PrintPDF.swift),
  one note at a time.
  - NotesExportFolder.swift writes it whole to a hidden temporary file,
    then renames it into place exclusively (RENAME_EXCL; elsewhere a move
    that refuses a destination).
  - A file of that name, there before or arriving meanwhile, stays as it
    was, and that note fails.
  - Names are clamped to the chosen folder.
- **Into the open vault:** each PDF goes into the mirror and the tree at
  once. The native rescan diffs text files only.
- **Show in Files:** the Files app at the folder (shareddocuments://).
  - scripts/build.js makes the button say so. Upstream picks "Finder" or
    "Folder" by navigator.platform, which an iPad's web view gives as
    "MacIntel" (measured).
- **Entry points (upstream's):** the palette command, and the explorer
  folder's and background's long-press menus. The iPad has no File menu.
- **Replace is held.** Clew-boss's rule is that Replace must never delete
  an old PDF.
  - FileManager.trashItem on a local folder fails in the simulator with
    NSCocoaErrorDomain 3328 ("the volume … doesn't have one"). The file
    was untouched.
  - iCloud Drive probably has a trash, but it can't be measured here.
  - The options went to the owner. Clew-boss recommends (B): the Trash
    where there is one, else "Replaced PDFs/" beside the new ones, moved
    only after the new PDF is made.
  - Until the owner answers, the question offers Keep Both and Cancel
    only, and `replaced` is 0.
- **Debug builds only:** ClewSmokeExportDir and ClewSmokeExisting answer
  the picker and the question, as Clew-app's CLEW_SMOKE_EXPORT_DIR and
  CLEW_SMOKE_REPLACE do. A Release binary carries neither string.

## Checks

- **npm test:** 847 pass, 2 skipped, with mptikz-assets staged --release
  (latex-doc in).
- **Swift:** 517 pass, NotesExportFolder 55 of them. A non-exclusive
  rename fails 9.
- **A Release build compiles.**
- **Every build.js patch anchor holds.** One is new: export-notes.js's
  label.
- **New tests, each failing under its mutation:**
  - typeset passes the bytes;
  - the shim's create order;
  - clew-only's config line (2) and the export registration (2);
  - the snapshot's strip and the shareLeaks guard (Clew-boss's mutations);
  - the folder writer's exclusive rename.
- **Simulator** (iPad Pro 11" M4, headless). Every run ended with the app
  uninstalled and the simulator shut down:
  - **tools/sim-explorer-checks.mjs: 12/12**, the three closed-folder
    checks included.
  - **Clew-app's smoke/live-external-link-scenario.js, verbatim, through
    tools/sim-smoke.mjs:**
    - concealed links=["Read the notes (PDF)","Course_2026/Week_1
      notes.pdf"] subs-in-links=0 external=2;
    - revealed text-ok=true subs=0;
    - paragraph subs=1;
    - table cell="In a table" external=true.
  - **tools/sim-clew-only-checks.mjs: 5/5.** The PDFs are proved by
    pdftotext of the iPad's own output, never by reading the CSS (Clew-boss).
    - Reading view: three boxes. Live edit: the "Clew only" head.
    - The reading-view PDF: "Essay The essay text, KEPT-ONE. A grade in a
      sentence, KEPT-TWO. End, KEPT-THREE."
    - The book's print: the same, under its front matter.
    - The HTML share: the same, with no box (3 removed).
    - The printer is UIPrintPageRenderer with the web view's print
      formatter, not createPDF, and print media applies.
  - **tools/sim-export-notes-checks.mjs: 10/10,** through the real sheet:
    - The Essays folder's long-press menu opens the sheet with its 3 notes
      ticked. After Export: "Exported 3 PDFs to PDFs." in 3 s.
    - The PDF already there is byte for byte as it was.
    - By pdftotext: Ann 2.pdf, Bob.pdf and Week 2/Cy.pdf each hold their
      essay, with none of their @begin(clew-only) marking controls.
    - There is no PDF of the drawing.
    - The explorer shows the PDFs at once.
    - Show in Files opens Files at the folder.

## Every way a note leaves the iPad (Clew-boss's ask)

1. **Export note as PDF (reading view):** the hidden web view's print, then
   the share sheet. Measured clean.
2. **Book as PDF (reading view):** the same printer. Measured clean.
3. **Export as HTML:** a snapshot of the drawn page (iPad-only), stripped
   and guarded. Measured clean.
4. **Export as LaTeX (.tex or a zip):** the export host's bundle. Clean
   (tests/clew-only.test.js).
5. **PDF via LaTeX:** the same host and its TeX. Clean (pdftotext under
   Node).
6. **Export notes as PDF:** the printer of 1, into a folder. Measured clean.
7. **Refused on the iPad:** a book's PDF, LaTeX and HTML builds, Proof this
   chapter, and the site export.
8. **Not a way out:**
   - the canvas PNG, which rasterizes only the drawing layer;
   - "copy as HTML or rich text", which exists on neither platform.

## Findings

- **Fixed here (p2):** the shim's tree-before-reply order. No new explorer
  row was ever renamed on the iPad.
- **For the owner, through Clew-boss, unchanged here:**
  - VaultStore.trash(rel:) is the explorer's Delete, and the Dropbox
    conflict's copy. It falls back to removeItem when trashItem fails. With
    the 3328 above, a note deleted in a local vault is gone for good on the
    iPad, where the Mac's goes to the Trash. It has been so since M3.
  - Replace in the batch (above).
- **Noted by Clew-boss for after this sync:** the explorer's "Reveal in
  Finder" is a no-op on the iPad.
- **Upstream candidates:**
  - the host names its file browser (the batch sheet's last button);
  - the iPad's rescan could carry binary files' arrivals. VaultStore.rescan
    diffs text files only, so a PDF or image added outside Clew (in Files)
    reaches the explorer only when the vault is opened again. That's read
    from the code, not measured, and it's pre-existing.

## Not measured

- A real iPad.
- An iCloud Drive or third-party provider folder for the batch: the
  simulator has none.
- A long batch's memory. The printer is the single export's, one note at a
  time, its web view torn down after each.
