# Upstream sync to Clew-app f3a7d5b (+ 686232b) — plan and record

**STATUS: EXECUTED 2026-10-03 (night).** The owner's word, relayed by
Clew-boss: "Yes, push if all green". Anything red or uncertain means no
push, and a clear morning report instead.

The chain, off main cedb81e:
- `syncf3a7d5b-p1-vendor`: b418435.
- `syncf3a7d5b-p2-build`: 7e6b3e3.
- `syncf3a7d5b-p3-contract`: 8766d28, 2474e9d, d276c4e, 5974f01.
- `syncf3a7d5b-p3d-pin686232b`: f1253d3, 88de233.
- `syncf3a7d5b-p4-verify`: this record, plus what p4 found.

**PIN: Clew-app `f3a7d5b`**, then **`686232b`**, Clew-boss's follow-up pin
(PDF save safety). Both were copied from `git archive`, never the live tree,
and are byte-identical to it in every mirrored directory: jmarkdown/src,
embedpdf, default-stamps (newly mirrored), renderer, shared,
preview-client, engine, main, excalidraw. The range 03bb33a..686232b has
35 commits.

**Version:** 0.12.0, unchanged (desktop's package.json is still 0.12.0).
The build number is Xcode Cloud's.

## What the range needed on iOS

| Upstream | iOS work |
|---|---|
| Tabbing is the engine's (4aeca69); engine re-vendors (21fe191, c62782b) | Its worker-registry entry and config lines are gone. The worker returns the build's warnings, and EV_RENDER_DONE carries them to the status bar's ⚠ (the LaTeX-export lint). |
| Vault trust v2 (6623303, frame-bridge.md §4) | **VaultTrust.swift is store version 2.** Per vault, on the device: decided, and the enablements (scripts, plugins, noteApi, dataviewJs, network). A vault's settings are only its request. Legacy entries fill once from their request, with the network on for a trusted vault. Then accessFor, setEnable, forgetKey and the one-time notice. **The session's access drives everything:** SchemeHandler injects vault scripts and plugins only as enabled; the preview CSP is a response header (notes: preview-csp.js's rules with the template's inline-script hashes from a render of an empty document, so the hash shim gains SHA-256/base64; vault HTML: script-src 'none' when restricted; the network directives unless a trusted vault has the network); the engine gets CLEW_VAULT_RESTRICTED and the new CLEW_DATAVIEW_JS. The shim answers VAULT_TRUST_GET/SET (a change reloads the page after the vault switcher's settle step), VAULT_ACCESS_GET/SET, VAULT_CODE_SUMMARY, TRUSTED_VAULTS_LIST/SET and PLUGINS_LIST's new shape. **The demo vault is trusted with its own request**, as desktop's main.js does (p3's boot check found it had no enablements). |
| Apps in notes (1f99cdd, ecb5ff6, c34d6c0; R1–R3) | **src/shim/apps.js.** It runs upstream's app-frames, app-grants, app-calls and app-embeds-rewrite over the mirror; app-registry is ported, because it imports Electron's paths. The key is hash(VaultTrust identity, manifest id). Embeds are resolved as notes and block documents are served. APP_STATUS, APP_ANSWER, APP_CALL, APPS_LIST and APP_REVOKE are answered. The grant FILE is the device's (Application Support). **Native:** the `clew-frame` scheme serves only what apps.js names, through VaultStore's realpath clamp, with the app CSP, no-referrer, no DNS prefetch and nosniff, and the bridge client injected. A restricted vault's app gets 403 until its prompt is answered. The navigation policy pins an app frame to its own host. |
| Conflict safety on the desktop (2f5d80d) | **The shared renderer UI replaces the iOS sheet.** The pool's guarded NOTE_WRITE answers {conflict, disk}, the device answering before the mirror moves. The native guard is opt-in, as desktop's. Keep theirs marks the version seen (VaultStore.markSeen). HISTORY_KEEP is history.js#keepVersion. iCloud's own conflicts go through the renderer's openConflictSheet. Our conflict-text.js copy is replaced by upstream's shared one. |
| PDF save safety (686232b, pdf-unification.md §7b) | **Native.** VaultStore.writePdf with base, force and create: refused when the disk's SHA-1 is neither `base` nor the bytes' (both versions into history first, answered {conflict, mine, theirs}); the disk hash is cached by mtime and size from a fresh stat. pdfVersionRestore. **The bytes travel as ONE binary POST** to clew-app://app/__clew_pdf_save__ (30 MB in 42 ms against 165 ms by base64). The caller token and session id ride in headers, never the URL. |
| Quote-and-cite (4921cc1, 5fa2a57, d358d18, a956fed) | PDF_META_GET/SET are pdf-meta.js over the mirror, and the record follows a renamed PDF. The pdf-current-page message needs nothing: message-guard's topOrigin is the document's own where ancestorOrigins is empty (the print view). |
| Stamps (88b6dd2) | vendor/default-stamps is mirrored, staged and served at __clew_assets__/stamps. |
| The update check (036befe) | UPDATE_CHECK answers 'off'; the Settings section is dropped (the App Store updates the iPad). |
| Site export privacy (86ec1bc) | Nothing: iOS has no site export. |
| The app page's origin, postMessage targets (e8c4738, fb32347), symlinks (888bf25) | Already iOS's (clew-app://app; the universal realpath clamp). |
| Figure pane, error marks, Edit source, the quiet navigator, PDF links beside the note, the frame height | These arrive with the vendor. iOS gives the Edit-source icon a 44 pt hit area (drawn at 26 px; upstream already shows it faintly on touch). |

**Fixed along the way:**
- history.js#keepVersion now writes a Buffer, which the mirror's onWrite
  never persisted: bytes written to a text file are now text.
- The fs shim's writeFileSync wrapped a view's whole ArrayBuffer.
- p1's commit had carried the worktree's node_modules SYMLINK: .gitignore's
  `node_modules/` doesn't match a link, and checking the branch out then
  replaced the real directory. The rule is now `node_modules`.

## Results (simulator, iPad Pro 11" M4, portrait; ALL GREEN)

The fixtures are upstream's own makers (make-pdf-conflict-vault,
make-printed-vault over LaTeX PDFs from make-page-number-pdfs.sh,
make-figure-error-vault, make-trust-vault), plus a probe global plugin, a
probe app and the demo vault. One script walks them across vault
switches. What happens inside a preview or an app frame is reported
through a DEBUG-only `/__clew_probe__` path, which lands in the device
log; it is the one channel every CSP here allows ('self').

- **Standard:** on a fresh install, the demo vault (trusted, its three
  plugins and the Note API) rendered a note in 93 ms and a block in
  141 ms.
- **An app in the demo vault:**
  - the prompt "Allow “Flashcards”?" came up inside the visual viewport,
    with every target 44 pt;
  - after Allow, Flashcards runs: it read its note's cards (`notes.read`,
    `kv.get` through the port) and showed "What does an app run on?";
  - **no network:** a capability-free probe app's fetch and image to
    another local origin were refused (`connect-src`, `img-src`
    violations), and its bridge client was there.
- **PDF save safety** (another writer, an annotation, the autosave),
  each refused with the sheet up, disk=theirs and history=2:
  - **both:** disk=theirs, the copy "Paper (conflict 2026-10-03).pdf" =
    mine, side by side;
  - **mine:** disk=mine, and a later save works with no second conflict;
  - **theirs:** disk=theirs, and a later save works with no second
    conflict.
- **Quote-and-cite, printed pages:** `article-letter.pdf` (LaTeX, numbered
  from 57) gave `\cite[p. 57]{p1} · [[article-letter.pdf#page=1|PDF p. 1]]`
  and p. 58 for PDF page 2. The notices say "Quoted p. 57 (PDF p. 1)".
- **Figure pane:** a typo'd TikZ fence in source and live mode, the figure
  at 0.35, 0.62 and 0.85 of the window, the caret walked into the typo
  line.
  - Covered px: **0 in all six runs**.
  - At 0.35 the pane shows, with `pointer-events: none`; lower down there
    is no room in portrait and it stays hidden rather than cover the
    lines.
  - The error mark is on the typo's line every time.
  - (A simctl-launched page has no focus: `document.hasFocus` is stubbed,
    and the caret moves as user selections.)
- **Edit source:** three icons on Diagrams' blocks in live edit, faint
  (opacity 0.6) and clickable, drawn 26 px with a 44 pt hit area (iOS).
- **Trust**, over make-trust-vault: 1 script, 1 plugin, 2 notes with
  scripts, asking for the Note API, dataviewjs and the network.
  - **Prompt:** inside the visual viewport, targets 44 pt; on iPad it
    says "this iPad" (fixed in p4: iPadOS's WebKit reports MacIntel).
  - **Keep restricted:** decided, with the indicator. The note CSP is
    script-src limited to Clew's sources plus the template hash. The probe
    in Scripts.md: the inline script and the onclick handler were blocked
    (`script-src-elem`, `script-src-attr`); the vault script and the vault
    plugin did not run; the outbound fetch was blocked; the user's own
    global plugin did run.
  - **Trusted** (after the reload): the inline script, the handler, the
    vault script and the vault plugin all ran. The network stayed closed
    (not granted).
- **The binary PDF save:** 30 MB in 42 ms (base64 through the bridge:
  165 ms). The token rides in a header; a wrong token gets 403 before any
  write, and a non-PDF path 400.
  - **Measured:** WebKit puts NO Origin on a same-origin POST to a custom
    scheme, only `Referer: clew-app://app/index.html`. So an Origin, when
    present, must be the app page's, and without one the Referer must be.
    (A cross-origin POST always has an Origin, `null` at worst.)
- **Guarded saves:** ten editor saves spaced past the autosave, all
  guarded: none refused, no conflict.

**Tests:** npm test 737; Swift 154 + 44 + 18 + 9; xcodebuild OK.

## Not measured, or for the iPad itself

- Real iCloud conflict versions; a real camera scan; anything needing a
  second device.
- WebRTC from an app frame: no public WKWebView switch
  (FRAME-BRIDGE-REVIEW.md).
- An app's `clipboard` capability is Clew's own on iOS: app-calls.js
  answers synchronously, which the system pasteboard over the bridge
  cannot.
- "Every vault on this Mac" in Settings → Callouts is still upstream's
  wording (an upstream candidate).

## iPad checklist (after the push)

- A new vault with code: the trust prompt (Keep restricted, then Trust on
  this iPad), its notes' scripts off and then on.
- Flashcards in Guide/Apps in Notes: Allow, flip a card; Settings → This
  vault → Apps lists it; Revoke asks again.
- A PDF annotated on the Mac and the iPad at once: the sheet, Keep both.
- Quote-and-cite from a real article, and "PDF: set the printed page
  number…".
- A broken TikZ fence: the error mark, and the pane never over the lines.
