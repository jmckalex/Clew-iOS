# Upstream sync to Clew-app cbfa692 — plan and record

**STATUS: EXECUTED 2026-10-06.** The owner, relayed by Clew-boss: "Push
and sync the iOS build tonight, for sure." Commit locally; the push waits
for Clew-boss's check and the owner's word.

The chain, off main 210008f:
- `synccbfa692-p1-vendor`: 8a10a7d.
- `synccbfa692-p2-build`: fda2f65.
- `synccbfa692-p3-contract`: dc9a733.
- `synccbfa692-p3b-demo-sync`: edddf3b. Approved by Clew-boss as its own
  branch, so it can be dropped (p4 would then rebuild on dc9a733).
- `synccbfa692-p4-verify`: this record.

**PIN: Clew-app `cbfa692`.** It was copied from `git archive cbfa692`,
never the live tree. `diff -rq` against the archive shows no difference in
vendor/clew, vendor/jmarkdown, vendor/embedpdf, vendor/default-stamps or
seed-vault. The range 77b0bea..cbfa692 has 42 commits.

**mp-tikz-wasm: v0.3.1** (sha256 24b0cd29…). Staged with
`MPTIKZ_SRC=…/Clew-app/mptikz-assets node scripts/stage-mptikz.js --force`
from Clew-app's verified release tree, never the owner's master build. The
app bundle carries the four new latex-extra files (epstopdf.sty,
epstopdf-base.sty, grfext.sty, supp-pdf.mkii). CI takes the release from
the vendored manifest.

**Version:** 0.12.0, unchanged. The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| Book mode in the engine (jmarkdown 0372f23 → dc36e9b): book.js imports `isDeepStrictEqual` from Node's `util` | p2: a worker shim, `src/worker/shims/util.js` (isDeepStrictEqual, promisify), with `util` and `node:util` in builtinAlias. tests/util-shim.test.js checks it against Node's own on configuration-shaped values: primitives, NaN and -0, arrays, nested objects, prototypes, Date, RegExp, Map, Set, cycles. |
| Books in Clew (4bc9c04, 8a7f173, 2c6a6a8, …): the Book panel, "Ch. 2 of Book", next/previous chapter, the index's `book` entry (CACHE_VERSION 5) | Nothing: they arrive with the vendor and run as they are. |
| Book Build (eeb7371, 1f960e0, …): TeX, latexmk and the engine in a Node fork | p3: EXPORT_BOOK refuses with "building a book needs Clew on a Mac". The panel's notice reads "Signals: A Short Book was not built: building a book needs Clew on a Mac", and its "Last build failed" line says the same. |
| App network grants bound to their origins (917303b, a security fix) | p3: src/shim/apps.js follows desktop's APP_STATUS/APP_ANSWER and app-registry.js. The CSP comes from grantState's `network`, never the manifest alone. Status answers networkNow and askNetwork, and the prompt names only the hosts it asks for. Allow records networkOrigins (mergeOrigins), and a widening Don't allow declines only the new hosts. The manifest is re-read when its file's mtime changes. An edited clew-app.json whose frames no longer match the grant sends EV_APP_GRANTS_CHANGED, so they reload (desktop session.js). |
| EV_NOTICE (main → window) | p3b sends it for the demo vault's update. Nothing else sends it here. |
| The demo vault updated in an existing copy (2619e1c, 5a99c9e, 15163db; desktop only) | p3b: **DemoSync.swift** ports main/demo-sync.js rule for rule, with DemoHistory.json (Clew-app's demo-history.json) copied into the bundle by the staging phase. See §p3b. |
| The live Finnhub ticker (7bbfdb1): the key in the app frame's own localStorage | Nothing to port. Measured: app-frame localStorage does **not** survive a relaunch on iOS (§Findings). |
| Live edit: a list item's text past its first line (ffad0e5) | Nothing: it arrives with the vendor. Measured below. |
| Export fixes, the engine's Obsidian links on in exports (be46044, 16f4b7c, 6ab62ae, cc12894, …) | Desktop only. iOS's HTML export is reading mode's document, so `[[links]]` print as written, as before. |
| note-edit.js moved out of app-host (3fe8aa1); the smoke harness's drag input | Nothing. |

No build-patch anchor moved, and none was added or retired.

## p3b: the demo vault on the iPad

The first launch copies SeedVault to Documents/Demo Vault, and nothing
touched that copy again. So an iPad that opened the demo once never got the
App Gallery (77b0bea) or the Signals book (cbfa692). Each opening of THE
demo vault now:
- adds the bundled files the copy was never given;
- updates a file still exactly as Clew gave it, by the record's hash or a
  version in the history;
- never touches an edited file, never brings back a deleted one, and never
  writes a dot path. A record-less copy (every existing iPad copy) is dated
  by its own untouched files, as 15163db does;
- writes `.clew/demo-files.json` in desktop's shape.

"THE demo vault" means Documents/Demo Vault by real path. A vault elsewhere
that shares the name is never touched. The iPad adds one rule: a copy with
no record and nothing recognisable from the demo is left alone entirely,
because anyone can make a "Demo Vault" folder in the Files app. Desktop
gives such a copy everything it lacks. Writes go through VaultPaths.check,
never through a link out. The notice is upstream's `demoSyncNotice`, sent
1.5 s after the open, as desktop's main.js does.

Swift DemoSync has 47 checks:
- Desktop's cases (tests/demo-sync.test.js at cbfa692), ported one for one:
  - a record of hashes;
  - a record-less dev.6 copy;
  - 2619e1c's list record;
  - the dating rule;
  - nothing recognisable (at the plan level);
  - the real history (a dev.6 copy with a deletion);
  - the on-disk sequence: a second opening quiet and the record untouched,
    a deletion with a record sticking, a newer bundle.
- The iPad's own:
  - a non-demo folder untouched;
  - an empty folder untouched;
  - a folder link and a file link refused;
  - the record's exact text.

## Results (simulator, iPad Pro 11" M4, portrait; ALL GREEN)

**The demo vault's update** (fresh installs of this build, with an OLD copy
planted in Documents/Demo Vault before the first launch):
- **The 77b0bea seed** (main 210008f's), with Welcome.md edited and
  Reading/Evolutionary Game Theory.md deleted:
  - Added: Apps/Ticker/live.js, Books/Signals/{Signals, Senders and
    Receivers, Conventions, Deception}.md and Guide/Books.md.
  - Updated: Apps/Ticker/{app.js, clew-app.json, index.html} and
    Features/App Gallery.md.
  - The edit was kept, the deleted note stayed deleted (recorded `null`),
    and only `.clew/demo-files.json` was written under `.clew`.
  - One notice: "The demo vault is up to date with this version of Clew:
    added Books/Signals/Conventions, Books/Signals/Deception,
    Books/Signals/Senders and Receivers, and 3 more files; updated
    Features/App Gallery, Apps/Ticker. Notes you changed were left as they
    are."
  - A second launch: no notice, no file changed, the record's mtime
    unchanged.
- **The e4ce7cb seed** (2026-10-02, before the sample apps), with Welcome.md
  edited and Features/Maps.md deleted:
  - 33 files added, among them all seven apps, the App Gallery, the
    Reading/ notes and the Signals book; 2 updated.
  - Maps stayed deleted, the edit was kept, and one notice was shown
    (screenshot).
- **A vault named "Demo Vault" elsewhere** (Documents/Elsewhere/Demo
  Vault, the 77b0bea seed), opened by a switch: `demoSync` null, no
  notice, no file added or changed, no record.

**Standard:** on a fresh install, Welcome rendered in 104 ms and a block
document in 132 ms.

**Books:**
- The index has the master (`masters()` = Signals.md), and a chapter's
  `booksOf` names it.
- The status bar reads "Ch. 1 of Signals: A Short Book", and "Ch. 2 …"
  after `book:next-chapter`, which opened Conventions.md;
  `book:previous-chapter` came back.
- The Book panel lists the three chapters with words and status, the
  totals, and Build: PDF / LaTeX / HTML. Build PDF gave "Building Signals:
  A Short Book as PDF…" and then the refusal, and the panel shows "Last
  build failed: building a book needs Clew on a Mac".
- **The grip, by a touch pointer:** a `pointerType: 'touch'` press, move
  and release dragged row 1 below row 3, and the master's `chapters:` was
  rewritten on disk (Conventions, Deception, Senders and Receivers).
  Synthetic pointers cannot be captured, so setPointerCapture was stubbed
  on that grip alone. Then **Alt+↑** twice on the moved row restored the
  order, on disk too. The grip is `touch-action: none` and **11×18 px**: a
  small target for a finger (iPad checklist).

**Apps, origin-bound grants (the Stock Ticker):**
- Before its prompt: status asks note.read, app.kv and network.
  `askNetwork` is finnhub.io and api.frankfurter.dev, `networkNow` is
  null, and the prompt says "send data to finnhub.io, api.frankfurter.dev".
- The prompts came one at a time (Replicator, Picker, Progress, Reading
  List, Timer, Ticker), and each was answered by a real click on Allow.
  Afterwards the Ticker asks nothing, `networkNow` is both hosts, and
  `granted` includes network.
- Its frame reloaded once after the answer (networkNow changed), by
  design.
- **Asked once:** a direct APP_ANSWER on a later launch, and the services
  test, show the record holding networkOrigins with nothing more to ask.
  The services test also covers a manifest's new host: the frames reload,
  only that host is asked for, and Don't allow declines it alone while
  the old hosts keep working.

**Live edit lists** (upstream's smoke/live-list-paragraphs-scenario.js,
its measuring half, run on upstream's Lists.md; the caret put on each line
by dispatch):
- Every continuation line has `color=same`, and the maths and the fence
  still draw.
- dx is 0 for the two-spaces, backslash, lazy, paragraph-2, paragraph-3,
  numbered, quoted and after-maths lines. Nested is 2 (desktop 2) and
  task is **4** (desktop 1).
- Every line is height-stable with the caret in it, and the quoted line's
  `>` reveals (dx 15, as on desktop).
- Before ffad0e5 these lines started at the margin, so this is the fix
  arriving. The task line's 4 px is WebKit's checkbox; it is listed as a
  finding, not a blocker.

**Figures on v0.3.1:** in Features/Diagrams.md, all 11 figures are
`mpw-ok`, 0 errors and 0 pending, 5.6 s after the document loaded. This was
measured by a temporary preview plugin, switched on through
VAULT_ACCESS_SET and removed with the uninstall.

**Tests:** npm test 765; Swift 154 + 44 + 18 + 9 + 47 (DemoSync); the build
and xcodebuild succeed.

## Findings

1. **App-frame localStorage does not survive a relaunch** (Clew-app asked
   for this measurement). A marker each app frame set was present after
   its frame's reload within a launch, and gone at the next launch, in
   every frame. On disk only the app page's own origin has a LocalStorage
   directory. WebKit keeps third-party (cross-origin, nested) frame
   storage in memory. So on the iPad the Ticker's Finnhub key is asked for
   once per launch. This is an upstream/design question (a device-local
   store for an app's secrets), not tonight's work.
2. **A numbered equation's number is drawn twice in live edit, on main
   too:** "(1)(1)", overlapping at the right of Math and Theorems' Euler
   equation and of the Conventions chapter's. A build of main (210008f)
   shows the identical overlap, so it predates this sync. Not yet
   reported upstream.
3. The task line's continuation in live edit sits 4 px right of the item's
   text (desktop 1 px): WebKit's checkbox width.

## Not measured, or for the iPad itself

- A real finger on the Book grip (11×18 px).
- Live stocks and ECB rates from the network: never reached, by rule.
- The Finnhub key across a real relaunch on the device (expected: asked
  again; Finding 1).

## iPad checklist (after the push)

- The demo vault: the notice once, then the Signals book under Books/, and
  your own edits to demo notes still there.
- Books/Signals/Signals.md: the Book panel (right sidebar, "Book"); drag a
  chapter by its grip with a finger; Alt+↑/↓ with a keyboard.
- A chapter: "Ch. N of Signals" in the status bar; the palette's "Book:
  next chapter".
- Build: the refusal notice, no crash.
- Features/App Gallery: the Ticker asks once (finnhub.io and
  api.frankfurter.dev) and not again after a relaunch.
- Features/Diagrams: the figures.
- A list item with a second line in Live edit: it hangs under the item.
