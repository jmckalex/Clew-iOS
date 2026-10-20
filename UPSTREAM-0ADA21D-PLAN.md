# Upstream sync to Clew-app 0ada21d (2026-10-20)

Approved by Clew-boss on 2026-10-20, after the owner pushed Clew-app
0ada21d. The 3447b9d push (the f0aeaa4 sync) had built in the cloud.

## The range, f0aeaa4..0ada21d (13 commits)

- 33bf174: live edit's `{{TOC}}` follows the headings as they are edited.
  Before, it changed only once the cursor had been through it, and a
  click after an edit above a heading landed where the heading used to be.
- e4667a9, 72031e6: `@title`, `@subtitle`, `@author`, `@institution` and
  `@date` alone on their lines are a title block. Reading view sizes them
  as the engine's LaTeX does, and live edit draws them so, not as
  underlined directive text.
- fa1a141: a quote inside a list item stands under the item's text in
  live edit, as reading view's `<li>` holds it.
- 1dc5c81: a live-edit quote reads as reading view's: muted text and the
  border's grey bar, not source mode's quote green.
- a7baa98, dc2ed22: Enter stays in a list item, so an item takes several
  paragraphs. ⌘Enter starts the next item. That holds on an item's first
  line too: lang-markdown's Prec.high keymap ran before listEnter there
  (editor/list-keys.js, note-keys.js).
- 8408d73, 0ada21d: ⌘L makes a line a task, as Obsidian's Toggle checkbox
  status does. A task's status must be one Clew knows (`[ xX/-]`), so
  `- [1] Smith 2020` becomes `- [ ] [1] Smith 2020`.
- 7eae0d0: the toolbar has a Next list item button, ⌘Enter's
  `editor:new-list-item`, enabled in a list. It is drawn only for a
  touch-first host, and the iOS shim says the iPad is one
  (renderer/lib/host.js reads `window.clew.host.touchFirst === true`).
- 3bfc0b6, 963b2bd, 41f8713: Clew's LaTeX style (EB Garamond) for the
  desktop's LaTeX exports (engine/latex-style.js, applied in
  export-worker.mjs). The note's header has a say. The setting
  `latexExportStyle` is a row under Settings → Appearance.

## Phases (one branch each, chained off main 3447b9d)

1. `sync-0ada21d-p1-vendor` ae2ca60: vendor from `git archive 0ada21d`.
   diff -rq shows no difference in vendor/clew, vendor/jmarkdown (src and
   package.json), vendor/embedpdf, vendor/default-stamps or seed-vault.
   The regenerated icon was put back.
2. `sync-0ada21d-p2-build` 95e3a82:
   - `window.clew.host = Object.freeze({ touchFirst: true })`, set in
     src/shim/ipc.js, which install-shim.js runs before the renderer
     starts.
   - The `latexExportStyle` row and its hint are patched out of
     clew-settings-view.js. The iPad has no LaTeX export yet. The key
     defaults to `'clew'` in src/shim/settings.js, so a settings object
     reads the same everywhere.
   - Tests: tests/services.test.js checks the host flag (frozen, and
     upstream's `touchFirst()` reads it). tests/no-latex-ui.test.js
     checks the row's three strings are gone from the bundle. It fails
     without the patch.
   - Every other patch holds. None touches the toolbar, the live-edit
     files or editor.js.
3. `sync-0ada21d-p3-verify`: this record.

## Checks

- npm test 791/791. Upstream's latex-style, list-keys, live-model and
  toolbar-state tests against vendor/clew: 62/62. latex-style's worker and
  engine paths were pointed at vendor/. Swift 339/339 in 7 suites.
  xcodebuild for the simulator: succeeded.
- **The LaTeX style is inert here.** latex-style.js is imported only by
  desktop's export-worker.mjs. iOS has no LaTeX export (yet: see
  UPSTREAM-LATEX-EXPORT-PLAN.md, to come).

**In the simulator** (iPad Pro 11", portrait, demo vault). Upstream's four
new scenarios ran in the app page. **The input is synthetic, and that
matters:**
- keys are `keydown` events dispatched on CodeMirror's contentDOM;
- text goes in through `replaceSelection` (`input.type`);
- clicks are a `mousedown`/`mouseup` pair.

So these checks prove the keymap and the commands. They do not prove
iOS's hardware-key path or the on-screen keyboard. A synthetic Enter
still takes CodeMirror's iOS pending-key route (keyCode 13 is held 250 ms,
then dispatched). ⌘ keys go straight to the keymap.

- **The host:** `navigator.platform` is `MacIntel`, so CodeMirror's and
  Clew's `Mod` is ⌘ on the iPad, as on a Mac. `window.clew.host` is
  `{touchFirst: true}`, frozen.
- **List keys** (list-keys-scenario.js). Every line matches the desktop's
  expected log:

  | step | result |
  | --- | --- |
  | Enter, Enter, text at the end of a hard-wrapped item | `["  something so strong?","","  Second paragraph."]`, drawn as the item's |
  | ⌘Enter | `["  Second paragraph.","* Next item"]` |
  | ⌘L, ⌘Enter on `- [ ] a task` | `- [x] a task`, then `- [ ] another task` |
  | ⌘Enter in a numbered list | `["1. first","2. inserted","3. second"]` |
  | ⌘Enter on prose | `["Prose line.","Below."]` |
  | Enter on an item's first line | `* First item.` / `  B2`, `3. second` / `   N2`, `- [ ] another task` / `  TC` |
  | ⌘L on a plain line | `- [ ] Below.` |
  | ⌘L on `- [1] Smith 2020` (0ada21d) | `- [ ] [1] Smith 2020` |
- **The toolbar's Next list item** (7eae0d0):
  - drawn, labelled "Next list item", in the Lists group: bullet,
    numbered, task, **next**, outdent, indent;
  - the Lists group is inline in portrait (the overflow holds "inline
    insert");
  - disabled on prose, enabled in a list;
  - a tap on `* Next item` gives `* Tapped` (drawn as an item);
  - on a task, `- [ ] Tapped task`;
  - 36×36 px, like every toolbar button.
- **`{{TOC}}`** (live-toc-scenario.js), with the cursor at the end of the
  note:

  | after | entries | levels |
  | --- | --- | --- |
  | initial | Title, Alpha, Beta | 0, 1, 1 |
  | renamed | Title, Gamma, Beta | 0, 1, 1 |
  | deeper | Title, Gamma, Beta | 0, 1, 2 |
  | added | …, Delta | 0, 1, 2, 1 |
  | shifted | the same | the same |

  goto-ok in every row. Clicking "Beta" puts the cursor on `### Beta`.
- **Title block** (live-title-scenario.js, plus a probe plugin for
  reading view's half). Sizes are a ratio to the note's text.

  | | live edit | reading view |
  | --- | --- | --- |
  | title | 1.8, weight 700, the heading colour, plain, no underline, 2 lines | 1.8, weight 700 |
  | author | 1.15 | 1.15 |
  | subtitle | 1 | 1 |
  | institution | 1 | 1 |
  | date | 1.15, "20 October 2026" (the engine's form) | 1.15, today 1.15 |

  The bare date line, `@author[…]` mid-sentence and `:title[…]` are not
  title lines. `@<title>` and `::title` are. A click on the title reveals
  `@title[Comments on “Agen…` with the line height unchanged.
- **Quotes in lists and grey quotes** (live-list-quote-scenario.js, plus
  the probe), px:

  | quote | live: border from item text | live: text from border | live colour / bar | reading: border, text |
  | --- | --- | --- | --- | --- |
  | bullet | 0 | 23 | muted / border | 0, 19 |
  | numbered | 0 | 23 | muted / border | 0, 19 |
  | nested | **2** | 23 | muted / border | 0, 19 |
  | top | 0 | 23 | muted / border | 0, 19 |

  Reading view's colours are rgb(154,154,154) and rgb(63,63,63), the
  values 1dc5c81 measured on the desktop. 0/23 in live and 0/19 in reading
  are the desktop's own figures (fa1a141). The text after the quote lines
  up with its item's (0). Revealing the quote shows its `>` and the line
  does not move.
- **Settings:** no "Style of LaTeX and PDF via LaTeX exports" row and no
  "Clew (EB Garamond)" anywhere in the open Settings.

## Found

- **For upstream (small):** a quote in a NESTED item stands 2 px right of
  its item's text in live edit, and at 0 in reading view. Bullet and
  numbered items are at 0. No iOS patch touches live edit. The desktop
  log doesn't show its own nested figure.
- **Pre-existing, for the record:** the seed vault's Guide/Export.md
  (upstream's demo vault, verbatim) describes the desktop's LaTeX exports
  and the style's Settings row, which the iPad hides. That will change
  when the iPad gets its LaTeX exports, so this port does not edit it.
- **Process:** the first attempt to send REAL keys drove the Simulator
  through System Events. Simulator.app did not come to the front, and
  the keys went to the frontmost app on the Mac. The owner was told.
  Real key tests here need an XCUITest, or the owner at the Mac with
  Simulator in front, never System Events.

## iPad checks (the owner, on TestFlight)

- **A hardware keyboard:** in a list item, Enter stays in the item,
  ⌘Enter starts the next one and ⌘L makes a task. This is CodeMirror's
  real iOS key path, which the synthetic keys above only partly take.
- **The on-screen keyboard:** Return stays in the item (a new paragraph
  in it). The toolbar's Next list item button (↵, between the task and
  outdent buttons) starts the next item.
- Edit a heading while `{{TOC}}` is on screen: its entry follows.
- A note with a title block, and a quote under a list item.
