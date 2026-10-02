# Handover — 2026-10-02 (the overnight sync to Clew-app 03bb33a: a pre-0.12.1 TestFlight build)

Current state for a fresh session, rewritten whole. Durable architecture
lives in **README.md** and **PORT-PLAN.md**. Each sync's reasoning and
measurements are in its record: `UPSTREAM-*-PLAN.md`. The latest records
are `UPSTREAM-03BB33A-PLAN.md` (the overnight sync of 2026-10-02),
`UPSTREAM-18C5E45-PLAN.md` (sync #3) and `UPSTREAM-0.12.0-PLAN.md`. The coordinator's ledger is `~/Source/Clew/SYNC-LEDGER.md`.

## 1. Where things stand

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
- **Tests:** `npm test` 706, `npm run test:swift` 154 + 23. Green, but
  they don't prove the app renders. This sync's worker hang was invisible
  to Node (§5).
- **Nothing is in progress.** Every sync chain is merged into main.

## 2. Waiting on the owner

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
   - the 24 px frame grip;
   - a hardware-keyboard Esc leaving an engaged canvas card;
   - backgrounding in the middle of an annotation.

## 3. Next

- **The next sync's range starts at Clew-app `03bb33a`.**
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
