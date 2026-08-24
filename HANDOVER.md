# Handover — 2026-08-24 (port → TestFlight → PDF/canvas polish)

Session-rollover state, upstream-style: rewritten each session, kept short.
Durable architecture and build docs live in **README.md** and
**PORT-PLAN.md** (milestones + WebKit findings) — trust those first.

## 0. THE ONE RULE

**Never `git push` without the owner's explicit OK.** The Xcode Cloud
workflow builds and ships to TestFlight on every push to `main` — a push
IS a release. Commit locally freely; the owner verifies on their iPad
first. (Learned 2026-08-24; also in Claude's memory.)

## 1. Where things stand

- **Live on TestFlight (internal)** as **"Clew Notes"** (ASC app record;
  bundle `org.jmckalex.clew.ios`; internal group has automatic build
  distribution; owner installed via the TestFlight app). External
  testing / public link NOT yet set up (needs first Beta App Review;
  App Privacy answer is "Data Not Collected").
- **Release pipeline**: push to `main` at github.com/jmckalex/Clew-iOS →
  Xcode Cloud workflow "Default" (Environment: Latest Release Xcode) →
  `ios/ci_scripts/ci_post_clone.sh` (brew node, npm ci, npm run build) →
  Archive (Distribution Preparation: App Store) → TestFlight, build
  numbers auto-assigned, superseded builds auto-expired.
- **Local Xcode 16.4 can NOT upload** (Apple's annual SDK gate wants the
  iOS 26 SDK / Xcode 26, which needs a newer macOS than the owner runs).
  Local Xcode is for device debugging only; the cloud does releases.
  `DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer` for CLI.
- **Repo state**: clean tree; **2 commits ahead of origin/main,
  deliberately unpushed** pending the owner's device check:
  `3de9636` (inline PDF.js viewer) + `789c216` (Annotate button).
  Owner has verified the inline viewer on the iPad ("that works").

## 2. Shipped recently (newest first)

- **Inline PDF viewer**: PDF.js (legacy build — modern build needs
  Iterator helpers this WebKit lacks) replaces `<embed>` in previews;
  bytes fetched by the client and passed as `{data}` (pdf.js rejects
  custom-scheme URLs); lazy per-page render with off-screen release for
  book-length PDFs; ✎ **Annotate** button + double-tap → QuickLook.
- **QuickLook for PDFs** (`quickLook` bridge → QLPreviewController,
  editingMode .updateContents): Pencil markup saves into the vault file.
- **Canvas media tap-to-engage**: single touch tap on a node holding
  video/audio/iframe/embed engages it (content was inert until desktop's
  double-click), so play controls become tappable.
- Earlier this arc: Pencil-aware canvas input (fingers pan / palms can't
  select while inking), touch-drag scrolling fixes, external-folder
  vaults (picker + bookmarks + iCloud placeholders + coordinated
  writes), note API / KV / plugins enabled on iOS (seed `.clew`; preview
  + app plugin surfaces in Swift), app icon, upstream sync workflow with
  fail-loud patch guards.

## 3. Open items

1. **PDF.js full annotation editor** (inline highlight/ink/note +
   save-to-vault via PDFViewer component): designed, offered, **decision
   deferred** — owner is trying inline-read + QuickLook-annotate first.
2. Kanban card drag on touch (HTML5 DnD dead); write path itself proven.
3. Touch file move: drag-to-move is pointer-only; add "Move to folder…"
   to the long-press menu.
4. Empty folders don't appear in the explorer (mirror is file-derived).
5. Sync Phase 2: iCloud conflict versions (NSFileVersion) surfacing;
   canvas-ink merge strategy (id-keyed union is tractable).
6. Engine-surface vault plugins (needs runtime bundling); TikZ cache
   reuse fails when desktop hashed a machine-local LaTeX preamble.
7. Recents list accumulates stale container paths across dev reinstalls
   (harmless on device; prune-on-display would be nice).
8. Upstream candidates documented in PORT-PLAN (sidebar restore
   re-apply bug, extension-registry hook, coarse-pointer autofocus,
   moved-iframe postMessage quirk).

## 4. Verification kit (works, use it)

- `npm test` — 19 green (engine render battery + services).
- Simulator smoke: `xcrun simctl launch <sim> org.jmckalex.clew.ios
  -ClewSmokeJS '<js>'` (runs in app page ~2s after load; `window.__clew`
  = stores/registry/ipc, `window.__clewNative` = render/diff/flush);
  logs via `log show --predicate 'eventMessage CONTAINS "CLEWJS"'`;
  screenshots via `simctl io <sim> screenshot`. iPad sim
  90DCB612-1B85-4E1A-A17A-DBEB98F6C36D, iPhone A97A2ED5….
- `node tools/render-note.mjs <vault> <note>` — engine render under Node.
- **Gotchas that cost hours** (details in PORT-PLAN/memory): smoke
  `message` listeners never fire from callAsyncJavaScript closures;
  simulator state persists across reinstalls (uninstall for clean runs);
  test with a freshly built+installed app (a failed xcodebuild leaves
  the previous build installed — check for `** BUILD SUCCEEDED`).
- **Upstream propagation**: `npm run sync-upstream && npm run build &&
  npm test`; build fails loudly if a vendored patch no longer matches
  (fix in scripts/build.js); check `shared/channels.js` +
  `main/render-service.js` diffs for new shim/engine-config work; npm
  deps do NOT auto-merge from jmarkdown/Clew-app package.json.
