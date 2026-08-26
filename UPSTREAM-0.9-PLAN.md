# Upstream 0.9 Sync — Implementation Plan for Clew-iOS

Written 2026-08-26. Brings the iOS port from upstream `ed35ba8` (v0.8.0) to
`8422a45` (v0.9.0) — **18 commits, ~4,100 insertions**. Read `README.md` and
`PORT-PLAN.md` for architecture, `HANDOVER.md` for session state.
`UPSTREAM-0.8-PLAN.md` is the model this plan follows (and its §0 ground
rules apply verbatim: never push without the owner's OK; never edit
`vendor/`; non-iOS improvements go upstream, recorded as candidates in
PORT-PLAN.md; guarded patches must FAIL the build when upstream drifts).

## 1. The delta, scoped

Verified against both repos on 2026-08-26. The 0.9 arcs and what each needs
on iOS:

| Arc | Upstream change | iOS work |
|---|---|---|
| Obsidian Kanban boards | `engine/kanban-board.js` (new), read-only render, checkbox = only write path | engine-config + worker registry entry |
| Tasks dialect, search embeds | `engine/query-fences.js` +399 | none (vendored engine) |
| DQL FLATTEN / GROUP BY / lambdas | `engine/dataview.js` +250, `dv-expr.js`, `dv-functions.js` | none — but `runQuery` row shape changed (`{page, extra}`), so the ported dataview tests must be refreshed with the vendor drop |
| Admonitions (```ad-*) | `engine/admonitions.js` (new) | engine-config + worker registry entry |
| Meta Bind widgets | `engine/meta-bind.js` (new), `preview-client/meta-bind.js` (new) | engine-config + worker registry entry; preview side rides the client.js bundle |
| Bases map views | `engine/bases.js`, `preview-client/leaflet-maps.js` | none (leaflet already staged) |
| Charts plugin | `demo-vault/.clew/plugins/charts/` with an **engine surface** (`chartFence`), vendored chart.umd.js, `dataviewJs: true` now on in demo vault | **the big one: engine-surface vault plugins** (see §2) |
| obsidian:// links | `shared/obsidian-uri.js` (new), `renderer/lib/external-links.js` (new) | none — plans internally, falls back to `CH.SHELL_OPEN_EXTERNAL` (already answered by the shim) |
| Back-able anchor jumps | `preview-client/anchors.js` (new), client.js, workspace tree `recordAnchorJump` | none (vendored) |
| Cmd+[ / Cmd+], chords from reading mode | `commands/registry.js` `effectiveChords`/`runChord`, client.js forwards the host's full chord list | none (vendored); needs a hardware-keyboard device check |
| Images in Excalidraw drawings | `excalidraw/page.js` rehydrates from "## Embedded Files", new resolve bridge in `renderer/pdf-save.js` (installed by vendored main.js) | verify the page's root-relative vault fetch works under the iOS clew-preview URL shape (§4) |
| Site-export fixes | `main/export-site.js` | not ported — site export is desktop-only |
| Demo figures / new guide pages | seed-vault content incl. desktop-cached TikZ/MetaPost SVGs | rides `sync-upstream` |

**No new IPC channels** (`shared/channels.js` unchanged). **No new npm deps
for iOS** (upstream added chart.js, but the plugin carries its own committed
`chart.umd.js` — it travels with the vault). All 9 guarded patch anchors in
`scripts/build.js` were pre-checked against `8422a45` and still match.

## 2. Engine-surface vault plugins (the one real gap)

The demo vault now ships a plugin whose manifest declares
`surfaces.engine: { file: "engine.js", extensions: "chartFence" }`. Desktop
appends `chartFence from <vault>/.clew/plugins/charts/engine.js` to the
engine config (`main/plugins.js#engineExtensionEntries`) and the engine
dynamically imports it from disk. On iOS, three things stand in the way,
each with a planned fix:

1. **The config never names plugin entries.** `src/shim/engine-config.js`
   gains an `engineExtensions` parameter appended after the kanban entry
   (upstream's order: …bases, admonitions, meta-bind, callouts, kanban,
   plugins). Both callers — `src/shim/render-service.js` and
   `tools/render-note.mjs` — compute the entries with the vendored
   `main/plugins.js#engineExtensionEntries` (shim: over the aliased
   vfs-backed fs; harness: over real fs), so there is one manifest-reading
   implementation, not a fork.
2. **The worker snapshot excludes `.clew/` wholesale.** The render service
   parses the `from` paths out of the entries and snapshots exactly those
   files (not all of `.clew/plugins/` — chart.umd.js alone is ~200 KB the
   worker never needs).
3. **The worker can't import vault paths.** The build's `__jmdImport`
   helper (metadata-header.js patch) gains a second fallback: a
   `globalThis.__jmdImportSource(path)` hook the worker fills — reads the
   vfs, imports via `URL.createObjectURL(new Blob(...))`, falling back to a
   `data:text/javascript;base64` import (Node supports data:, WebKit
   prefers blob: — try/catch cascade covers both without environment
   sniffing).

**Constraint to document:** an iOS-loaded engine surface must be
self-contained (blob/data modules can't resolve relative imports). The
charts engine.js is; the manifest contract doesn't promise more today.

**Risk:** the engine worker is a blob worker spawned from the app page, so
its dynamic imports may be CSP-gated (`script-src` may need `blob:`). The
0.8 finding that `new Function` works in the worker suggests eval is not
blocked, but this must be verified in the simulator; the fix, if needed, is
an app-page CSP addition in `src/ios/index.html` (iOS-owned).

## 3. Phases (one branch each, chained off `sync-p5-verify`)

Per the phase-per-branch pattern: each branch must build (`npm run build`),
test green (`npm test`), and stand on its own if a later phase is dropped.

- **`sync09-p1-vendor`** — `npm run sync-upstream` (vendor drop @ 8422a45 +
  seed-vault); `git checkout -- ios/.../AppIcon.png` (upstream icon
  unchanged; ImageMagick is non-deterministic); register the three new
  engine extensions in BOTH `src/shim/engine-config.js` and
  `src/worker/engine-worker.js` (admonitions, meta-bind before callouts;
  kanban-board after — upstream's order is load-bearing); refresh the
  already-ported test suites that upstream evolved (dataview, bases,
  excalidraw-file — re-copy with the `../src/` → `../vendor/clew/` path
  rewrite) so the branch is green.
- **`sync09-p2-plugins`** — §2 in full; prove with `tools/render-note.mjs
  seed-vault "Guide/Charts.md" --vault-options '{"plugins":["charts"],…}'`
  emitting `clew-chart` placeholders, and a first simulator check of the
  Charts guide page (preview surface draws the actual canvas).
- **`sync09-p3-features`** — simulator verification of the arcs that ride
  the vendor drop, and any iOS seams they turn out to need: Excalidraw
  image rehydration (§4), obsidian:// links, anchor jumps + Back, kanban
  board render + checkbox toggle, Meta Bind field edits, Bases map view,
  admonitions, the new demo pages, dataviewjs `renderChart`.
- **`sync09-p4-tests`** — port the new upstream suites (admonitions,
  kanban-board, meta-bind, obsidian-uri, charts-plugin, query-fences,
  workspace-tree — all pure-module imports, path-rewrite only;
  charts-plugin imports the plugin from `seed-vault/`); re-diff every
  ported suite against upstream for drift; extend the iOS engine-worker
  battery with a through-the-worker chart-fence render (proves the plugin
  import path under Node).
- **`sync09-p5-verify`** — clean-install simulator sweep across all arcs +
  regressions (search, index, tree, PDF surfaces, Excalidraw, mermaid,
  MetaPost cache); update PORT-PLAN.md (0.9 milestone, upstream-candidate
  changes), rewrite HANDOVER.md, update memory.

## 4. Known seam-shaped questions (answer during p2/p3, not now)

1. **Worker blob/data import under WKWebView CSP** — §2 risk.
2. **Excalidraw image fetch origin.** page.js fetches
   `/${sid}/${path}` root-relative, deriving sid from the drawing's own
   preview URL. Works if the iOS editor page is served from the same host
   that serves vault files; if the `clewex` asset root is a different
   custom-scheme host, the fetch is cross-origin and needs an iOS seam
   (likely: serve the editor page under the vault host, as pdf-page.html
   already is — confirm how pdf-page fetches its PDF and mirror it).
3. **TikZ demo figures** now ship desktop-cached SVGs; whether iOS reuses
   them depends on the preamble-hash question already recorded in
   PORT-PLAN. Expect the Diagrams page to improve, not regress; the "TikZ
   errors in the demo vault" accepted loss may partially disappear.
4. **Kanban touch drag** — NOT a 0.9 collision after all: upstream boards
   are read-only in reading mode (checkbox aside). The pre-existing
   `\`\`\`kanban` fence drag item stands unchanged.

## 5. Definition of done

1. `vendor/` + `seed-vault/` at `8422a45`; build + tests green on every
   phase tip.
2. Every §1 arc demonstrated in the simulator (screenshots or smoke logs),
   or explicitly deferred with a reason (hardware-keyboard chords → device).
3. Engine-surface plugins work in all three render paths: app worker,
   render-note harness, `node --test`.
4. No vendored file edited; every new behavioral delta is a guarded
   build.js patch or lives in `src/`/`ios/`; upstream candidates recorded.
5. PORT-PLAN.md + HANDOVER.md updated; nothing pushed.

## 6. Deferred, unchanged from 0.8

`\citefile` BibDesk attachments; third-party notices surface (chart.umd.js
now ships in the seed vault — add chart.js to the eventual iOS notices);
native CJK font download; CJK face prune (17 MB Excalidraw assets); device
verification items from the 0.8 sync (Pencil feel, per-scene Pdfium
memory) still gate the TestFlight push and are unchanged by this sync.
