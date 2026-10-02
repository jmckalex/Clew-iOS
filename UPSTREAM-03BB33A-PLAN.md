# Upstream sync to Clew-app 03bb33a — plan and record

**STATUS: EXECUTED 2026-10-02 (overnight), ALL ACCEPTANCE CHECKS GREEN.**
The owner's instruction, relayed by Clew-boss: "Schedule the iOS sync
after the engine fixes land — have it run overnight. It can push to main
so that a TestFlight build is waiting by the morning." The push is
approved only if every check is green.

The chain:
- `sync5-p1-vendor` (c2a5512)
- `sync5-p2-build` (1d166bf)
- `sync5-p3-contract` (b1a303e)
- `sync5-p4-verify` (this record, plus two fixes found in p4)

**PIN: Clew-app `03bb33a`.** Copied from `git archive 03bb33a`, never the
live tree, and byte-identical to that archive in every mirrored directory.
The range 9268aa3..03bb33a has 28 commits.

**Version:** 0.12.0, unchanged. Desktop's package.json is still 0.12.0;
this is a pre-0.12.1 TestFlight build. The build number is Xcode Cloud's
next.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| Callouts are the engine's (5f870b2, 67311b6, 2f0ad5c) | The worker and config drop the deleted `engine/callouts.js`. **CLEW_CALLOUTS is applied at worker init**: the engine's callout-table.js reads it at LOAD, which in this bundle is worker start, before init sets the env. **p4: a guarded build patch** makes the worker import `#jmarkdown/callout-table.js` directly. admonitions.js's primary path, a top-level `import(<file: URL>)`, never settles in a WebKit module worker, so the worker never finished loading and NOTHING rendered. Node rejects it at once, so the tests could not see it. |
| Custom callout types (096f129) | CALLOUTS_RESOLVED, CALLOUT_ICONS and EV_CALLOUTS_CHANGED in the shim. Both scopes are resolved with the engine's pure `resolveCallouts`; desktop's main/callout-types.js reads disk and a bare `process`. CLEW_CALLOUTS reaches the worker env. `fa-icons.json` is built into the WebRoot (FA 7.3.1, 2883 icons) and fetched only when a definition exists or the picker asks. The settings handlers re-resolve and reconfigure. |
| Reading mode follows a .bib edit (a1d8de0) | Ported into the shim's render service (`noteBibFiles`, restale). |
| The mode switch in the tab strip (b0fe140, 80b8b44) | **The iOS tab strip is 44 px (desktop 34).** Measured: a hit area reaching past a 34 px strip is painted over by the title bar and editor toolbar, and lifting it over them would take the top of the toolbar's buttons. The mode buttons are 44 px wide, with a hit area the strip's full height. |
| PDF via LaTeX picks its engine (0b4b7a4) | The `latexEngine` Settings row is dropped (no TeX on iOS), chained into the existing settings-view patch. |
| Open in Default App (1b98e07) | Nothing: it reaches SHELL_OPEN_PATH, which is Quick Look on iOS. |
| ⌘1–9 (a3bb88c), Window menu (5119d93), text tokens, callout styling, literal directives, bare URLs, the split reconciler, the open race, the build stamp | These arrive with the vendor. |

Settings defaults gain `callouts`, `latexEngine`, `pdfCjkFonts` and
`shellFont`. The defaults test now reads the vendored desktop key list.

**Tests:** 706 JS and Swift 154 + 23.
- Clew-app's updated tests were taken whole, plus `cite-label` and
  `custom-callouts`.
- New tests cover custom callouts across both scopes, the .bib restale,
  and **the callout merge against desktop's main/callout-types.js**
  (identical results, field by field). The cases are a name defined in
  both scopes, a vault recolouring a built-in, and refused entries with
  their reasons.

## Results (simulator, iPad Pro 11" M4, portrait)

Fixtures are Clew-app's own smoke vaults (make-mode, make-cite,
make-callout) plus the demo vault. The scenarios are Clew-app's, adapted.
The smoke script is now delivered with `simctl spawn defaults write
-string`, so backslashes survive.

- **Boot:** a fresh install of the final build opens the demo vault
  (trusted), renders a note, and renders a mermaid block.
- **Open race** (09aabdf): 12 of 12. Every mode × every variant shows and
  draws the right mode, with no errors.
- **Mode switch:**
  - three buttons, each 44 × 34 in a 44 px strip;
  - a finger 21 px above, below, left or right of each centre still hits
    it;
  - five clicks switch modes, and live edit is drawn;
  - hidden in place for a canvas, a .bib file and Settings, with the +
    unmoved;
  - pinned beside + with 28 tabs open, the tabs scrolling.
- **⌘1–9:** synthetic ⌘2 and ⌘9 switch tabs. The hardware key path is an
  iPad check (the app registers no UIKeyCommand).
- **Split and frames** (8e9db79): mode, tab, split and reorder cause no
  reloads, no detaches, and toolbars stay. Closing a pane reloads frames
  in the panes re-inserted after it: WebKit has no `moveBefore`, so the
  insertBefore fallback runs, as Clew-app's commit says. **Against 0.12.0
  (main) on the same scenario:** every operation reloaded 2 frames, mode
  jumped the editor 116 lines, and toolbars were lost. So this is a
  strict improvement. Top-line shifts of 6–15 lines seen once are long
  lines rewrapping when a pane narrows; they are 0 where widths do not
  change.
- **`\fullcite`** (f504e57): inline in live edit, equal to reading mode
  for every known key. An unknown key is marked missing.
- **Cite pills** (f17c531, 3ef9c4f): equal to reading mode for every known
  key. An unknown key shows the key where reading mode shows
  `[undefined]` or the raw `\cite`, which is the design.
- **A .bib edit:** all four Lewis pills go from 1969 to 1970; reading mode
  re-renders to 1970; and **the References panel in Note mode follows it
  (1969 → 1970). That is the overdue check, done.**
- **Callouts:** reading and live are identical, 11 of 11, on type, title,
  colour and icon path. They cover the built-ins, nested and folded ones,
  a global custom type, a vault custom type titled from its definition,
  and an unknown type drawn as a note.
- **Callout commands and Settings:** the palette offers the custom types
  and not the refused one. Settings → Callouts lists the global rows, and
  shows the refused one as "Skipped: no Font Awesome icon called “nope”."
  The LaTeX engine row is gone.
- **Standard checks**, all as 0.12.0:
  - web PDFs: read-only at #page, Save a copy, refusals by name, the vault
    PDF in the viewer;
  - `![[x.pdf]]` with no raw load;
  - tabbing 6/6;
  - Board4 at 826 px: 790, no scroll;
  - the padlock: 44 × 44, inert until tapped;
  - thumbnails; leak count 0;
  - trust: refuse → trust → revoke;
  - the resting layout.

## Findings (upstream candidates)

1. **admonitions.js's `import(<file: URL beside process.argv[1]>)` never
   settles in a WebKit worker.** iOS patches it at build. Upstream could
   import `#jmarkdown/callout-table.js` statically wherever the engine and
   admonitions share a module graph.
2. **The Callouts group says "every vault on this Mac"** on the iPad.
3. **main/callout-types.js** could be shareable (no disk read, a guarded
   env); Clew-boss has logged it.

## The owner's iPad

- The new 44 px tab strip: does it look and feel right?
- The mode switch under a finger.
- **⌘1–⌘9 from a hardware keyboard.**
- Custom callouts in Settings with the touch keyboard. The picker's cells
  are 34 px.
- A split with live block frames. Close a pane and watch the frames
  reload; the others should not.
- Plus the 0.12.0 list (UPSTREAM-0.12.0-PLAN.md).
