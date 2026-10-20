# Handover — 2026-10-20 (the sync to Clew-app 0e773c3: the export pipeline factored for the iPad's LaTeX exports; list indentation measured in live edit)

Current state for a fresh session, rewritten whole. Durable architecture
lives in **README.md** and **PORT-PLAN.md**. Each sync's reasoning and
measurements are in its record: `UPSTREAM-*-PLAN.md`. The latest records
are `UPSTREAM-0E773C3-PLAN.md` (the export pipeline's shared modules, quotes and tabs in lists measured, 2026-10-20), `UPSTREAM-0ADA21D-PLAN.md` (list keys, the Next item button, {{TOC}}, title blocks, quotes in lists, 2026-10-20), `UPSTREAM-F0AEAA4-PLAN.md` (EmbedPDF's cards at 208 px, the colon list's fill, the LaTeX refusal, 2026-10-15), `UPSTREAM-EF5F7F2-PLAN.md` (the index cache's save, tables wrapping at words, PDF #page=N, images within a line, 2026-10-15), `UPSTREAM-F4FEB68-PLAN.md` (tables in live edit, the guard, the PDF height upstream, 2026-10-15), `UPSTREAM-185E950-PLAN.md` (the colon retirement and "Convert this vault", 2026-10-11), `HTML-SHARE.md` (the iPad HTML share, 2026-10-11), `UPSTREAM-F959799-PLAN.md` (the figure engine, Proof this chapter, figures
in exports measured, 2026-10-10), `UPSTREAM-6B6FBBB-PLAN.md` (PostScript figures, system font families,
mp-tikz-wasm 0.4.0, 2026-10-10), `UPSTREAM-5ABF52D-PLAN.md` (app secrets,
book mode phase 2, the book print, 2026-10-10), `UPSTREAM-CBFA692-PLAN.md` (book mode and the demo
vault's update, 2026-10-06), `UPSTREAM-77B0BEA-PLAN.md` (the sample apps, 2026-10-04),
`UPSTREAM-F3A7D5B-PLAN.md` (the sync of 2026-10-03/04),
`UPSTREAM-03BB33A-PLAN.md` (the overnight sync of 2026-10-02),
`UPSTREAM-18C5E45-PLAN.md` (sync #3) and `UPSTREAM-0.12.0-PLAN.md`. The coordinator's ledger is `~/Source/Clew/SYNC-LEDGER.md`.

## 1. Where things stand

- **The sync to Clew-app `0e773c3` (2026-10-20) is DONE; every check was
  green in the simulator.** The chain is `sync-0e773c3-p1-vendor` →
  `-p2-build` → `-p3-verify`, off b1443f4, and stays off main until
  Clew-boss has verified it. The record is UPSTREAM-0E773C3-PLAN.md.
  - **The export pipeline's decisions are shared modules now** (U1–U7 of
    UPSTREAM-LATEX-EXPORT-PLAN.md): shared/citation-files.js,
    latex-engine.js, export-figures.js, latex-style.js#latexStyleWanted
    (with an `ios` platform) and engine/export-config.js. Only the
    citation half has an iOS caller so far: reading view's `Biblify` and
    a note's .bib files are desktop's `vaultBiblify` and `noteBibFiles`,
    imported. The rest waits for L2.
  - **Live edit:** a quote in a nested list item stands under its text (it
    was 2 px right, this port's report), and a tab-indented item is four
    columns in, as the desktop measures.
  - `LaTeX maketitle` and the fenced export header are desktop's export
    worker's, inert here until L2.
- **The sync to Clew-app `0ada21d` (2026-10-20) is DONE and PUSHED**
  (2026-10-20, origin/main b1443f4, on the owner's word in this window).
  Every check was green in the simulator, with synthetic input. The chain
  is `sync-0ada21d-p1-vendor` → `-p2-build` → `-p3-verify`, off main
  3447b9d. The record is UPSTREAM-0ADA21D-PLAN.md.
  - **Lists:** Enter stays in an item, ⌘Enter starts the next one, and ⌘L
    makes a task (Obsidian's toggle). The desktop's expected log matched
    line for line, but the keys were synthetic keydowns on CodeMirror. The
    real hardware and on-screen keyboards are the owner's check on
    TestFlight.
  - **The iPad is a touch-first host** (`window.clew.host`, src/shim/ipc.js),
    so the toolbar draws Next list item (↵, ⌘Enter's command) in the Lists
    group, enabled in a list.
  - **Live edit:** `{{TOC}}` follows edited headings. Title-page directives
    are a title block, sized as reading view's. A quote in a list item
    stands under its text and reads grey, as reading view's.
  - Clew's LaTeX export style is the desktop's (export-worker.mjs). Its
    Settings row is dropped here.
- **The sync to Clew-app `f0aeaa4` (2026-10-15) is DONE and PUSHED**
  (2026-10-20, origin/main 3447b9d; cloud build OK). The chain is
  `sync-f0aeaa4-p1-vendor` → `-p2-build` → `-p3-verify`, off main
  07810a8. The record is UPSTREAM-F0AEAA4-PLAN.md.
  - **EmbedPDF's cards stay whole at 208 px** (pdf-card-fit.js): the
    error's long word wraps, and the prompt's Open stays inside its card.
  - **The colon sheet's 4,001-note list opens in ~180 ms** (65 s before):
    the folds sit in a div of their own, and the content-visibility rule
    that hid them from find is gone.
  - The desktop's latexmk, biber and PATH guards and its refusal of a
    restricted vault's PDF via LaTeX are desktop main's, and inert here.
    iOS has no PDF via LaTeX in any vault. The palette still offers a
    note's two LaTeX exports, refused when run. The owner has since
    decided they come to the iPad (§3).
- **The sync to Clew-app `ef5f7f2` (2026-10-15) is DONE; every check was
  green in the simulator.** The chain is `sync-ef5f7f2-p1-vendor` →
  `-p2-build` → `-p3-verify`, off main c0f2a20. The record is
  UPSTREAM-EF5F7F2-PLAN.md.
  - **The index cache saves in the page, without a stall.** Upstream's save
    went async (writeFileAtomicAsync), which the vfs's fs.promises could
    not serve: unfixed, every save would have failed. The shim now opens
    and renames. The frame at a save on 5,006 notes went from 133–146 ms to
    21–35 ms. Most of it was the shims' own `Uint8Array.from` copy, which
    WebKit runs byte by byte on a Buffer (117 ms for 5.4 MB).
  - **Live tables wrap at words** and scroll when wider than the column
    (the owner's "this article" reads at words). `contain: inline-size`
    works in WebKit.
  - **PDF embeds:** `#page=N` opens at that page; the password prompt's
    height fits a narrow viewer; no ⟷ inside a live-edit block frame.
  - **Reading view draws an image within a line**, two on a line included
    (`wikiembedImage`, in engine-config.js).
  - Step C, the inline layer's guard, the figures hint and figureFonts
    came through unchanged on iOS (the record says why).
  - Pushed 2026-10-15 in 07810a8 (cloud build OK).
- **No grip above a block frame in Live Edit (2026-10-15, pushed in
  c0f2a20; the owner's report from the device).**
  The short grey bar over every diagram and maths block was this port's
  own: src/ios/styles/ios.css (06ed5cd) made upstream's frame edge a 24 px
  handle with a 40×4 px grip. Upstream made that edge an inert 6 px spacer
  on 2026-10-03, and the desktop never draws a grip. The override is gone,
  so the edge is upstream's 6 px and each frame sits 18 px higher. A
  frame's source is its "Edit source" icon (faint but always shown on
  touch, a 44 pt target). A long-press on the frame's slot still reveals
  it (ios-ui.js). Checked in the simulator: the icon tap reveals the TikZ
  source, and a long-press on the mermaid frame's edge reveals its source.
- **The sync to Clew-app `f4feb68` (2026-10-15) is DONE; every check was
  green in the simulator.** The chain is `sync-f4feb68-p1-vendor` →
  `-p2-build` → `-p3-verify`, off main 9b0b67e. The record is
  UPSTREAM-F4FEB68-PLAN.md. Pushed 2026-10-15 in c0f2a20 (cloud build OK).
  - **A note holding a table keeps its live edit.** Since the 5abf52d
    sync (on TestFlight from 94f0571, 2026-10-10), any table made the
    block field's create throw, and the WHOLE note showed as source in
    Live Edit. That was the owner's "this article". Fixed upstream
    (e7d03c6), with a guard (f4feb68): a construct that cannot be drawn
    stays source alone, and one warning names it. Both were checked
    before and after, and the guard with the bug put back into the
    installed app.
  - **The PDF embed's height is upstream's now** (pdf-size.js, ed6ffb0):
    the iPad's module from 9b0b67e, plus a broken or password-protected
    PDF held at toolbar + 440 px, and ⌈page⌉ + 10 for a one-page PDF. The
    build patches, src/preview/pdf-size.js and its tests went. Sizes
    measured again: the record's table.
  - jmarkdown is at 389b3a1.
- **PDF embeds are one page tall (2026-10-15, 9b0b67e; the owner's report
  from the device).** In Live Edit an `![[x.pdf]]` drew as a toolbar over
  a sliver: upstream's `height: 70vh` is 70% of the block's own frame,
  which is sized to its content. The viewer now reads at fit width, one
  page tall at the width it has, with sizes in the link
  (`![[x.pdf#height=600]]`, `#width=480`, `#width=60%`). Pushed
  2026-10-15. It is upstream's module since the f4feb68 sync.

- **The sync to Clew-app `185e950` (2026-10-11) is DONE; every acceptance
  check was green in the simulator.** The chain is `sync185e950-p1-vendor` →
  `-p2-build` → `-p3-port` → `-p4-verify` → `-p5-backup-guard`, off 0599ee0. Main is
  fast-forwarded to p5 (`-p5-backup-guard`), with a build commit on top. The record is
  UPSTREAM-185E950-PLAN.md.
  - **Colon phase 1:** the Inserts write the @ forms, and each draws
    through the iPad's engine (a worker test). jmarkdown is at 851e8e8.
  - **"Convert this vault"** (Convert colon directives… / Undo the last
    colon conversion… in the palette): upstream's converter runs verbatim
    over the mirror, behind src/shim/colon-conversion.js and native
    ColonConversion.swift.
    - Backups go to Application Support/colon-conversion, under a virtual
      root keyed by the device's vault identity, so an app update keeps
      Undo working.
    - Folder configs come from native.
    - A non-UTF-8 note is refused by name; BOM and CRLF are kept.
    - No device path reaches the sheet.
  - **Measured on 5,006 notes:**
    - convert 118 s (every box: 149 s), frames p99 20 ms at 60 Hz;
    - undo byte-identical;
    - peak memory 513 MB.
  - **Fixed on the way:** a big vault's rescans (57 s each, stacked by the
    20 s timer on the queue every write waits on) now take ~50 ms.
  - **The shims keep a BOM** as Node does (buffer, fs, the hash, the
    write-through).
  - **No note without its backup** (Clew-boss's review, p5): once the
    device refuses one of a conversion's backups or its manifest, no note
    is written. The sheet names each note and gives the reason.
- **The iPad HTML share is the drawn page with no scripts (2026-10-11).**
  The chain is `share-p1-palette` → `share-p2-snapshot` →
  `share-p3-record`, off 52cd16a. Clew-boss verified phases 1 and 2, and
  main is fast-forwarded to p3. The record is HTML-SHARE.md.
  - "Export as HTML" shares a snapshot of reading view's page: figures,
    maths and Mermaid drawn; styles inlined; images as data: URLs within
    2 MB each and 10 MB a page; apps, PDFs, decks and frames as named
    placeholders; wikilinks as text. No script, handler or internal path
    is left, and the shim refuses a page that would carry one.
  - Features/Diagrams shares as 353,722 B with 11/11 figures drawn.
  - The print's hidden view now lets only the note into its main frame
    (a meta refresh had swapped another page into it).
  - The palette offers a book's print alone: its LaTeX, PDF-via-LaTeX and
    HTML commands only ever refused on the iPad.
- **The sync to Clew-app `f959799` (2026-10-10) is DONE, and every
  acceptance check was green.** The chain is `syncf959799-p1-vendor` →
  `-p2-build` → `-p3-contract` → `-p4-verify`, off main 35c8922. Clew-boss
  verified it. Main is fast-forwarded to the p4 branch, and a build commit
  sits on top. The record is UPSTREAM-F959799-PLAN.md.
  - **jmarkdown 21dee42's figure engine** is bundled and inert: the
    iPad's engine config never sets `Figure engine`, and a guard test holds
    that.
  - **Proof this chapter is Mac only:** its Book panel row and palette
    command are not offered, and EXPORT_BOOK refuses `proof` by name.
  - **The exports' figure setting** (exportFigureEngine) has no Settings
    row. The parity gate and the export cache are n/a.
  - **Figures in exports, measured:** note PDF and book print draw 11/11;
    the note HTML export drew 0/11 (its figures were source). The HTML
    share above now draws 11/11.
  - **Vendor** is at Clew-app `f959799`.
- **The sync to Clew-app `6b6fbbb` (2026-10-10) is DONE and PUSHED**
  (origin/main 35c8922; the Xcode Cloud archive succeeded). The chain is
  `sync6b6fbbb-p1-vendor` → `-p2-build` → `-p3-contract` → `-p4-verify`.
  The main checkout's mptikz-assets is restaged with `--release` ("pinned
  v0.4.0 + ghostscript"). The record is UPSTREAM-6B6FBBB-PLAN.md.
  - **mp-tikz-wasm 0.4.0 + Ghostscript**, staged from the release (two
    pinned archives; `--no-ghostscript` drops the AGPL module).
  - **PostScript figures render:** PSTricks, EPS, `\rotatebox`. gs.wasm
    loads only for them and costs about 60 MB.
  - **System font families from CoreText** (SystemFonts.swift): Optima,
    Avenir Next, Gill Sans, Hoefler Text, STIX Two Math and more.
  - **The engines' cache stamp** (AssetStamp.swift): an app update never
    serves stale engines.
  - **Memory, simulator:** a heavy figure note peaks at about 1.3 GB; the
    40-chapter book's print takes 5.9 s, about 0.8 GB plus 0.4 GB. These
    need a device check.
- **The sync to Clew-app `fb3635a` (5abf52d + the pill fixes) is DONE and
  PUSHED** (94f0571; the Xcode Cloud archive succeeded).
- **The sync to Clew-app `5abf52d` (2026-10-10) is DONE, and every
  acceptance check was green.** The owner, relayed by Clew-boss: "Please
  drive the iOS port through to completion. All the way to a push and a
  TestFlight build." The chain is `sync5abf52d-p1-vendor` → `-p2-build` →
  `-p3-contract` → `-p4-verify` → `-p5-repin-fb3635a`. Clew-boss verified
  the chain. Main is fast-forwarded to the p5 branch, and a build commit
  sits on top. The record is UPSTREAM-5ABF52D-PLAN.md.
  - **App secrets on the Keychain** (AppSecrets.swift). The Ticker's
    Finnhub key now survives a relaunch, and a reinstall sweeps what an
    earlier install left.
  - **manifestNeed:** an app that only asks for more is asked live,
    without a reload.
  - **Book mode phase 2:** book numbers in live edit, cross-chapter
    references and jumps, and citations in book order (the render body's
    `book`).
  - **The book print is PORTED:** the reading view's PDF of the whole book,
    one chapter per page, to the share sheet. Its PDF, LaTeX and HTML
    builds still refuse. The Book panel and the reading-view line offer
    Print PDF.
  - The live-edit equation number is shown once.
  - **Re-pinned in p5 to Clew-app `fb3635a`** (`sync5abf52d-p5-repin-fb3635a`):
    citation pills follow a style edited in an editor, the master's for a
    chapter (c115418) and a note's own (fb3635a).
  - **Vendor** is at Clew-app `fb3635a`.
- **The sync to Clew-app `cbfa692` (2026-10-06) is DONE and PUSHED**
  (3947dd7; the Xcode Cloud archive succeeded).
- **The sync to Clew-app `cbfa692` (2026-10-06) is DONE, and every
  acceptance check was green.** The owner, relayed by Clew-boss: "Push
  and sync the iOS build tonight, for sure." The chain is
  `synccbfa692-p1-vendor` → `-p2-build` → `-p3-contract` →
  `-p3b-demo-sync` → `-p4-verify`. Clew-boss verified the chain. Main is
  fast-forwarded to `synccbfa692-p4-verify`, and a build commit sits on
  top. The main checkout's mptikz-assets is staged from Clew-app's v0.3.1
  release tree. The record is UPSTREAM-CBFA692-PLAN.md.
  - **Book mode:** the Book panel, "Ch. 2 of Book", and next/previous
    chapter port as they are. **Build is desktop only:** EXPORT_BOOK
    refuses with a sentence.
  - **The engine's `util`:** a worker shim (isDeepStrictEqual) for
    book.js.
  - **Origin-bound app network grants** (917303b, a security fix) in
    src/shim/apps.js.
  - **The demo vault is brought up to date on each opening**
    (DemoSync.swift, desktop's demo-sync.js rule for rule). New demo notes
    are added and untouched ones updated. Edits, deletions and dot paths
    are never touched, and nothing happens outside Documents/Demo Vault.
  - **mp-tikz-wasm v0.3.1,** staged from Clew-app's release tree.
  - **Findings** (record §Findings): app-frame localStorage lasts one
    launch, so the Ticker's Finnhub key is asked for once per launch. A
    numbered equation's number is drawn twice in live edit, which
    predates this sync.
  - **Vendor** is at Clew-app `cbfa692`.
- **The sync to Clew-app `77b0bea` (2026-10-04) is DONE and PUSHED
  (210008f), and every acceptance check was green.** The owner, relayed by Clew-boss: "Sync
  the iPad with the sample apps too", then "Push it when it's all green".
  Main is fast-forwarded to `sync77b0bea-p4-verify`, and a build commit
  sits on top. The record is UPSTREAM-77B0BEA-PLAN.md.
  - **The sample apps and the App Gallery** are in the demo vault, each
    behind its prompt. The ticker is pinned at the bottom of its note, in
    reading view and in Live edit, without reloading its frame.
  - **An app's copy reaches the system pasteboard** (`clipboardWrite`). A
    paste reads Clew's own last copy.
  - **Prompts focus the card,** so a typed key never answers one.
  - **Fewer build patches:** admonitions.js and device-name.js are
    upstream's, and so is the shared callout-types.js.
  - **The status bar's text sits inside the bar.** The safe-area padding
    the toolbar already takes is gone; it was clipped from M4 until now.
  - **Vendor** is at Clew-app `77b0bea`.
  - **Smoke runs:** DEBUG `ClewFrameSmokeJS` runs a script inside each
    app frame. `simctl uninstall` keeps cfprefsd's cached defaults, so
    delete the smoke keys around a reinstall.
- **The sync to Clew-app `f3a7d5b` + `686232b` (2026-10-03/04) is DONE and
  PUSHED** (0433870; the Xcode Cloud archive succeeded). The record is
  UPSTREAM-F3A7D5B-PLAN.md.
  - **Vault trust v2:** enablements live on the device; a CSP header goes
    on previews.
  - **Apps in notes:** the `clew-frame` scheme; the grants are the
    device's.
  - **Shared conflict UI** (2f5d80d).
  - **PDF save safety:** SHA-1 `base`, as one binary POST with the token
    in a header.
  - **Quote-and-cite** with printed pages; the stamps served locally.
  - **Vendor** was at Clew-app `686232b`.
- **Before that:** the overnight features of 2026-10-03 (the symlink fix,
  the vault switcher, conflict safety, scan and quick actions) were
  integrated and PUSHED as cedb81e. `share-extension` (788d4ea) still
  waits for the owner's App Store Connect steps (CAPTURE.md).
- **The overnight sync to Clew-app `03bb33a` (2026-10-02) is DONE, and
  every acceptance check was green.** On the owner's instruction, relayed
  by Clew-boss ("have it run overnight. It can push to main so that a
  TestFlight build is waiting by the morning"), main is fast-forwarded to
  `sync5-p4-verify` and a build commit is pushed on top. Memory and
  Clew-boss's ledger have the pushed hash and the Xcode Cloud result.
  The record is `UPSTREAM-03BB33A-PLAN.md`.
- **What it carries** (since 0.12.0):
  - callouts are the engine's, with custom callout types (Settings →
    Callouts, global and per vault);
  - the view-mode switch in each pane's tab strip; **the iOS tab strip is
    44 px** (desktop 34);
  - cite pills read what reading mode shows; `\fullcite` drawn inline;
  - reading mode follows a .bib edit;
  - split layouts that keep their frames;
  - the open race fixed;
  - ⌘1–⌘9; text brightness; bare URLs link; literal directive arguments.
- **Vendor** is at Clew-app **`03bb33a`**, copied from `git archive
  03bb33a` and byte-verified.
- **Version 0.12.0.** Desktop is still 0.12.0; this is a pre-0.12.1 build.
  The iPad follows Clew-app RELEASES: `Info.plist` and both
  `MARKETING_VERSION` lines. Build numbers stay Xcode Cloud's.
- **Tests on main:** `npm test` 706, `npm run test:swift` 154 + 23. Green,
  but they don't prove the app renders. This sync's worker hang was
  invisible to Node (§5).
- **Branch `integration` (off main e4ce7cb), NOT pushed: the overnight
  work of 2026-10-03, ready for ONE push decision.** It merges four
  branches, each also kept on its own:
  - `fix-symlink-escape` (**security**): links leading out of a vault are
    no longer followed, by a realpath clamp (VaultPaths.swift). Shipped
    builds served container files through vault symlinks.
  - `vault-switch`: the iPad's way between vaults. Open it from the
    explorer's vault name, "Switch vault…" or ⌘⇧O. A switch settles the
    open vault, then reloads into the next.
  - `conflict-safety`: a save over another device's unseen edit is
    refused. iCloud conflict versions, Dropbox conflicted copies and git
    markers are detected. Both versions go to `.clew/history`, then
    Keep Mine / Theirs / Both / Compare. See CONFLICT-SAFETY.md. The
    integration pass found a false conflict on every second save
    (URL-cached mtimes); it is fixed on that branch and merged here.
  - `ipad-capture` (phase 1): Scan document / Scan text into a note
    (VisionKit, plus OCR as a searchable PDF text layer), and Home Screen
    quick actions. See CAPTURE.md.
  - **Not in it:** `share-extension` (capture phase 2, "Save to Clew"). It
    needs an App Group and a new bundle ID in App Store Connect first;
    CAPTURE.md lists the steps.
  - **Verified:** `npm test` 727; `npm run test:swift` 154 + 27 + 18 + 9;
    the build succeeds. A simulator pass on a fresh container covered all
    four together: the symlink 404s with the plist untouched, a refused
    save → the sheet → Keep Both, a scan, separate saves with no false
    conflict, and A → B → A with the last typed text landing in A.
  - The `frame-bridge-review` branch is docs only
    (FRAME-BRIDGE-REVIEW.md).

## 2. Waiting on the owner

- **Push main** (a push to main is a TestFlight build). origin/main is
  b1443f4, pushed 2026-10-20: the 0ada21d sync. The 0e773c3 sync's build
  commit (the tip of `sync-0e773c3-p3-verify`) goes onto main once
  Clew-boss has verified it. The push is on the owner's word, typed in
  the Clew-iOS window.
- (Decided 2026-10-20: both of a note's LaTeX exports come to the iPad,
  through mp-tikz-wasm, in every vault. Until they are built, the palette
  keeps both commands, refused when run.)
0. **Push `integration`** (a push to main is a TestFlight build), and say
   whether the share extension should follow, after the App Store
   Connect steps in CAPTURE.md. On the device, check:
   - a real camera scan;
   - Keep Both on a note edited on the Mac and the iPad at once;
   - a vault switch with unsaved text.
1. **Release 0.12.0 to testers.** The cloud build does not join a tester
   group by itself. Open
   https://appstoreconnect.apple.com/apps/6804827534/testflight/ios (sign
   in as j.mckenzie.alexander@mac.com, NOT the iCloud ID). Add the
   build's Internal group, or turn on the group's "Enable automatic
   distribution" once.
2. **The iPad checklist**, at the end of both latest records:
   - keyboard toolbars, with a hardware keyboard and with the software one;
   - web PDFs and portal thumbnails;
   - trust: first-open refusal, Trust, revoke;
   - the Meta Bind padlock tap;
   - Enter in a text field, and a textArea newline written as
     `"one\ntwo"`;
   - tabbing;
   - kanban at 826 px portrait;
   - map measuring with a keyboard and trackpad;
   - Settings showing 0.12.0;
   - `![[x.pdf]]` opening straight in the viewer.
3. **Older device-only checks, still owed** (live edit, from earlier
   syncs):
   - a real tap on a concealed link;
   - `visualViewport` shrinking with the software keyboard;
   - the preview pane (it needs `document.hasFocus()`, which a
     simctl-launched page never has);
   - touch-scroll chaining from block frames;
   - memory at the frame cap of 8 on the Diagrams note;
   - IME in concealed words and table cells;
   - a real finger on a frame's "Edit source" icon (the grip above frames is gone, 2026-10-15);
   - a hardware-keyboard Esc leaving an engaged canvas card;
   - backgrounding in the middle of an annotation.

## 3. Next

- **The next sync's range starts at Clew-app `0e773c3`.** Coming:
  mp-tikz-wasm v0.5.0 (the latex-doc bundle) and jmarkdown ba83371
  (setFigureLibrary), which Clew-app will vendor and pin; Clew-boss
  sends a notice.
- **Next work: a note's LaTeX exports on the iPad** (the owner's yes,
  2026-10-20: "tex yes, pdf yes, 1a 2a 3 allow 4 ok").
  - .tex first: the engine worker's `to:'latex'`, MetaPost figures through
    mp-tikz-wasm, and a share of the .tex or a zip.
  - Then PDF via LaTeX: LuaLaTeX in mp-tikz-wasm, after its latex-doc
    bundle, bibtex/makeindex wasm and third-pass fix, and jmarkdown's
    coloured code stand-in.
  - Every vault is allowed: no shell escape, and no file outside the vault
    reaches the engine. The app grows 12–17 MB.
  - A device memory check comes before the PDF ships (~550 MiB a LuaLaTeX
    pass).
  - The plan will be UPSTREAM-LATEX-EXPORT-PLAN.md; the scoping is in
    Claude's memory and Clew-boss's ledger.
- **iPad checks from the 0ada21d sync:** its record's list (a hardware
  keyboard's Enter, ⌘Enter and ⌘L in a list; the on-screen keyboard's
  Return and the Next item button; `{{TOC}}`, a title block and a quote in
  a list on the device).
- **iPad checks from the 0e773c3 sync:** its record's list (a quote under
  a nested item; a tab-indented list under a finger).
- **Upstream candidate from the 0e773c3 sync:** in a monospace editor
  face, a quote in a numbered item stands 5.6 px left of its item's text
  (the number is drawn wider than the fixed hang).
- (Done upstream in 7c46c38: the 0ada21d sync's nested-quote 2 px.)
- (Done upstream in f0aeaa4's range: the ef5f7f2 sync's two card
  candidates, and the colon list's fill.)
- **iPad checks from the f0aeaa4 sync:** its record's list (the cards
  under a finger; the colon list on a big vault).
- **From the f4feb68 sync's candidates:** the password card's height and
  the letter-a-line table were fixed upstream (ef5f7f2's range). Not
  re-measured: with `#height=` alone, the PDF sat 6 px down.
- **iPad checks from the ef5f7f2 sync:** its record's list (the index save
  on a big vault, the owner's table, `#page=N`, two images on a line,
  "Open" at the narrow width).
- **iPad checks from the f4feb68 sync:**
  - the owner's "this article" in Live Edit;
  - a password-protected PDF with the sidebars closed, and in landscape;
  - the owner's 373-page PDF in Live Edit, in landscape, where one page
    is taller than the screen, so the editor scrolls past it;
  - annotating in a one-page-tall embed (the save path is untouched).
- **If jmarkdown's figure engine is ever turned on in the worker**, shim
  `setImmediate` first: figure-engine.js's runAll() awaits it, and the
  worker does not define it (UPSTREAM-F959799-PLAN.md).
- **iPad checks from the 185e950 sync:** its record's list (an iCloud
  Drive vault converted, so the conflict key is asked there; a big vault's
  convert and undo on the device; the sheet under a finger).
- **Upstream candidates from the 185e950 sync:**
  - (done: the indexer's cache save, upstream ef5f7f2 and this port's
    copy fix, 21–35 ms on 5,006 notes);
  - the sheet's folded 4,001-note list lays out at ~56 ms a frame while it
    fills.
- **Next:** colon phase 3 (jmarkdown drops the colon forms). The same
  sync must drop `tikzDirective` from src/shim/engine-config.js.
- **iPad checks for the HTML share:** HTML-SHARE.md's list (Diagrams
  shared to Files and opened in Safari, an image over 2 MB, a share opened
  on a Mac).
- (Done upstream, 1406ffc: two image embeds on one line drew the first as
  "!" plus a link.)
- **iPad checks from the f959799 sync:** its record's checklist (no Proof
  row in a chapter's Book panel; a book with figures prints them).
- **iPad checks from the 6b6fbbb sync:** its record's checklist
  (PostScript, named families, Features/Diagrams on the device (it peaks
  at 1,285 MB in the simulator), a long book's print).
- **iPad checks from the 5abf52d sync:** its record's checklist (the
  Ticker's key across a relaunch, the book print, a real finger on the
  grip and a chip).
- **iPad checks from the cbfa692 sync:** its record's checklist (the demo
  vault's notice, the Book grip under a finger, the Ticker asked once).
- **iPad checks from this sync:**
  - the 44 px tab strip;
  - the mode switch under a finger;
  - ⌘1–⌘9 from a hardware keyboard (synthetic keys work in the simulator);
  - custom callouts in Settings (the picker's cells are 34 px);
  - a split with live block frames. Closing a pane reloads frames in the
    panes re-inserted after it: WebKit has no `moveBefore`.
- **Upstream candidates from this sync:**
  - admonitions.js's `file:` import hangs in WebKit workers (iOS patches
    it);
  - "every vault on this Mac" in Settings → Callouts on the iPad;
  - a shareable main/callout-types.js.
- **Optional:** a SchemeHandler twin of desktop's document redirect
  (Clew-app 29fa2ae). Key it on `Accept`. Until then WebHost's leak check
  blanks a raw PDF frame, which is safe.

## 4. Standing rules (also in Claude's memory)

- **End every message the owner reads with a short executive summary**
  (the owner's rule since 2026-10-06): what matters, what needs the
  owner's action, and "details on request: …" for what was left out.
  Reports to Clew-boss keep their full detail.
- **Before the first App Store submission: decide the GPL/AGPL engines**
  (Clew-boss and the owner). dvisvgm, pdfTeX and LuaTeX are GPL;
  Ghostscript is AGPL and can be dropped with `--no-ghostscript` in
  ios/ci_scripts/ci_post_clone.sh. TestFlight builds ship them all.
- **A push waits for the owner's own word typed here** when they have put
  a hold on directly here, or the permission classifier wants it (it
  blocked a relayed release once, on 2026-10-04).
- **Push whenever Clew-boss says to.** The owner's rule, 2026-09-30:
  "Please push whenever @Clew-boss tells you to." Clew-boss sends a push
  instruction only with the owner's authorisation. Never push on your own
  initiative.
  - A push to main IS a TestFlight release: Xcode Cloud builds every push
    whose TIP commit message lacks `[ci skip]`.
  - The marker counts anywhere in the message, body included. A build
    commit must never quote it (fbb56f4 did, and sat unbuilt).
  - Docs-only commits carry it.
  - A real build shows a "Clew | Default | Archive - iOS" check run within
    a minute (`gh api repos/jmckalex/Clew-iOS/commits/<sha>/check-runs`).
  - This session's own permission check may still refuse a release step.
    Then tell the owner and Clew-boss. NEVER route it through another
    session.
- **Clew-boss** (`~/Source/Clew`, the coordinator) speaks for the owner on
  syncs, which Clew-app commit to port, and iOS work. Design questions go
  to the owner through Clew-boss. **Report every finished task to
  Clew-boss** (SendMessage): commits, pushed or not, the sync point, and
  cross-repo effects.
- **Never edit `vendor/` by hand.** It is a mirror of `../Clew-app`,
  overwritten by `scripts/sync-upstream.js`. iOS code lives in `src/` and
  `ios/`.
- **Phase per branch**, chained (`syncNNN-p1-vendor` → `p2-build` → … →
  `p4-verify`), so a bad phase falls back cleanly.
- **After any simulator check:** `simctl terminate` the app, `simctl
  uninstall` a test install that carries fixtures, and `simctl shutdown`
  the simulator. The owner dislikes stray windows.
- No probing of untrusted-frame capabilities against real networks: only
  defensive tests, with fakes.

## 5. How a sync runs (the recipe that worked three times)

1. **Dry run** while waiting for the pin (cheap, read-only):
   - Make a throwaway `git worktree` of the current tip in the scratchpad.
   - Extract `git -C ../Clew-app archive <commit>` beside it as `Clew-app/`,
     so `sync-upstream.js` reads it.
   - Symlink `node_modules`; run `node scripts/sync-upstream.js`, then
     `npm run build`, `npm test` and `npm run test:swift`.
   - Remove the worktree.
2. **p1 vendor**:
   - The same worktree layout, but on a new branch, and from
     `git archive <pin>`, never the live `../Clew-app` (Clew-app works in
     parallel).
   - `diff -rq` every mirrored directory against the archive; it must be
     byte-identical.
   - `git checkout -- ios/Clew/Assets.xcassets`: the icon is regenerated
     non-deterministically.
   - Commit, then tell Clew-boss "copy done" at once (it unfreezes
     Clew-app).
3. **p2 build**:
   - Merge any waiting branches, and fix whatever the build or tests flag.
   - `patched()` throws on a missed anchor.
   - The app-bundle tripwire throws on any unguarded `process` read.
4. **p3 contracts**: audit new IPC channels against the shim: every
   `CH.X` the vendored renderer invokes must be answered in
   `src/shim/ipc.js`. Port desktop's main-process half of each into the
   shim, or native.
5. **p4 simulator — always a REAL BOOT.**
   - Sync #3's first install booted to nothing: vendored `fs-utils.js`
     read `process.env` at load, and the app page has no `process`.
     Neither the Node tests nor the dry runs could see it.
   - The boot check must also RENDER a note and a block
     (`__clewNative.renderNote` / `renderBlock`, with timeouts). In the
     03bb33a sync the app booted, but the worker never answered: a
     `file:` import that never settles in WebKit. Every open looked fine
     until something had to render.
   - Then fixtures, probes and screenshots (§6).
   - Then uninstall and shut down.
6. **Record**: `UPSTREAM-<pin>-PLAN.md` (pin, range table, results,
   findings, the iPad checklist), plus this HANDOVER. Report to Clew-boss
   and stop. The push happens on Clew-boss's word.

## 6. Verification kit

- **Build**:
  - First, `export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`.
  - Then `npm run sync-mptikz` (once; `mptikz-assets/` must be a REAL
    directory: a symlink is copied into the app and installd refuses it)
    and `npm run build`.
  - Then `xcodebuild -project ios/Clew.xcodeproj -scheme Clew -destination
    'platform=iOS Simulator,id=90DCB612-1B85-4E1A-A17A-DBEB98F6C36D'
    -derivedDataPath <dir> build`. That simulator is an iPad Pro 11" M4,
    and it is portrait: 834 wide, so an 826 px note pane with both
    sidebars closed.
- **Smoke**:
  - Run `xcrun simctl launch <sim> org.jmckalex.clew.ios -ClewSmokeJS
    '<js>'`, terminating the app first.
  - The body is an async function. Only its return value is logged, read
    with `xcrun simctl spawn <sim> log show --start "<local time>"
    --predicate 'eventMessage CONTAINS "CLEWJS"'`.
  - The log TRUNCATES a value at about 1,000 characters; split the output,
    or use kv (next bullet).
  - **Better: deliver the script with `xcrun simctl spawn <sim> defaults
    write org.jmckalex.clew.ios ClewSmokeJS -string "$(cat script.js)"`**,
    then launch with no argument, and `defaults delete` the key
    afterwards. A `-ClewSmokeJS` argument is parsed as a property list,
    which eats backslashes; `-string` keeps them, so Clew-app's scenarios
    run nearly verbatim.
- **Inside preview documents** (cross-origin from the app page):
  - Install a temporary preview-surface plugin at
    `<vault>/.clew/plugins/<id>/` (`manifest.json` with `surfaces.preview`)
    and add its id to `vault-settings.json` `plugins`.
  - It runs in every rendered note. Viewer frames inside it are
    same-origin and reachable.
  - Report with `window.clew.kv.set('smoke/…')`. Results land in the
    vault's `clewdata.json`, readable from the host.
  - Remove the plugin afterwards, or uninstall the app.
  - Since trust v2, the `plugins` list in vault-settings.json is only a
    request. Switch the plugin on with `clew:vault-access-set {key:
    'plugins', value: [...]}`. The note's document must be served after
    that, so relaunch if its tab was restored at boot.
- **App prompts come one at a time** (app-host.js's queue): click Allow
  on whichever `.clew-app-sheet` is showing until the one you want
  appears. The Ticker's is last in the App Gallery.
- **An old demo copy:** install, plant the copy in
  `Documents/Demo Vault` BEFORE the first launch, then launch
  (UPSTREAM-CBFA692-PLAN.md).
- **Fixtures**:
  - The app container moves on every `simctl install`: re-read
    `simctl get_app_container <sim> org.jmckalex.clew.ios data` before
    writing.
  - Write fixtures only AFTER the first launch: it seeds the demo vault
    and runs the trust migration, which trusts every vault already in
    Documents.
  - A vault created afterwards is unknown, so untrusted.
  - **Web PDFs need no network.** Seed
    `Library/Caches/remote-pdfs/<sha256(url)>.pdf` and a `.json`
    (`{url, finalURL, fetchedAt: <now, seconds>, size, lastUsed}`).
  - `https://127.0.0.1/…` and `http://…` are refused before any
    connection.
- **Handles**:
  - `window.__clew` (`workspaceStore`, `vaultStore`, `ipc`, `registry`,
    `editorPool`, …).
  - `window.__clewNative` (`renderNote`, `renderFragment`, `renderBlock`,
    `blockDocument`, `externalDiff`, `flush`, `sessionId`).
  - The session id is random per vault open; the render POSTs need the
    caller token (`__clewShim.services.vaults.callerToken`) in a JSON body
    with NO Content-Type.
  - The bridge's `pdfLeakCount` should stay 0.
  - In viewers: `__clewPdfHandle`, `__clewRemoteFailure` and
    `__clewRemoteSaved`.
- **Gotchas**, the rest in Claude's memory `clew-ios-verification`:
  - `document.hasFocus()` is false in a simctl-launched page.
  - `message` listeners added from the smoke hook never fire.
  - Quick Look covering the app breaks printing.
  - `simctl` hanging means CoreSimulatorService is wedged: a reboot, or
    `killall -9 com.apple.CoreSimulator.CoreSimulatorService`, clears it.

## 7. Build facts

- **Twelve guarded patches** (`patched()` in `scripts/build.js`), all
  matching at `03bb33a`:
  - `builtin.js` (`shell:toggle` removed);
  - `clew-canvas-view.js` (the office Live choice);
  - `clew-editor-view.js`, `clew-file-explorer.js` and `node-content.js`;
  - `clew-file-view.js` ×2;
  - `clew-settings-view.js` ×3 (the CJK-font and office sections, and the
    LaTeX engine row);
  - `tab-drag.js`;
  - **`admonitions.js`**: the worker imports `#jmarkdown/callout-table.js`
    directly. Its runtime `file:` import never settles in a WebKit
    worker, and nothing rendered.
- **The worker applies CLEW_CALLOUTS at init** (engine-worker.js). The
  engine's table reads it at load, which is worker start here, before the
  env exists.
- **`fa-icons.json`** is built into the WebRoot (writeIconTable).
- **Other build-time pieces:**
  - The engine plugin rewrites `await import(` in `metadata-header.js` to
    a registry, and declares algebra.js's `Term`. Candidate 13, an engine
    importer hook upstream, would retire the first.
  - The `@xterm/*` alias points at `src/shim/xterm-stub.js`, since there
    is no PTY on iOS.
  - The app-bundle `process` tripwire.
  - `src/preview/embed-scroll.js` is appended to the preview client.
- **Swift sources:**
  - `WebHost` (the web view, the scroll-offset pin, the PDF leak check);
  - `SchemeHandler` (clew-app://, and clew-preview:// with its routes:
    notes, `__clew_fragment__`, `__clew_block__`, `__clew_remote_pdf__`,
    assets);
  - `FSBridge` (answers the app page's main frame only);
  - `VaultStore`, `VaultTrust` (Application Support);
  - `RemotePdfPolicy`, `RemotePdfFetcher` and `RemotePdfStore`
    (Network.framework, pinned with SNI, https only, 50 MB, the device
    cache);
  - `OfficeThumbs`, `NoteFonts`, `PrintPDF`, `QuickLookPresenter`,
    `HEICConverter` and `AtomicFile`.
- **Upstream candidates** (PORT-PLAN's list is stale on these):
  - Landed: 1–4, 7–9 and 14; also 10/11, 12 and 15, which were retired at
    sync #2.
  - Withdrawn: 6.
  - Deferred: 16, long-press as ⌥.
  - Open: 13 (the engine importer hook), and the remainder of 5 (§3).
- **Deferred, unchanged:**
  - `\citefile`;
  - native CJK font download;
  - kanban touch drag;
  - "Move to folder…";
  - empty folders in the explorer;
  - iCloud conflict surfacing;
  - stale recents pruning;
  - ZetaOffice (Quick Look stands in);
  - a touch route to link previews and map measuring.
