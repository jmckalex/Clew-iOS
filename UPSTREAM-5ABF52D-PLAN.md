# Upstream sync to Clew-app 5abf52d — plan and record

**STATUS: EXECUTED 2026-10-10.** The owner, relayed by Clew-boss: "Please
drive the iOS port through to completion. All the way to a push and a
TestFlight build." Commit locally; the push waits for Clew-boss's check and
the owner's word typed in this window.

The chain, off main 3947dd7:
- `sync5abf52d-p1-vendor`: bc75a13.
- `sync5abf52d-p2-build`: c20a067.
- `sync5abf52d-p3-contract`: a663069.
- `sync5abf52d-p4-verify`: this record, and the print tooltip's wording.

**PIN: Clew-app `5abf52d`.** It was copied from `git archive 5abf52d`.
`diff -rq` against the archive shows no difference in vendor/clew,
vendor/jmarkdown, vendor/embedpdf, vendor/default-stamps or seed-vault.
The range cbfa692..5abf52d has 14 commits. jmarkdown, EmbedPDF and
mp-tikz-wasm (v0.3.1) are unchanged.

**Version:** 0.12.0, unchanged. The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| An `@begin(equation)` shows its number once (3d39952) | Nothing: shared renderer. p2: our verbatim port of tests/preview-target.test.js follows upstream's. |
| A `:::` environment is the engine's generic container, unnumbered (d6c30cf) | p2: our verbatim port of tests/numbering.test.js follows upstream's. |
| **App secrets** (0cc8547, bd71168): `app.secrets`, the Ticker 1.2.0 | p3: **AppSecrets.swift** keeps them in the Keychain. See §Secrets. |
| **manifestNeed** (93912fa, e430bed) | p3: apps.js#manifestTouched returns `{key, reload}` from upstream's pure `manifestNeed`. ipc.js sends EV_APP_ASK (asked live, no reload) or EV_APP_GRANTS_CHANGED. |
| Book mode phase 2 (fdac07a…6fc68ac, 76dd382): the book map; book numbers in chips, completion, jump and hover; the reading-view line | Shared renderer, nothing to port except the line's button (below). |
| A chapter's citation pills in book order (886e2e5): the render body's `book` | p3: SchemeHandler's readRenderBody takes `book` (null, or at most 2,000 strings; otherwise 400). The shim resolves each path as it does sourcePath (403 on escape). render-service.js renders the block under `bookCitationHeader` instead of the note's own header. |
| **The whole-book print PDF** (5abf52d) | p3: **PORTED.** See §The book print. |
| Exports, the diagram cache, system fonts | Desktop only. |

## Secrets

- **Storage.** One generic-password item per secret:
  - service `org.jmckalex.clew.ios.app-secrets`;
  - account `<vault identity> U+001F <app id> U+001F <name>`, read from its
    end;
  - `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, never
    synchronizable.
- **Scope.** apps.js hands `callApp`, now async and awaited, a `ctx.secrets`
  scoped from the app behind the port: `app.vault` (the device identity) ×
  the manifest id. The bridge refuses a vault that is not the open one, and
  it answers the main frame only, so an app frame never reaches the
  Keychain directly.
- **Errors.** A get this device cannot answer is null. A set it cannot keep
  is `unavailable`. The bridge's words never reach the app, and a value is
  never in an error or a log.
- **Clearing.** Revoke clears that app's secrets (`appSecretsClearApp`),
  forgetting a trusted vault clears its apps' secrets (`clearVault`), and
  APPS_LIST carries `secrets: <count>`.
- **The first launch of an install sweeps the service** (a UserDefaults
  marker). It runs first on the serial I/O queue, because iOS keeps
  Keychain items across a delete.
- **Tests.** Swift AppSecrets has 36 checks over an in-memory backend: scope,
  the account read from its end, refused ids and names, clearApp,
  clearVault, the sweep, and no value in an error. The services tests run
  the Ticker against a fake Keychain: denied before its prompt, the
  shared limits (bad-params, too-large, too-many), the count, delete, a
  value never in the grants, kv or any vault file, and Revoke clearing it.

## The book print

The iPad's print path made it cheap:
- EXPORT_BOOK `print` reads the master (`readMaster`) and its chapters (the
  index's `book`).
- `renderBook` runs one engine build of the master with the engine's
  `chapters` and `numbering`.
- The result is served at the master's URL with `?book=1` (SchemeHandler →
  `__clewNative.bookDocument`).
- The note print's bridge (PrintPDF.swift, UIKit's print formatter, so
  print media applies) prints it into the share sheet as
  `<master> (reading view).pdf`.
- Upstream's BOOK_PRINT_CSS, verbatim, is adopted by the arm script as a
  constructed sheet.

PDF, LaTeX and HTML still refuse: "building a book needs Clew on a Mac".
Build patches:
- The Book panel offers **Print PDF** alone, and its tooltip says the PDF is
  shared rather than put in build/.
- The reading-view line's **Build** (HTML pages on desktop) becomes **Print
  PDF**: the print numbers each chapter as the book numbers it, which is
  what the line is about.

Upstream candidate: ask the host for its build formats.

## Results (simulator, iPad Pro 11" M4, portrait; ALL GREEN)

**Standard:** Welcome rendered in 92 ms and a block document in 137 ms.

**The equation number once:** in live edit, Math and Theorems' and
Conventions' numbered equations each carry one `data-le-tag` ("(1)",
"(2.1)") and no MathJax number of their own. Before this sync, on main
too, they showed "(1)(1)".

**Book mode phase 2:**
- In live edit Conventions (chapter 2) shows its equation as **(2.1)** and
  its theorem head as **Theorem 2.1**.
- An `@cref[eq-replicator]` added to Deception draws as **"equation
  (2.1)"** (`le-ref-ok`). A mousedown on it, as a tap delivers, opened
  Conventions with the caret on line 18, the equation.
- The reading-view line reads "Chapter 2 of Signals: A Short Book · numbers
  as in the book: **Print PDF**", and above the master "Master of …".

**Citations in book order:** with the master in vancouver before the page
loaded, Conventions' pills read **[1] [2]** (lewis1969, skyrms1996). The
chapter's own style gives "Lewis (1969)", "(Skyrms 1996)". A block render
with `book` gives "[1] … [2]" against the chapter's own author-date.

**The book print:**
- The Book panel shows Print PDF alone.
- EXPORT_BOOK `print` took 1.0 s to the share sheet.
- The PDF (A4) has 5 pages: the dedication; Senders and Receivers;
  Conventions; Deception and Honesty; the references. Each starts a page,
  numbered as the book is: (1.1), Proposition 1.1, (2.1), Theorem 2.1,
  (3.1).

**Secrets: the Ticker's key kept across a relaunch** (the point of all
this):
- Six prompts answered with Allow. The Ticker holds note.read, app.kv,
  **app.secrets** and network.
- Inside its frame, `clew.secrets.set('finnhub-key', …)` was kept, and
  Settings → Apps counts 1.
- **After a relaunch** the frame read the same value back, and the Ticker's
  own Key panel says "**A key is saved on this device.**" Nothing was asked
  again.
- **After a reinstall** the log says "app secrets: 1 left by an earlier
  install removed", and the Ticker finds no key.
- **Revoke:** the count went 1 → 0.

**manifestNeed live:** the Picker was running (one load) when its
clew-app.json gained `notes.read`. Its prompt came up at once ("It wants to
read the notes in this vault"). After Allow the running frame got
`grant-changed` with `notes.read` true. There was no reload: one load in
all.

**Tests:** npm test 770; Swift 154 + 44 + 18 + 9 + 47 + 36 (AppSecrets);
xcodebuild OK.

## Findings

1. **A chapter's pills do not follow a master style change made in the
   master's own editor.** It is a shared gap, not the iPad's: desktop had
   it too, and Clew-app fixed it in **c115418** (book-map.js#diskHeaders,
   cite-text.js waits for `context.ready`). It is not in this range, so it
   comes with the next sync. A note's OWN style edited in its editor has
   an older, similar staleness. Clew-app has raised it with Clew-boss.
2. The Book grip (11×18 px) and the chip's jump were driven by synthetic
   touch-type events. A real finger is for the iPad checklist.

## iPad checklist (after the push)

- **The Ticker's key:** Features/App Gallery → Allow (it now also asks to
  "keep secrets") → switch it to Live stocks → Key… → paste a Finnhub key.
  Quit Clew and reopen it: Key… says "A key is saved on this device", and
  Live stocks runs without asking.
- Settings → Apps: the Ticker shows its secret. Revoke, and it starts
  again with none.
- Books/Signals: a chapter's reading view has the "numbers as in the book:
  Print PDF" line. Print PDF puts the whole book, one chapter per page,
  into the share sheet.
- Live edit in a chapter: an equation shows (2.1) once. A cross-reference
  to another chapter's label shows its book number, and a tap jumps there.
- Drag a chapter in the Book panel by its grip with a finger.
