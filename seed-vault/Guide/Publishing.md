---
tags: [guide]
---
# Publishing

**File → Export → Vault as Website…** compiles the whole vault into a
static website: every note becomes an `.html` page (wikilinks turn into
real relative links, `[[Note#Heading]]` anchors included), attachments
copy over in place, and an `assets/` folder carries everything the
pages need — MathJax, mermaid, Leaflet, the preview stylesheet. The
result is a folder you can drop onto ANY web host (or open straight
from disk): no server code, no build step, no subscription.

What survives the trip:

- **All rendering** — math, theorems, citations, diagrams, footnotes,
  alerts, media embeds, image sizes.
- **Interactive maps** — Leaflet loads from the exported assets; photo
  maps keep their pins and popups.
- **Queries, tasks, and kanban boards** — baked to their state at
  export time. A published dashboard is a snapshot of the vault the
  moment you exported, which is exactly what a website should be.
- **Vault scripts** — `.clew/scripts/*.js` custom elements ship with
  the site and run on every page.

What deliberately doesn't: anything that *writes* (editable cells,
kanban drags, task toggles — the site has no vault to write to), canvas
embeds (shown as a labeled box), and plugins.

The home page: `Welcome.md` (or `Start Here.md`, `Home.md`,
`index.md`) becomes `index.html`.

Try it on this vault — or on `study-vault/`, which turns into a rather
nice little site about running a term.
