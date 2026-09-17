# Clew for iOS

The iOS/iPadOS port of [Clew](../Clew-app) — an open-source, Obsidian-style
note app built on the **jmarkdown** engine. GPL-3.0-or-later.

The entire desktop renderer (web components + CodeMirror 6) runs unmodified
in a WKWebView; the jmarkdown engine runs in a Web Worker over an in-memory
filesystem; Swift provides what Electron's main process provided natively.
See `PORT-PLAN.md` for the architecture, what could not be ported (the
LaTeX export and Mathematica shell-outs), and the milestone log.

## Building

Prerequisites: Node 20+, Xcode 16+ (iOS 17 SDK). Everything else is in the
repo — `vendor/` and `seed-vault/` are committed mirrors, so `../Clew-app`
is only needed when re-syncing from upstream.

```sh
npm install                 # legacy-peer-deps is set in .npmrc
npm run sync-upstream       # refresh vendor/ + seed-vault from ../Clew-app (optional)
npm run sync-mptikz         # stage the wasm TeX engines (74 MB, gitignored) — figures need them
npm run build               # engine worker, app bundle, preview clients, webroot
npm test                    # engine renders + services suites (node --test)
open ios/Clew.xcodeproj     # build & run the Clew target (iOS 17+)
```

The Xcode target stages `dist/webroot` and `seed-vault/` into the app
bundle in a run-script phase — run `npm run build` before building the app.

Simulator smoke (mirrors desktop's CLEW_SMOKE):

```sh
xcrun simctl launch booted org.jmckalex.clew.ios -ClewSmokeJS '<js run in the app page>'
xcrun simctl spawn booted log stream --predicate 'eventMessage CONTAINS "CLEWJS"'
```

## Layout

- `vendor/` — committed mirrors of upstream (`../Clew-app` src + its
  vendored jmarkdown, and the owner's EmbedPDF build). Never edited by
  hand; `npm run sync-upstream` overwrites wholesale. Behavior changes
  are build-time patches in `scripts/build.js`, each an upstream
  candidate. Pure fs+path modules from upstream's main process (indexer,
  search, kv-store, rename-links, plugins, history) run verbatim over
  the vault mirror.
- `src/worker/` — the engine Web Worker entry + Node-builtin shims
  (in-memory vfs, posix path, process/Buffer, md5/sha1, throwing
  child_process).
- `src/shim/` — the Electron-main replacement: `window.clew` channel
  registry, VaultManager over the vault mirror, RenderService (one-shot
  worker pool), settings, native bridge, iOS touch layer (`ios-ui.js`).
- `src/ios/` — index.html + ios.css.
- `ios/` — the Xcode project: scheme handlers (`clew-app://`,
  `clew-preview://`), FS bridge, vault store, HEIC conversion, delegates.
- `seed-vault/` — the demo vault, seeded into Documents on first launch.
- `tools/render-note.mjs` — render any vault note through the worker
  bundle under Node.

## Known gaps (tracked in PORT-PLAN.md)

Mathematica blocks (wolframscript), LaTeX/PDF export, site export,
the ZetaOffice runtime (office documents open read-only in Quick Look,
and embeds show Quick Look thumbnails; editing them needs the desktop
app), kanban drag on touch, touch-only file move (drag-to-move is
pointer-only; no Move menu item yet), iCloud conflict-version surfacing
(sync Phase 2), CJK fallback fonts for PDFs (upstream's 139 MB pack has
no iOS downloader), `\citefile` BibDesk attachments (BufferShim gaps),
and a third-party-notices surface.
