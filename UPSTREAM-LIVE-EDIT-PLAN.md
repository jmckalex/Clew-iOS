# Upstream Live-Edit Sync — Plan for Clew-iOS

**STATUS: EXECUTED 2026-09-27 (`live-p1-vendor` → `live-p5-verify`,
all simulator-verified on a clean install; nothing pushed).** Where the
outcome differs from the plan: §2.1's re-attach rebuild was NOT added —
measured, the renderer's own path recreates the frame layer on
re-attach and the frames never go stale (PORT-PLAN, WebKit findings);
p4 changed no source (verification only, folded into p5's record, so
the chain is p1 → p2 → p3 → p5); the "44 pt row rule" of §1's explorer
row does not exist in `ios.css` (rows measure 22 px, as before — the
virtualised explorer measures a probe row, so any future rule is safe);
and the citations arc surfaced a PRE-EXISTING gap, formatted citations
in reading mode (citation-js is not in the worker — README known gaps).
Guarded patches (counted as `patched()` calls, HANDOVER's convention):
seventeen → twenty-two (`shell:toggle`, the boot path, `popover.js`,
`floating-pane.js` ×2), plus the engine-mirror resolver.
Written the way the
0.8–0.11 plans were: one branch per phase, chained off the previous tip
(`main` = 6a5d521, which now carries the fontnote chain and the canvas
engage convention), so a bad phase falls back cleanly. Read `README.md`
and `PORT-PLAN.md` for architecture, `HANDOVER.md` for session state.
`UPSTREAM-0.9-PLAN.md` §0's ground rules apply verbatim: never push
without the owner's OK; never edit `vendor/`; non-iOS improvements go
upstream, recorded as candidates in PORT-PLAN.md; guarded build patches
must FAIL the build when upstream drifts.

Brings the port from upstream `4eae005` to **`ccf8dca`** (main, clean):
77 commits, 251 files, +23,900 / −961. Thirty-nine of them are the
`feat/live-edit` branch (merged `254c198`); the rest are 0.10.0, the shell
panel, vault exclusion lists, the virtualised explorer, `@reveal[…]`, TeX
fragments, description-list grids, headerless tables and fixes. Named by
feature rather than number: upstream's tags stop at v0.9.0 while its
`package.json` says 0.10.0, and the port's own "0.10"/"0.11" labels mean
something else (HANDOVER §2.5).

**All seventeen guarded patch anchors still match at `ccf8dca`** (checked
programmatically, 2026-09-27) — the re-anchoring the last handover
budgeted for is not needed. `vendor/jmarkdown` and `vendor/embedpdf` did
not change.

## 0. What live edit is, in one paragraph

A THIRD view mode beside source and reading: the same CodeMirror
`EditorView` and the same `EditorState`, reconfigured through a
`Compartment` so that constructs the caret is not touching are *concealed*
— their marks hidden, a rendered stand-in shown in place (a chip, a
MathJax SVG, a drawn table, an image, or for engine-only blocks an
`<iframe>` holding a full preview document) — and *revealed* as source
the moment any selection range touches them. "Live edit is source mode
wearing a costume, and every keystroke lands in the same EditorView"
(`docs/dev/live-edit.md`). Around it upstream built an editor toolbar, a
selection bubble, a `//` command menu, tables edited in place, link hover
previews, a floating preview pane for maths and diagrams, cross-reference
numbering as you type, citations as objects, PDF annotations extracted
into a note, and sidenotes. It is heavily interaction-shaped — every
pointer path is `mousedown` with `⌥`/`⌘` deciding edit-vs-follow — which
is where iOS diverges, and why this plan is longer than the 0.11 one.

## 1. What changed upstream, and what it costs here

| Upstream change | Rides the drop? | iOS work |
|---|---|---|
| **Live edit core** (`87cc541`…`8e9ff7b`): scanner `constructs`, `scan-cache`, `live/model.js`, the reveal rule, `blockField` + `inlineLayer`, widgets, `liveCompartment`, `editorPool.setMode`, `tab.view.mode` ∈ source/live/reading + `view.editMode`, `workspace:toggle-live`, `workspace:mode-*` | renderer: yes, pure | **none for the core.** The bottom toolbar's 👁/✎ button runs `workspace:toggle-mode`, which still means reading ↔ the tab's edit mode; the source↔live switch is the editor toolbar's segmented control. Verify in the simulator |
| **Block frames** (`ba94f53`, `e0a5f44`, `2e2cbab`): Tier C constructs get an `<iframe class="le-frame">` in ONE `.le-frames` layer in `scrollDOM`, onto `POST …/__clew_block__` `{text, sourcePath}` → `{hash}` and `GET …/__clew_block__/<hash>` (a FULL engine document, `data-clew-block`, the client posts its body `size`); `renderBlock`/`blockDocument`; keys carry a `configGeneration` and a `fragmentEpoch`; a `.source` sidecar tells `vault-model.js#currentFilePath` the owning note; `liveFrameCap` eviction | renderer + client: yes | **THE port** (§2.1–2.3): the two endpoints in `SchemeHandler.swift`, `renderBlock`/`blockDocument` in the shim render service with the sidecar written into the vfs, and a WebKit-specific rebuild of every frame when the editor DOM is re-attached — the tab group re-parents the pooled editor (and its iframes) on every tab switch, which is the stale-window-proxy case this port already knows |
| **In-page MathJax** (`lib/mathjax.js`): `<script src="clew-preview://vault/__clew_assets__/mathjax/tex-svg.js">` on the APP page for Tier A maths and the preview pane | yes — the CSP already lists that origin and the asset root is served | none; it is JS, not wasm (the rule of thumb is about wasm). Measure once |
| **Editor toolbar** (`f049250`), popovers, selection bubble (`c3b4616` chords) | yes | touch sizing in `ios.css` (36 px bar / 28 px buttons / 18 px grid cells are below 44 pt); bubble OFF by default on iOS (§2.6); popovers placed by `window.inner*` — `visualViewport` under the software keyboard (§2.7) |
| **`//` menu** (`2c7d8a8`): a CodeMirror completion source | yes | none; the completion tooltip is tappable |
| **Tables edited in place** (`c10f524`): plain `mousedown` on a cell activates a pooled nested editor and focuses it; `contextmenu` → the table menu; Tab/Enter/Escape navigate | yes | a tap enters a cell (WebKit synthesises `mousedown`) and pops the keyboard — correct; the port's long-press → `contextmenu` reaches the table menu unchanged; leaving is a tap elsewhere (no Escape); rows/columns via the toolbar's table group. Verify, no code expected |
| **Link hover previews** (`64fb7b2`): `mousemove` only; 440 px popover; reading mode too | yes | **no touch path exists**, and a tap's synthesised `mousemove` would start the 500 ms timer with no `mouseleave` to cancel it: `linkPreview` defaults to `'off'` on iOS (§2.5); a trackpad user turns it on |
| **Preview pane** (`818cf32`): floating, cursor-driven, needs `hasFocus` | yes | placement by `visualViewport` (§2.7); otherwise none |
| **Live-mode click semantics** (`live/events.js`): tap on a concealed link FOLLOWS, `⌥` reveals, `⌘` new tab; every other stand-in reveals on tap | yes | **the touch convention** (§2.4): long-press = "the source" (iOS's ⌥); the port's source-mode second-tap rule must stand off live mode or a link opens twice; `link-at.js` replaces the port's own regex |
| **Cross-references** (`bb3c94a`), multi-paragraph footnotes (`91819ed`), `90a4d95` footnote faces | yes | none — re-checked at `ccf8dca`: `editor.js` is not patched and `footnote-parser.js` arrives with `src/renderer` |
| **Citations as objects** (`b52b9e1`): Refs panel always present, Library, graph References; `BIB_ENTRIES` entries now `{…, bib, pdf: {path, inVault, exists}}` (the old `file` key is GONE); the walk skips unindexed folders; out-of-vault PDFs → `SHELL_OPEN_PATH file://` | renderer: yes | **shim `BIB_ENTRIES`** rewritten to the new shape over the mirror (`shared/bib.js#bibFilePath`); out-of-vault → the existing refusal with a reason (nothing outside the sandbox is reachable) |
| **PDF annotations → note** (`55a5cbb`): `pdf:extract-annotations`, explorer item, `[[x.pdf#page=N]]`; viewer API in `pdf-core.js`/`pdf-page.js` | yes — the port's PDF surface IS upstream's EmbedPDF `pdf-page.html`; the `pdf-core.js` anchor holds; `__clewPdfHandle` (upstream) and `__clewPdfHandles` (ours) are distinct | verify end-to-end in the simulator (§4.9) |
| **Sidenotes** (`cbd973c`): `auto` needs a ≥ 960 px scroller and ≥ 220 px margin | yes | none; below the threshold the footnote body is a `title` tooltip — unreachable on touch, but a tap on the badge reveals the source |
| **Vault settings in the renderer** (`51f7858`, `vault-settings-store.js`): loaded ONLY in the `EV_VAULT_OPENED` handler | yes | **iOS boots through `VAULT_CURRENT`** and suppresses that event (`ipc.js` silent open), so the store would stay `{}` every launch — grammar, live config and TeX-fragment warnings all wrong until a setting is touched. Guarded patch on `renderer/main.js`'s boot branch (§2.10); upstream candidate (a desktop reload has the same hole) |
| **Vault exclusion lists** (`1747269`, `vault-excludes.js`): `hidden` / `unindexed` glob lists in `vault-settings.json`; tree, watcher, indexer, `.bib` scan, `rename-links` all consult `vaults.excludes` | `vault-excludes.js`, indexer, rename-links: verbatim | **shim `VaultManager.excludes`** + `reloadExcludes()`, tree honouring `isHidden`, `indexer.openVault(root, excludes)`, the `VAULT_SETTINGS_SET` reload path. **Hard break otherwise**: `rename-links.js` reads `vaults.excludes.isUnindexed` → `FS_RENAME` throws with any `.canvas` in the vault |
| **Watch budget / order** (`5330e1a`, `a86936b`, `941d3ec`), `EV_WATCH_CAPPED`, `vault.info.watchCap` | chokidar-side | none; never emit the event (the renderer is null-safe) |
| **Shell panel** (`c96c0f5`): `clew-shell-panel.js` imports `@xterm/xterm` + `@xterm/addon-fit` unconditionally via `clew-app.js`; `SHELL_*` channels spawn a PTY; `shell:toggle` `` Ctrl-` `` | build BREAKS without the deps | **§2.8**: alias both packages to a stub, drop the `shell:toggle` command (guarded patch), `SHELL_*` answer `{ok:false, error}`, force `shell.open=false` on `WORKSPACE_LOAD` |
| **TeX fragments** (`3a180c2`): `engine/tex-fragments.js`, `CLEW_TEX_FRAGMENTS` env `{global, vault}`, settings rows, `SETTINGS_SET`/`VAULT_SETTINGS_SET texFragments` → `reconfigure` | engine + renderer: yes | shim `engineEnv` emits `CLEW_TEX_FRAGMENTS`; both set-handlers reconfigure (and respawn the standby so the env lands); the seed vault's `vault-settings.json` gains two fragments |
| **`@reveal[…]`** (`a48b0ce`): `engine/reveal-embed.js` as a new `Environments` entry; a deck folder's `index.html` in an iframe; `demo-vault/Attachments/demo-deck` | engine: yes | `engine-config.js` Environments += `reveal from /engine-assets/reveal-embed.js`; worker registry entry; `.html` is in the vfs `TEXT_EXT`. Plain-http decks may meet App Transport Security (§4.10) |
| **Virtualised explorer** (`81c3e0b`, `tree-window.js`): rows absolutely positioned, height MEASURED by a probe row, repainted on scroll | yes | none expected — a 44 pt row rule is honoured; the port's long-press dispatches on the pressed element, whose closure holds the entry. Verify |
| 16 new app-settings defaults (`main/settings.js`); renderer reads several WITHOUT fallback (`graphReferences`, `texFragments`, `previewPane`, `editorToolbarGroups`, `slashCommands`, `selectionBubble`, `defaultEditMode`, `newTabMode`) | — | **shim `settings.js` DEFAULTS** gains all sixteen, with the iOS overrides of §2 |
| Indexer `CACHE_VERSION` 1 → 3 (labels, citations in `note-metadata.js`) | verbatim | one re-scan on first open |
| Headerless tables, nested emphasis, italics as the engine reads them (`45789a2`), lists/quotes on an empty line (`a14a0c4`), description-list grid (`a2721cb`), `Term::`, math sealed (`b9de21c`), fence highlighting in the editor (`52c625a`) | yes | refresh the ported suites; reading-mode checks |
| Format chords (`c3b4616`): `⌘B` strong, `⌘I`, `⌘U`, …; **sidebars move to `⌘⌥B` / `⌘⌥⇧B`** | yes | none; hardware-keyboard users only. `prettifyChord` sniffs `navigator.platform` (cosmetic, §4.7) |
| `note-fonts.js` head directory checksum per spec (`d393b78`) | yes | none — `NoteFonts.swift` already wrote the spec value; the one differing word now agrees. Re-run the byte check for the record |
| `shared/file-types.js` (moved, unchanged sets), `fs-utils.js` watch helpers, `main.js` smoke harness, `menu.js`, 0.10.0 | — | none. (Pre-existing, noted: `VaultStore.swift`'s text set lacks `excalidraw`, `base`, `bibtex`, which the shim's `TEXT_EXT` has — a follow-up, not this sync) |

`shared/channels.js` gained `EV_WATCH_CAPPED` and the six `SHELL_*`
constants — **no new channel live edit itself needs**. Two new npm deps
(`@xterm/*`), both stubbed. Upstream's `index.html` adds only the xterm
stylesheet link, which the stub makes unnecessary. `main.css` imports the
four new stylesheets; `stageStatic` copies `styles/` whole.

## 2. The decisions

1. **Frames are rebuilt when the editor DOM is re-attached.** Upstream's
   `FrameLayer` never re-parents an iframe itself (append first, `src`
   after — the office-embed lesson), but `clew-tab-group` swaps the body
   and `clew-editor-view` does `replaceChildren(entry.view.dom)` on every
   tab switch, split and drag, and the plugin survives (`setMode` no-ops
   when the mode is unchanged). Chromium reloads a moved iframe; WebKit
   gives it a stale window proxy — `event.source === contentWindow` never
   matches and both directions die silently (PORT-PLAN, WebKit findings).
   Two guarded patches: `clew-editor-view.js` dispatches a `clew-reattached`
   event on the view's DOM after adopting it, and `frame-layer.js` answers
   it by dropping every record's iframe (`remove()`, `iframe = null`,
   `ready = false`, state idle) and scheduling a measure, so `#write`
   recreates them; hashes are kept, so each frame is one cached GET.
   Heights survive in `frameHeightField` (a StateField, untouched), so the
   layout does not jump. Upstream candidate: Chromium pays a reload anyway,
   so the rebuild would make both engines behave alike. Alternative
   (rejected): flip the compartment off and on — it drops the height field
   and every frame re-POSTs.
2. **Block documents are built exactly as upstream builds them**: a full
   engine document (`fragment: false`, the note template, so MathJax and
   mermaid configuration cannot drift), keyed by
   `doc ⧵0 configGeneration ⧵0 sourcePath ⧵0 [fragmentEpoch if dependent]
   ⧵0 text`, served `no-store`, wrapped by the one injection path
   (`injectClientScripts` grows a `block:` flag adding `data-clew-block="1"`
   to `<html>`), sharing one bounded cache with canvas fragments. The
   `.source` sidecar goes into the worker's vfs beside the temp `.md` —
   `vault-model.js#currentFilePath` runs in the worker and finds it exactly
   as on desktop, so Dataview `this`, Bases, Meta Bind and kanban see the
   owning note with NO engine change. `isDependentFragment` comes from
   `shared/fragment-deps.js`. The POST is the same shape as the canvas
   card POST the app page already makes to `__clew_fragment__` (CORS
   headers are on every response), so the seam is closed by precedent; the
   `Origin` guard is added to both POST routes for parity.
3. **The frame cap is lower on iOS: 8, not 16** (`liveFrameCap` default;
   the setting's 4–64 range is upstream's). Desktop measured ~22 MB per
   block document; an iPad's content process is jetsam-killed well short
   of what a Mac tolerates, and a block holding a figure boots a
   mp-tikz-wasm worker in its own document (cache hits do not — the 0.11
   measurement: a reopened note's figures in ~250 ms with no engine boot).
   Memory is not observable from the page; the device number is the
   owner's (§4.4). Reversible in Settings.
4. **Touch conventions in live mode — "long-press is the source".**
   Upstream: a plain click on a concealed link/URL/citation/embed chip
   FOLLOWS, `⌥`-click places the caret (reveals), `⌘`-click opens a new
   tab, and a click on any other stand-in (maths, chip, image, hr, fence
   head, frame edge) reveals. On touch a tap is upstream's click, unchanged
   — the reader expects a tapped link to open, and a reveal would also pop
   the keyboard. `⌥` has no touch equivalent, so the port's long-press
   (already synthesising `contextmenu`) becomes it: a long-press on a
   concealed link, chip, image, maths widget or frame placeholder places
   the caret there (`posAtDOM` + dispatch + focus, upstream's own
   `placeCursor`), in `ios-ui.js`. Upstream's `contextmenu` handler acts
   only on table cells, so nothing collides. The frame edge — 6 px, visible
   only on `:hover` — widens to 24 px and gets a visible rule on `.is-ios`
   (CSS only). **Source mode keeps the port's rule** (first tap places the
   caret, second tap on the same link follows, long-press follows) but
   reads links through upstream's `link-at.js` (so `\cite{}`, `@ref[]` and
   `[text](url)` follow too) and **stands off live mode**: `liveEvents`
   claims the `mousedown` and follows, and the port's `click` listener
   would open the note a second time. Gate on `.cm-live` and on
   `[data-le-target], [data-le-href]` targets. Documented in the guide as
   the one place the modes' gestures differ. Alternative (upstream's own
   recorded alternative): plain tap edits, long-press follows — rejected
   for touch, where a tapped link that does not open reads as broken.
5. **Link hover previews default off on iOS** (`linkPreview: 'off'`).
   Touch has no hover; worse, WebKit's tap-synthesised `mousemove` would
   arm the 500 ms timer with no `mouseleave` ever coming, so a tap that
   only reveals would pop a 440 px preview half a second later. An iPad
   trackpad delivers real hover, and the setting stays in Settings for
   that reader. `ios.css` clamps the popover to `100vw − 16px`. No
   long-press route is added: long-press is taken by §2.4, and previews
   without hover are a design question for upstream.
6. **The selection bubble defaults off on iOS** (`selectionBubble: false`).
   It appears above the selection's first line on `pointerup` — exactly
   where and when iOS draws its own callout (Copy · Look Up · …) — and
   every command on it is on the toolbar. Reversible; the alternative is
   positioning it below the selection on `.is-ios`.
7. **Floaters measure the visual viewport.** Popovers, the preview pane,
   the link preview and the bubble are `position: fixed` and clamp to
   `window.innerWidth/innerHeight`; in a WKWebView the software keyboard
   does not shrink `innerHeight`, so "below the block" can land under the
   keyboard. One guarded patch each on `popover.js` and `floating-pane.js`
   (and the bubble if kept): `(visualViewport?.height ?? innerHeight)` and
   the matching `offsetTop`. Harmless on desktop — upstream candidate.
   Assert the configuration in the simulator; the iPad confirms (§4.5).
8. **The shell panel is stubbed, not shipped.** A PTY cannot exist on iOS.
   `build.js` aliases `@xterm/xterm` and `@xterm/addon-fit` to a stub
   module (no new npm deps, no `xterm.css`), a guarded patch drops the
   `shell:toggle` entry from `commands/builtin.js` (anchor: the entry's
   first line), `SHELL_OPEN` answers `{ok: false, error: 'A shell is not
   available on iOS'}`, `SHELL_WRITE/RESIZE/CLOSE` `{ok: false}`, `EV_SHELL_*`
   never fire, and `WORKSPACE_LOAD` forces `shell.open = false` so a
   desktop-saved workspace does not open a dead panel on the iPad. The
   `<clew-shell-panel>` element stays in the DOM, `display: none`, inside
   upstream's new `.center-column` wrapper — check `ios.css` has no
   `clew-app > clew-workspace`-shaped selector (it has none today).
   Alternative: ship xterm and let the panel print the refusal in red.
9. **Exclusion lists are honoured in JS over the mirror, not in Swift.**
   Every walk that matters — tree, indexer, `.bib` scan, rename rewrite —
   is upstream JS over `MirrorFS`, so `compileExcludes` from
   `vault-excludes.js` (verbatim) on the shim `VaultManager` gives
   identical semantics by construction; `isHidden` replaces the shim's
   `IGNORED_DIRS`. The Swift snapshot still carries hidden files (a perf
   cost, not a correctness one). Pruning the snapshot in Swift would mean
   porting the glob dialect and its tests — a follow-up if a real vault
   asks.
10. **The boot path loads vault settings.** Guarded patch on
    `renderer/main.js`'s `VAULT_CURRENT` branch: `await
    vaultSettingsStore.load()` right after `vaultStore.setVault(vault)`
    (anchor: the `watchCap` line, unique). The editor pool awaits
    `ready()`, which starts resolved, so without this the first editors
    would take the wrong grammar. Upstream candidate, like the greeting
    rule: the desktop's own window reload has the hole.
11. **Live is the default edit mode on iOS** (`defaultEditMode: 'live'`,
    `newTabMode: 'live'`, `editorToolbar: 'always'`). Upstream keeps new
    tabs in source ("do not move users"); iOS has no users to move, no
    chords, and the toolbar — the only formatting surface without a
    hardware keyboard — shows only in live mode by default. `'always'`
    gives source mode the toolbar too. All three reversible in Settings;
    the tab's mode is per vault in `workspace.json`, so a tab opened live
    on the iPad is live on the Mac next time — upstream's design, same for
    the desktop. **This is the one decision the owner may want to reverse
    before the phase runs.**
12. **Everything else defaults as upstream**: `liveReveal 'construct'`,
    `liveRenderMath/Fences/Embeds true`, `slashCommands true`, `previewPane
    'on'`, `graphReferences false`, `sidenotes 'auto'`, `texFragments []`,
    `editorToolbarPrev`, `editorToolbarGroups null`.

## 3. Phases

- **`live-p1-vendor`** — `npm run sync-upstream` at `ccf8dca` (`git
  checkout --` the AppIcon; the seed vault gains `Guide/Live Edit.md`,
  `Attachments/demo-deck/`, and `texFragments` in `vault-settings.json`,
  which `CLEW_STATE_EXCLUDED` keeps). Build: the `@xterm/*` stub alias,
  the `shell:toggle` patch, the `main.js` boot patch. Shim: the sixteen
  settings defaults with §2's overrides; `ipc.js` — `SHELL_*` refusals,
  `BIB_ENTRIES` in the new shape over `isUnindexed`, `SETTINGS_SET
  texFragments` → `reconfigure({})`, `VAULT_SETTINGS_SET` `hidden`/
  `unindexed` → `reloadExcludes` + `indexer.openVault(root, excludes)` and
  `texFragments` → `reconfigure`, `hooks.onOpen` passing `excludes`,
  `WORKSPACE_LOAD` forcing `shell.open=false`; `vault-manager.js` —
  `excludes`, `reloadExcludes()`, tree by `isHidden`; `engine-config.js` +
  `engine-worker.js` — the `reveal` Environment, `CLEW_TEX_FRAGMENTS`.
  Tests: port the pure suites (`code-tokens`, `crossref-complete`,
  `footnote-syntax`, `format-toggle`, `fragment-dependent`,
  `fragment-source`, `frontmatter-edit`, `headerless-tables`, `inline-dom`,
  `jmarkdown-constructs`, `link-at`, `live-model`, `live-reveal`,
  `math-syntax`, `minimal-change`, `numbering`, `pdf-annotations-note`,
  `preview-target`, `print-css`, `reveal-embed`, `slash-commands`,
  `subsup-syntax`, `table-cell`, `tex-fragments`, `toolbar-layout`,
  `toolbar-state`, `tree-window`, `vault-excludes`, `bib`; skip
  `shell-core`, `watch-*`); re-sync `tables`, `workspace-tree`; extend
  `services` (new `BIB_ENTRIES` shape, exclusion reloads, `SHELL_*`,
  `FS_RENAME` with a `.canvas` present) and `engine-worker` (`reveal`,
  `CLEW_TEX_FRAGMENTS` reaching `figures.js`). Build + tests green,
  xcodebuild clean, the app boots, source and reading modes regress-free,
  live mode renders Tier A/B with frame skeletons (the endpoint lands in
  p2, so a frame's POST fails and its skeleton stays — the honest state
  at this boundary).
- **`live-p2-frames`** — shim `render-service.js`: `renderFragment(text,
  {sourcePath, dependent})`, `renderBlock`, `blockDocument`,
  `#fragmentKey` with `#configGeneration` and `#fragmentEpoch` (bumped in
  `reconfigure` and `onFileChanged`), the `.md` + `.source` pair passed to
  the worker as extra vfs files under `.clew/cache/fragments/`, one
  bounded cache; `__clewNative.renderBlock/blockDocument`;
  `SchemeHandler.swift` — POST `__clew_block__` (413/400/403 as upstream,
  `Origin` guard on both POSTs) and GET `__clew_block__/<hash>` (404 when
  evicted), `injectClientScripts(block:)`; the two re-attach patches
  (§2.1); `liveFrameCap` 8. Simulator probes §4.1–4.3 on the demo vault's
  Diagrams note in live mode: every fence a frame, sizes arriving, a tab
  switch and back, an edited fence morphing in place, a `texFragments`
  change re-rendering every frame, a Dataview block seeing `this.file`.
- **`live-p3-touch`** — `ios-ui.js`: the live-mode long-press reveal
  (§2.4), `link-at.js` for the source-mode second tap, the live-mode
  stand-off; `ios.css`: toolbar 44 px / buttons 36 px / grid cells 28 px,
  the 24 px frame edge, popover and link-preview width clamps, the
  `.center-column` check; the `visualViewport` patches (§2.7). Synthetic
  `PointerEvent` + `MouseEvent('mousedown'/'click')` probes drive
  `liveEvents` (§4.6); gestures the iPad confirms are listed for the
  owner.
- **`live-p4-platform`** — the arcs that need a real vault: citations
  Library end to end (a `.bib` with `file` fields, Insert at the caret,
  Cited-in, the in-vault PDF opening in a tab, the out-of-vault refusal),
  `pdf:extract-annotations` and `[[x.pdf#page=N]]` on the EmbedPDF surface
  (§4.9), TeX fragments (a global and a vault fragment, the shadow warning,
  a figure using `\R`), `@reveal[…]` of the seed deck, exclusion lists
  (`hidden` removes a folder from tree and index; `unindexed` lists it but
  the indexer ignores it; a rename with a canvas present), the explorer
  with 44 pt rows and long-press after a scroll, sidenotes on the iPad in
  landscape, the `Live Edit` guide note itself.
- **`live-p5-verify`** — regression sweep on a clean install: the
  0.8–0.11 arcs (search, index, history, EmbedPDF, Excalidraw, Web Awesome,
  figures, font=note in the simulator, Quick Look, global plugins, print),
  plus upstream's 21 `smoke/live-sweep.sh` scenarios translated to
  `ClewSmokeJS` probes where touch allows (live-edit, live-lines,
  live-table-edit, live-headerless-table, live-nested-fence, preview-pane,
  crossref parity `numbers-match=true`, slash-menu, fence-dl-math,
  empty-line-format, live-footnotes, citations, sidenotes, pdf-annotations,
  citations-fullcite, footnote-highlight, math-highlight, live-toolbar,
  live-perf on a 17× Diagrams note; format-chords and link-preview need a
  keyboard and a hover — device or skipped by name). PORT-PLAN milestone,
  decisions and WebKit findings; README known gaps; HANDOVER rewrite;
  memory.

## 4. Seam questions (answered during the phases)

1. **Does a live iframe moved with the editor DOM go stale on WebKit, and
   does the re-attach rebuild restore it?** Expected yes/yes from the
   preview-view finding. Probe: a vault script in `.clew/scripts/probe.js`
   runs in every block document too (`wrapPreviewDocument` is the one
   injection path) — `console.warn('PROBE block ready …')`; after a tab
   switch and back, count `.le-frame` elements whose `visibility` returns
   to `visible` and whose `.le-frame-body` height changed from the
   default, i.e. a `size` message arrived.
2. **Does the app page's `fetch` POST with a JSON body reach the scheme
   handler and return `{hash}`?** Expected yes — canvas cards already POST
   to `__clew_fragment__` from the app page and the CORS header is on
   every response. Assert on the first frame.
3. **Does a touch scroll that starts on a `.le-frame` chain to the
   editor's scroller?** Block bodies are `overflow: hidden` and the editor
   is not transformed (unlike the canvas), so it should; `touch-action`
   does not cross the frame boundary either way. Assert the computed
   `overflow`; the iPad confirms the gesture.
4. **Memory with the cap at 8 on a Diagrams-shaped note**, each frame a
   preview document, several booting mp-tikz-wasm — device only. If the
   content process is killed, the cap comes down or Tier C fences default
   to `liveRenderFences: false` on iOS.
5. **`window.innerHeight` under the software keyboard in WKWebView** —
   expected not to shrink; `visualViewport.height` does. Assert both exist
   and differ while an editor is focused (the simulator's keyboard toggles
   with ⌘K); the pane's placement is the iPad's to confirm.
6. **Does a tap on a CodeMirror widget produce the `mousedown`
   `liveEvents` wants?** WebKit synthesises compatibility mouse events for
   a tap unless a handler cancels the pointer sequence; the port's
   long-press listener does not. Probe with synthetic events; the iPad
   confirms with a finger.
7. `navigator.platform` on iPadOS in a WKWebView is `MacIntel`, so chord
   glyphs read ⌘/⌥ — right for a Magic Keyboard. Cosmetic; note it.
8. **IME composition** inside a concealed word and in a table cell
   (upstream's own QA list): a CJK keyboard on the device.
9. **PDF annotations from the app page**: `pdf-annotations.js` posts
   `list-annotations` to `clew-file-view`'s `iframe.pdf-frame`, which
   answers only its `window.parent` — the same depth as desktop. Expect
   it to work; `showPdfPage` waits for `pdf-page-shown`.
10. **`@reveal` of an `http://` deck** meets App Transport Security in the
    preview document (`Info.plist` has no exception). The seed deck is a
    vault file, so it is served by the scheme; a remote deck is the
    owner's call (an ATS exception is a listing question).
11. **Time**: a cold live open of the Diagrams note (frames, MathJax on
    the app page, engines) in the simulator, against its reading-mode 2.3 s.

## 5. Definition of done

1. `vendor/` + `seed-vault/` at `ccf8dca`; every table row demonstrated
   in the simulator or deferred with a reason.
2. Live mode on the Diagrams note: every construct conceals and reveals,
   every fence a frame reporting its size, a tab switch and back keeps
   the frames alive, an edited fence morphs in place, the toolbar and the
   `//` menu insert, a table edits in a cell and reflows once on leaving,
   a tap on a concealed wikilink opens it and a long-press reveals it, no
   unknown channel, no 404 in the scheme handler log except an evicted
   hash.
3. Source and reading modes, and every 0.8–0.11 arc, unchanged.
4. Tests: every ported suite diffs clean against upstream (path rewrite
   only); the services suite covers the new `BIB_ENTRIES` shape, the
   exclusion reloads and the `SHELL_*` refusals.
5. No vendored file edited; iOS deltas are guarded patches or
   `src/`/`ios/`; the five upstream candidates recorded in PORT-PLAN
   (frame rebuild on re-attach, `visualViewport` in floaters, the boot
   path loading vault settings, `Origin` guard parity, and "long-press as
   ⌥" as a question for upstream's touch story).
6. Docs updated; nothing pushed. Gestures, memory and IME (§4.3–4.6, 4.8)
   remain the owner's on the iPad.

## 6. Deferred, unchanged

The ZetaOffice runtime; site export; `\citefile`; third-party notices;
native CJK font download; Xiaolai prune; ```kanban touch drag; "Move to
folder…"; empty folders in the explorer; iCloud conflict surfacing; stale
recents pruning; canvas toolbar undo/redo. New from this round: a
touch route to link previews (upstream's design question); Swift-side
pruning of `hidden` paths from the snapshot (§2.9); `excalidraw`/`base`/
`bibtex` in `VaultStore.swift`'s text set (pre-existing gap the seam
report surfaced); the shell panel (impossible); persisting frame heights
across reopenings (upstream's own follow-on).
