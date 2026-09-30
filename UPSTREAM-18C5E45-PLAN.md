# Upstream sync #3 to Clew-app 18c5e45 — plan and record

**STATUS: EXECUTED 2026-09-30 — NOT PUSHED.** Chain:
- `sync3-p1-vendor` (8e5c0a9)
- `sync3-p2-build` (merges `1019a81` and `b97c007`, then ce03edd)
- `sync3-p3-contract` (63310d9)
- `sync3-p4-verify` (this record, plus the boot fix)

`main` is NOT fast-forwarded. The push is a TestFlight release and needs
the owner's decision, which Clew-boss relays. Clew-boss said: "Stop after
p4 and report; the push is the owner's decision." The sync was ordered by
Clew-boss, whose instructions on syncs are the owner's (the owner's
standing rule).

**PIN: Clew-app `18c5e45`** (local there). Clew-app was working on a
phase-4 branch in parallel, so the copy came from `git archive 18c5e45`,
extracted in the scratchpad, never from the live tree. Every mirrored
directory was compared byte-identical to that archive: `vendor/clew/*`,
the jmarkdown `src` and `package.json`, `embedpdf`, and `seed-vault`
(less the excluded `.clew` state). Clew-boss was told the moment the copy
was done.

Also merged into the chain:
- `fix-keyboard-layout` (2eeb902)
- `pdf-native-p1` (65d2708)
- `trust-native-p1` (0582d76)

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| PDF unification 1–3 (bf5d212, b9f21c6, ffb7290, 8bab972, 03c06f3) | The shared frame rewrite runs as each note, fragment and block document is served. Web PDFs are registered with native before the HTML leaves, in two passes (list, register, rewrite from the hashes). `blockSourcePath` was added. The native route now follows desktop's contract: a 64-hex hash or 404, `?reload=1`, a 502 whose JSON body `{error, message}` names the failure, and `X-Clew-Remote-Fetched` / `X-Clew-Remote-Error`. Native error codes now use the viewer's vocabulary. Registration accepts every http(s) URL; the fetch applies the policy. New bridge method `openRemotePdf`; `refreshRemotePdf` retired. New channels: PDF_THUMBNAIL, REMOTE_PDF_SAVE_COPY, REMOTE_PDF_OPEN. |
| Engine switch + func fix (88543bc, 18c5e45), trust guard (e8d32e6), refused-names (8d5f36b) | `Run note code` in the generated config. The render service carries desktop's setNoteCode, refusedNames and #noteRefusals. vaultOpen's `trusted` reaches it before the first standby. New channels: VAULT_TRUST_GET/SET, EV_NOTE_CODE_REFUSED, EV_VAULT_TRUST_CHANGED. |
| New files in the tree at once (5077207) | A NOTE_WRITE that creates the note, the kv store's first `clewdata.json` (`onCreated`), and a saved web-PDF copy all refresh the tree. Exports go to the share sheet on iOS, so they have nothing to refresh. |
| Watcher budget (b9e5416) | **Broke the boot**: `fs-utils.js` reads `process.env.CLEW_WATCH_BUDGET` at load, and the app page has no `process`. Fixed with a build-time `define` → `undefined` (so the budget is 0, desktop's default). A build tripwire now fails the build on any unguarded `process` read in the app bundle. |
| Shell panel (06f5e70) | The `@xterm/addon-unicode11` alias. The stub gains `Unicode11Addon` and `term.unicode`. |
| Tabbing guide (e4f416d) | The engine-worker test's line number (95 → 102). |
| Meta Bind lock and Enter (ac6e9cc, e80e583), frontmatter escapes, kanban gap, maps, 0.11.2 | Nothing: shared code that arrives with the vendor. |

Every guarded build patch still matches, and none retired.

Tests: 686 JS (5 new: trust, PDF frames, web-PDF actions, thumbnails,
new-file refresh). Swift: 153 + 23, including a parity check that every
native failure code is one the shared viewer names.

## Results (simulator, iPad Pro 11" M4, portrait)

The fixtures made no network access at all: the https PDF was served from
a pre-seeded device cache, and the other two addresses were refused
before any connection. A temporary preview plugin probed inside the
documents and reported through kv. Afterwards the app was uninstalled and
the simulator shut down.

- **Boot**: the first install booted to nothing (the `process` read
  above). After the fix, the demo vault opens and is trusted (`source:
  demo`).
- **Web PDFs** (`Sync3/Web PDFs.md`, four frames). Every frame is
  rewritten; none is left raw; the leak count is 0.
  - The cached `https://papers.example.org/paper.pdf#page=2`: read-only
    at page 2, with the strip "paper.pdf · papers.example.org ·
    read-only". No autosave. Save a copy is offered, and it wrote
    `Attachments/paper.pdf`, byte-identical to the cache (same md5); the
    explorer shows it.
  - `https://127.0.0.1/x.pdf`: "Clew does not fetch from local or private
    network addresses", with "loopback (127/8)" as the reason. No save
    offered.
  - `http://…/plain.pdf`: the generic head line, with the reason "http: —
    only https:// PDFs are fetched on iPad".
  - The vault PDF (`../Attachments/sample.pdf`): the full viewer, with
    Annotate.
  - Open with an unknown hash is refused by name.
- **PDF thumbnails**: Quick Look wrote
  `.clew/cache/pdf-thumbs/Attachments/sample.pdf.png`. A non-PDF is
  refused as upstream does.
- **Trust**, in a vault the device had never seen (created after the
  migration):
  - First open: untrusted. The render refused `jmarkdown script`, `Math`
    and `calc` by name, and none of them ran.
  - EV_NOTE_CODE_REFUSED fired, and the banner read "This vault's notes
    asked to run code (jmarkdown script, Math, calc)."
  - Trust this vault: the code ran (the script output, 1024 and 42), and
    the banner went away.
  - Revoke: refused again.
  - The device store now holds `documents:Stranger` as untrusted.
- **Meta Bind lock** (Guide/Widgets.md): under `pointer: coarse` the
  padlock is 44 × 44. The locked rating is `inert` (`aria-pressed=true`),
  and a click on the padlock unlocks it.
- **Tabbing** (Guide/Tabbing.md): 6 blocks, 6 laid out.
- **Kanban** at an 826 px portrait pane (sidebars closed):
  - The demo board (3 columns): board 794, no scrolling, hit-test true.
  - Desktop's Board4 fixture (4 columns): board 794, and it SCROLLS. See
    finding 1.
- **Keyboard layout**: at rest `scrollY` is 0, the tabs row is at 24–57,
  and the bottom bar is at 1141–1210 — the same as before the fix.
- **Shell**: no `shell:toggle` command, and no errors.

## Findings (upstream candidates; none blocks)

1. **Four kanban columns do not fit an 826 px iPad portrait pane.**
   005e41b's comment assumes "iOS's columns are border-box". Measured in
   WebKit, `.kanban-col` is `content-box` with 8 px padding and a 1 px
   border, so each column is 208 px, and 4 × 208 + 3 × 10 = 862 > 794. It
   scrolls, and every column stays reachable. Measured fix:
   `.kanban-col { box-sizing: border-box }` gives four 190 px columns and
   a 790 px board, with no scrolling and hit-test true.
2. **`fs-utils.js` reads `process.env` at module load** (b9e5416). That
   breaks any bundle without `process`. `typeof process !== 'undefined' &&`
   upstream would retire iOS's `define`.
3. **The viewer's failure texts are desktop's.**
   - `too-large` says "(100 MB)"; the iPad's cap is 50 MB (§8).
   - There is no entry for `insecure-url`, which §8 words as "insecure
     address — open in browser". The generic head line plus the reason
     shows today.

## The owner's iPad (p4 checklist)

1. **Keyboard**: with a hardware keyboard attached, focus a text field
   (the minimised keyboard bar appears). The toolbars stay in reach. Then
   repeat with the on-screen keyboard.
2. **Web PDFs and portal thumbnails**: a note with an https PDF frame
   opens read-only. Save a copy lands in Attachments; Open in browser goes
   to Safari; Reload works; offline shows the saved copy with its date.
   A canvas PDF portal shows the first page.
3. **Trust**: open a vault this iPad has never seen that holds note code.
   The code is refused by name and the banner appears. Trust this vault
   runs it. Revoke in Settings → This vault.
4. **Meta Bind padlock**: a finger tap unlocks it; the value can be
   edited; it relocks on commit.
5. **Enter** (software keyboard): Return in a text or number field commits
   once. A textArea keeps its newline and writes `"one\ntwo"` into the
   frontmatter. Later edits still save.
6. **Tabbing**: Guide/Tabbing.md lines up.
7. **Kanban at 826 px portrait**: finding 1 above. A four-column board
   scrolls; check that the finger pan is comfortable.
8. **Map measuring**: with a keyboard and trackpad (there is no touch
   route; see sync #2's finding).
