# iPad capture

FEATURE-IDEAS #9, built 2026-10-03 in two chained phases, so a release can
take the first without the second:

| Phase | Branch | Needs App Store Connect? |
|---|---|---|
| 1. Scan into a note; Home Screen quick actions | `ipad-capture` | No |
| 2. The share-sheet extension ("Save to Clew") | `share-extension` (on phase 1) | **Yes**: an App Group and a new bundle ID (below) |

## Phase 1: scan, and quick capture

- **Scan document into note…** is in the palette, and in the editor
  toolbar's Insert group (in its overflow menu when the pane is narrow).
  - VisionKit's document camera captures the pages, and they become one
    PDF in the attachment folder: a new file, never an overwrite.
  - Vision's text recognition draws each line into the PDF as invisible
    text, with ligatures off so "fi" stays two letters. Clew's PDF viewer
    can then search and select the scan's words.
  - `![[Scan YYYY-MM-DD HH.MM.SS.pdf]]` goes in at the caret, or at the
    end of a note in reading mode.
- **Scan text into note…** puts the recognised text itself at the caret,
  as Live Text does.
- With no note being edited, either command makes a new note
  `Scan YYYY-MM-DD HH.MM.md`.
- **Quick actions** (long-press the icon): Scan Document (into a new
  note), New Note, and Today's Diary Entry.
  - An app delegate stores the action.
  - The page takes it once its vault is open (`takeQuickAction`).
- **Info.plist:** `NSCameraUsageDescription` and
  `UIApplicationShortcutItems`.
- **Debug only:**
  - `ClewScanFixture` draws pages from text and sends them through the
    real OCR and PDF code.
  - `ClewQuickAction` acts as a cold-launch action.

**Verified in the simulator (iPad Pro 11" M4):**
- **Scan:** a 2-page fixture scan made a 2-page PDF, 612 pt wide.
  `pdftotext` gave back every word, and the viewer rendered the embed.
- **Scan text:** inserted the OCR text verbatim.
- **Quick actions:** each worked from a cold launch.
- **Real camera:** it presents in the simulator, with the purpose string
  in the permission prompt.

**Not tested:** the camera's capture itself; that needs a device.

## Phase 2: the share extension

- **What it accepts:** ClewShare (`org.jmckalex.clew.ios.share`) takes a
  web URL, text, up to 20 images or files, and up to 5 movies.
- **The UI:** "Save to Clew", with an optional comment.
- **Where items go:** the extension can't reach the vault, because the
  security-scoped bookmark belongs to the app. So it copies each item
  into the App Group `group.org.jmckalex.clew`, at `Inbox/<id>/`.
  `item.json` is written last; `ios/Shared/CaptureInbox.swift` is
  compiled into both targets.
- **Filing:** whenever Clew comes to the front, every sealed item goes to
  the end of `Inbox.md` as a `## Shared <date>` block: link, quote,
  comment, embeds. Its files go to the attachment folder, again as new
  files.
- **Removal:** the inbox item is removed only after the note's write has
  landed. An item that fails stays for next time.
- **Duplication:** a crash between filing and removal files that item
  twice. That costs a duplicate, never a loss.

**Verified:**
- 20 Swift tests on the inbox: names, sealing, order, and refusals of
  paths and forged ids.
- Node tests for the block and the shim.
- In the simulator:
  - The extension embeds and registers (`pluginkit` lists it).
  - Both targets carry the app group.
  - An item placed in the App Group was filed on a cold launch: link,
    quote, comment, a photo embed and a shared `.md`.
  - An unsealed item was left alone.
  - An item added while Clew was in the background was filed when Clew
    returned.

**Not tested:** the extension's own UI and its NSItemProvider loading.
The simulator's share sheet can't be driven without UI automation. It
needs one manual pass on a device: share a Safari page, a photo and a PDF.

## What the owner must do before phase 2 ships

Phase 1 needs nothing: it can ship as is. Phase 2 adds an App Group to
the app and a second bundle ID. Until both are registered, a device or
Xcode Cloud build of phase 2 fails at signing.

1. **Register the App Group.** At developer.apple.com, go to
   Certificates, Identifiers & Profiles, then Identifiers. Add an App
   Group `group.org.jmckalex.clew`.
2. **Enable it on the app.** Under Identifiers, open the App ID
   `org.jmckalex.clew.ios`, turn on App Groups, and select
   `group.org.jmckalex.clew`.
3. **Register the extension.** Add an App ID
   `org.jmckalex.clew.ios.share` (explicit), with App Groups on, using the
   same group.

   Shortcut: open the project in Xcode signed in as the developer
   account. For each of Clew and ClewShare, open Signing & Capabilities.
   Automatic signing registers steps 1–3 itself.
4. **Run Xcode Cloud** on the branch that carries phase 2. Its managed
   signing should then make profiles for both. If the first run fails at
   signing, re-run it after steps 1–3.
5. **Check the build number.** Both Info.plists carry `CFBundleVersion 1`
   in source, as the app's always has. If App Store Connect warns about
   a CFBundleVersion mismatch (ITMS-90473), switch both to
   `$(CURRENT_PROJECT_VERSION)`.
6. **On each version bump,** the extension's version must match the app's.
   Change `ios/ClewShare/Info.plist` and ClewShare's two
   `MARKETING_VERSION` lines along with the app's.
7. **Test on a device once:** share a Safari page, a photo and a PDF, then
   switch to Clew and check `Inbox.md`.
