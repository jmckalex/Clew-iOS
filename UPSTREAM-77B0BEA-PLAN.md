# Upstream sync to Clew-app 77b0bea — plan and record

**STATUS: EXECUTED 2026-10-04.** The owner's word ("Sync the iPad with the
sample apps too"), and then, relayed by Clew-boss: "Push it when it's all
green." Anything red or uncertain means no push, and a clear report
instead.

The chain, off main 0433870:
- `sync77b0bea-p1-vendor`: cc20873.
- `sync77b0bea-p2-build`: ce03e4e.
- `sync77b0bea-p3-contract`: fa1c2bf.
- `sync77b0bea-p4-verify`: this record, plus what p4 found.

**PIN: Clew-app `77b0bea`.** It was copied from `git archive 77b0bea`,
never the live tree, and `diff -rq` against the archive shows no
difference in any mirrored directory. The seed vault matches apart from
the excluded device state. The range 686232b..77b0bea has 28 commits.

**Version:** 0.12.0, unchanged. The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| The sample apps and the App Gallery (8173392) | They arrive with the seed vault: Ticker, Replicator, Picker, Timer, Progress and ReadingList, plus `Features/App Gallery.md` and the Reading/ notes. apps.js lists them from the vault. **The `clipboard` capability:** an app's copy now also goes to the system pasteboard over the bridge (`clipboardWrite` → UIPasteboard), so the picker's name pastes in any app. A paste still reads Clew's own last copy: app-calls.js answers synchronously, and reading the system pasteboard would show iOS's paste notice for something the user did not ask to paste. |
| Live edit runs apps (562bcb0, c892339) | Nothing: the le-frame block documents are served as before. |
| Pinning (190d6e5, shared/app-pin.js; the ticker pinned at the bottom, 79fc986) | Nothing: reading view moves the frame's holder and live edit moves the frame itself, both by style alone. On WebKit, which has no `moveBefore`, the frame never moves in the DOM, so it never reloads. |
| Prompts focus the card, not Allow (bfb5208) | Nothing: it arrives with the vendor. |
| Shareable callout types (17a06c5) | p2: `resolvedCallouts(g, v, hasCustomCallouts(g, v) ? await iconTable() : null)` replaces our re-implementation. |
| Admonitions WebKit-safe (f098976); `ad-x` headings (042a05d) | p2: the admonitions build patch is gone, because the module now takes the package import when no script sits beside the worker. An untitled fence is headed by its type. |
| device-name.js (8e0640c) | p2: the trust-banner build patch is gone. install-shim sets `window.__clewDeviceName` ('iPad', or 'iPhone') before the renderer loads. |
| Notices lifted clear of PDF viewers (038ec6f), demo text (fe4071d), engine re-vendors (1bb6c8e, 0b506dc) | They arrive with the vendor. |
| Deep links and the `clew` command (4ddda35) | Desktop only: DEEP_LINK_TAKE answers `[]`. |

**Found in p4 (pre-existing since M4, 2026-08-23):** the status bar padded
itself by the bottom safe-area inset, which the iOS toolbar below
`clew-app` already takes. The bar is 24px and border-box, so its text kept
3px and rose 6px over the pane above it. The editor clipped the text's top
in live edit with the sidebars closed, and the pinned ticker made it plain.
That padding is gone: the text now sits at 1123..1137 inside the bar's
1117..1141.

## Results (simulator, iPad Pro 11" M4, portrait; ALL GREEN)

The fixture is upstream's `smoke/make-app-gallery-vault.mjs`: its
`Tests/*.md` notes (Insert, Timer, Picker, Progress, Ticker, Reading) go
into a freshly seeded demo vault. One page script walks them (the
renderer's own stores; a real click on each prompt's Allow). A frame
script, the DEBUG-only `ClewFrameSmokeJS` injected into each app page as
desktop's CLEW_SMOKE_FRAME_SCRIPT, acts inside each app: a real click on
its buttons. It reports each load and each app's state through
`/__clew_probe__`.

- **Standard:** on a fresh install, Welcome rendered in 119 ms and a
  block in 118 ms. The `ad-tip` fence in Guide/Obsidian Compatibility
  rendered. An untitled `ad-hint` is headed "Hint".
- **A typed key does not answer a prompt:** with the Seminar Picker's
  prompt up, focus is on the card (not Allow). After Enter and Space the
  prompt is still up and unanswered.
- **Each app behind its prompt, then running:**
  - **Picker:** Spin picked "Ada", Copy name copied it, `clipboard.paste`
    gave "Ada", and the simulator's system pasteboard (`simctl pbpaste`)
    holds "Ada".
  - **Replicator,** in a live-edit note with the caret at the end: Insert
    result put "*Replicator dynamics — Stag Hunt.* … x = 0.75: unstable
    …" into the editor, and it was saved to disk.
  - **Timer** at 0.05 min: "- 2026-10-04: ran a 3-second exercise at
    19:07" was appended to the note on disk.
  - **Progress,** live edit: the app's count went from 5 words to 11 as
    six words were typed (a note-changed event), and they were saved.
  - **Ticker:** simulated mode, scrolling (the track's translateX moved
    in 1.2 s), Live off. A fetch to another (local) origin was blocked.
    Its one network grant reloads its frame once after Allow, by design
    (app-host.js: a `network` grant reaches a running frame only by a
    reload). Live was never switched on, so nothing left the machine.
  - **Reading List:** four Reading/ notes listed, and a click opened
    `Reading/Evolution and the Theory of Games.md`.
- **The App Gallery, reading view:** all six apps were live, and each
  frame loaded once. Across four scrolls (to the Replicator, the Timer,
  the end, back to the top) there were no reloads. The ticker stayed fully
  in view the whole time, including at the top, where its own place is
  far below the fold. The screenshots show it held at the bottom edge,
  then settled into its place at the end.
- **The App Gallery, live edit:** every frame loaded once, as it came
  into view. The ticker never reloaded across top, middle, end and back.
  At the top and in the middle, the ticker frame is `is-pinned` with its
  bottom on the pane's bottom (gap 0). At the end it is in its place
  (none pinned).
- **Trust on iPad** (device-name.js in place of the build patch): an
  undecided vault with code shows "Keep restricted" and "Trust on this
  iPad", and "none of it runs on this iPad".

**Tests:** npm test 761; Swift 154 + 44 + 18 + 9; xcodebuild OK.

**Gotcha, for the next smoke run:** `simctl uninstall` does not clear
cfprefsd's cache of the app's defaults. A ClewSmokeJS left from a
previous run comes back on the reinstall and runs in the seeding launch,
so delete the keys before uninstalling and again after installing.

## Not measured, or for the iPad itself

- Live ECB rates, the ticker's one network host: we never reach the real
  network. Another origin was refused.
- A real hardware keyboard on a prompt. The focus is on the card, and
  synthetic keys did nothing.
- WebRTC from an app frame (FRAME-BRIDGE-REVIEW.md).

## iPad checklist (after the push)

- Features/App Gallery: Allow each app. The ticker runs along the bottom
  and settles into its place at the end, in reading view and in Live edit.
- The Seminar Picker: Spin, Copy name, then paste into another app.
- The Replicator in Live edit: put the caret on an empty line, then Insert
  result.
- The Lecture Timer: a short run adds a line under Lecture log.
- Type into a note with Writing Progress; its count follows.
- The status bar's text (the word count, "can edit notes") sits fully
  inside the bar.
