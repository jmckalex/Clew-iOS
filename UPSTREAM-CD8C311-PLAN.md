# Upstream sync to Clew-app cd8c311 — plan and record

**STATUS: EXECUTED 2026-09-30 — NOT PUSHED.** p1 `f14d51f`
(`synctab-p1-vendor`), p2 verify on `synctab-p2-verify`. `main` is NOT
fast-forwarded: the owner decides this push in the morning (Clew-boss:
"STOP after p4 and report"; last night's "push if all checks pass" covered
the first sync only). Ordered by Clew-boss, whose instructions on syncs are
the owner's (the owner's standing rule).

**PIN: Clew-app `cd8c311`** (local there). Guard: Clew-app's HEAD had
moved to `2723e63`, which touched only `smoke/` and `HANDOVER.md`, so I
checked `src vendor demo-vault` for identity with `cd8c311` and for a
clean tree before copying. After copying, the trees were byte-identical to
`git archive cd8c311`. The range from `84f975e`:

| Commit | What | iOS consequence |
|---|---|---|
| f1816ae | the preview watchdog, keyed on load | retired the 2.5 s rebuild, `__iosSubscribed`, the client.js pageshow re-announce |
| 12b1734 | Pencil convention + viewer handles upstream | retired the pdf-core handle patch and `src/preview/pdf-touch.js` |
| 71180c6 | scene PDFs through pdf-page.html | retired `src/preview/pdf-scene-embeds.js` (relay and its guard) |
| a65395c | kanban board widens past the text column | CSS; a WebKit gap found (below) |
| 693c4fe | map distance tool measures | none; no touch route (below) |
| cd8c311 | LaTeX's tabbing | `tabbing.js` named in the generated config (fence + environment) and the worker registry |

10 guarded patches remain; `embed-scroll.js` is the one iOS module still
appended to client.js. 681 tests (a new engine-worker test covers both
tabbing forms).

## Results (simulator, iPad Pro 11" M4, iOS 18.1)

- **Tabbing** — upstream's own `smoke/tabbing-frame.js`, run in WebKit on
  its fixture: `ruler laid tue lab overrun`, `margin plus minus`,
  `label ends-before-column text-at-column`, `right flush`,
  `push swapped restored`, `latex columns bold italic math` — ALL true; live
  edit's 6 block frames all `laid=true`. The demo's `Guide/Tabbing.md`:
  6 blocks, 6 laid.
- **Scene PDF two frames deep** — a save posted from the viewer's own
  realm is answered by `window.top`; reported dirty, the viewer receives
  exactly 1 `pdf-flush` from the app page's `flushAllPdf` (found through
  the `parent` chain), and the flush resolves in 3 ms once it reports clean.
- **Map measuring** — upstream's `smoke/map-measure-frame.js` with
  synthetic shift-clicks: `measured 1/1`, `third 1/0`, `fourth 1/1`,
  `esc 0/0 claimed=true`, `esc-idle claimed=false` — as desktop. (`real`
  needs real input.)
- **Watchdog** — a note cloned into a second pane (a fresh, possibly moved
  frame): both documents receive the re-renders of an edit and of its
  revert (render#1/#2 in each) — both bridges up.
- **Kanban** — upstream's `smoke/kanban-width-frame.js`: every column
  reachable, `hit-test=true`, overlay scrollbar (iOS), on both boards. BUT
  see the finding.
- **Regression** (last night's p4 checks, rerun): sids and token refusals
  as desktop, block citations, engine-rendered callout cards (canvas tab
  and a note's scene), toolbar 2 rows / forced short 1 row, the preview
  pane's pass-through, the Excalidraw library survives (1→1→1), the
  consumer sweep matches the baseline, sandboxed frames read nothing.

## Findings (neither blocks; both upstream candidates)

1. **WebKit does not widen a kanban board whose cards are short.** The
   rule sizes `.clew-kanban` `width: max-content`; `.kanban-col` is
   `flex: 1 0 190px`. WebKit's max-content for the flex container sums the
   CARDS' content widths, not the 190 px basis, so Board4 stays at
   `min-width: 100%` (704 px, 3 of 4 columns, scrolls) — desktop's
   "before" state; Board7 (wider content) hits the 794 px cap as intended.
   Measured fix: `.kanban-col { min-width: 190px }` (min-width enters the
   intrinsic size in both engines) → Board4 794 px, the cap. In a portrait
   826 px pane 4 × 190 + gaps still just overflows; landscape fits.
2. **The map distance tool has no touch route** — it is shift-click only,
   so a finger cannot measure (a hardware keyboard + trackpad can).

## The iPad only

A real finger pan of an overflowing kanban board (an ordinary element
scroller); a real annotation save from a scene PDF; measuring with a
keyboard and trackpad attached.
