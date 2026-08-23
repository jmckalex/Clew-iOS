---
tags: [guide]
---
# Canvas

A **canvas** is an infinite board for arranging notes, files, web pages,
cards, connections, drawings, and shapes. Open [[Demo Canvas.canvas]] to
see one; create your own with **File → New Canvas** (also in the
palette and the explorer's right-click menu). Canvases are `.canvas`
files in the open [JSON Canvas](https://jsoncanvas.org) format, so they
open in Obsidian too — Clew's drawing and shape layers travel in a
`clew` extension key that other apps simply ignore.

## Getting around

- **Scroll** to pan; **pinch** or **⌘-scroll** to zoom at the cursor;
  **Space-drag** or the hand tool (**H**) to pan by hand.
- The controls at the bottom right zoom, reset, and **fit** (⇧1).
- Everything is draggable in the select tool (**V**). Click selects;
  shift-click adds; drag on empty canvas makes a marquee. **Backspace**
  deletes the selection. **⌘Z / ⇧⌘Z** undo and redo canvas edits.

## Things a canvas holds

- **Cards** — double-click empty canvas (or press **C**). Double-click a
  card to edit its text. Cards render through the engine itself: math
  typesets, alerts (`> [!NOTE]`), the full dialect — the same text
  renders identically in a card and in a note.
- **Notes** — the add-file toolbar button embeds any note as a *live jmarkdown
  preview*: math, mermaid, citations, checkboxes all work. Double-click
  a note to interact with it (scroll it, click its links, tick its
  checkboxes); Escape or a click outside returns to canvas mode.
  Right-click → *Open in tab* for full editing.
- **Images, PDFs, media** — the same add-file picker adds any vault file; PDFs
  get Chromium's full viewer.
- **Web pages** — the globe toolbar button embeds a live web page. Paste a URL anywhere on the
  canvas for the same effect.
- **Portals** — add a `.canvas` file to a canvas and it renders as a
  live miniature of that whole canvas. Double-click to jump into the
  real thing.
- **Connections** — hover a node and drag from a side dot to another
  node. Double-click a connection to label it; right-click to color it.
- **Groups** — select any two or more objects (cards, shapes, ink — they
  can be mixed) and press **⌘G**, or right-click → *Group*. Afterwards
  clicking any member selects the whole group, and dragging one moves
  them all as a unit. **⇧⌘G** ungroups. A group is a membership set, not
  a region: its members stay grouped however far apart you drag them.
- **Frames** — select several *cards* and right-click → *Enclose in
  frame* for a labelled box that carries whatever nodes sit inside it.
  This is Obsidian's own group node, so frames open there too; ink and
  shapes can't belong to one, which is what groups are for.

## Drawing and shapes

The pen (**P**) draws freehand ink; the eraser (**E**) removes strokes.
With the select tool, ink behaves like everything else: click a stroke
to select it (it picks up a glow), drag to move it, shift-click or
marquee to take several, and right-click for color, z-order, or delete.
Rectangle (**R**), ellipse (**O**), diamond (**D**), arrow (**A**), and
line (**L**) drag out shapes; **T** places standalone text (four font
families, any size — double-click to edit). The style bar under the
toolbar sets **stroke style** (solid/dashed/dotted), **sloppiness**
(architect/artist/cartoonist), **fill** (solid or hachure), and
**opacity** — for new shapes and for whatever is selected. Right-click
a shape for color, label, and **z-order** (front/forward/backward/
back); right-click a card for flowchart **node shapes** (pill, circle,
diamond, parallelogram, predefined process), border styles, and fills;
right-click a connection for **arrowheads** (→ ↔ —), dashed/dotted
lines, and **path routing** (curved, straight, or square — flowcharts).
Right-click empty canvas → *Clear drawing* wipes the ink layer.

## Canvases inside notes

`![[Demo Canvas.canvas]]` embeds a live, read-only view of a canvas in
any note — it re-renders whenever the canvas changes, and its title
link opens the real thing. It works like the canvas proper: scroll to
pan, pinch or ⌘-scroll to zoom, drag empty background to pan by hand,
double-click background to re-fit. Note previews scroll and click,
media plays, and web pages load live (when the site allows itself to
be framed):

![[Demo Canvas.canvas]]

## Good to know

- Nodes take one of six accent colors (right-click → swatches).
- Renaming a note updates every canvas that embeds it.
- The canvas auto-saves; ⌘Z history lives per open tab.
- Right-click empty canvas → *Export drawing as PNG…* saves the ink and
  shape layers as a transparent PNG (2× resolution).
