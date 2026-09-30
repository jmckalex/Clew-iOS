# Upstream sync to Clew-app 9268aa3 (0.12.0) — plan and record

**STATUS: EXECUTED 2026-09-30 — NOT PUSHED.** This is the follow-up to
sync #3 (`UPSTREAM-18C5E45-PLAN.md`), for the 0.12.0 release; the owner
decided to release now and defer the code review. The chain stacks on
`sync3-p4-verify`:
- `sync012-p1-vendor` (f3a002e)
- `sync012-p2-build` (8e967bb)
- `sync012-p3-version` (1827ea7)
- `sync012-p4-verify` (this record)

`main` is NOT fast-forwarded. The TestFlight push waits for the owner's
explicit OK, relayed by Clew-boss. The build commit must not carry the
skip marker.

**PIN: Clew-app `9268aa3`** (0.12.0). Copied from `git archive 9268aa3`,
never the live tree. Every mirrored directory is byte-identical to that
archive. Clew-boss was told the moment the copy was done.

## What the range (18c5e45..9268aa3) needed on iOS

| Upstream | iOS work |
|---|---|
| b5325cc: the `![[x.pdf]]` placeholder carries `data-src` | None. wikilinks.js and pdf-embed.js arrive together from one pin, and no iOS patch or test touches either. |
| 29fa2ae: the document redirect (desktop protocol.js only) | None. iOS keeps §8's `decidePolicyFor` leak check. A SchemeHandler twin, keyed on Accept, stays optional. |
| 2588285: kanban columns are border-box | None. Confirmed at 826 px (below). |
| 5306e93: fs-utils reads `globalThis.process?.env` | buildAppBundle's `CLEW_WATCH_BUDGET` define is RETIRED. The tripwire stays, and passes the new read. |
| db50f57: remote-failures.js, the failure texts | The too-large detail now says the cap: "larger than the 50 MB a web PDF may be". `insecure-url` is exact. The parity test now covers every code, `insecure-url` included. |
| 9268aa3: 0.12.0 | **The iPad's version is now 0.12.0** (Info.plist and both `MARKETING_VERSION` lines; it had been 0.1.0 since M3). The owner's decision: from now on it follows each Clew-app release. Build numbers stay Xcode Cloud's. |

Tests: 686 JS; Swift 154 + 23.

## Results (simulator, iPad Pro 11" M4, portrait)

No network was used. It was a fresh install of the 0.12.0 build (the
built bundle reports `CFBundleShortVersionString` 0.12.0).

- **Boot**: the demo vault opens and is trusted.
- **Web PDFs**, as in sync #3:
  - read-only at `#page=2`, with the strip and no autosave;
  - Save a copy wrote `Attachments/paper.pdf`;
  - 127.0.0.1 refused by name.
  - **http now shows the shared headline** "Clew fetches web PDFs only
    from secure (https) addresses — open it in your browser", with the
    iPad's reason under it.
  - The vault PDF opens in the full viewer; no raw frames; leak count 0.
- **`![[sample.pdf]]`**: the `data-src` placeholder is upgraded (none
  left), no raw PDF `src` ever reaches the document, and the embed shows
  the full viewer (screenshot).
- **Kanban**: Board4 at an 826 px portrait pane is **790 px, four 190 px
  columns, no scrolling**, hit-test true. That is sync #3's finding 1,
  fixed upstream.
- **Trust**: an unknown vault refuses `jmarkdown script`, `Math` and
  `calc` by name, with the banner. Trust runs the code; revoke refuses it
  again.
- **Other checks**:
  - PDF thumbnails from Quick Look;
  - the padlock is 44 × 44 under a coarse pointer and inert until tapped;
  - tabbing 6/6;
  - the keyboard layout at rest is unchanged;
  - there is no shell command.

## The owner's iPad (p4 checklist)

It is sync #3's list (`UPSTREAM-18C5E45-PLAN.md`, "The owner's iPad"),
plus: Settings → About, or TestFlight, shows **0.12.0**; and a note with
`![[x.pdf]]` shows the viewer without a flash of a static page first.
