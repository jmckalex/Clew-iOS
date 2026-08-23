---
tags: [guide]
---
# Note API

Rendered notes can be **programs**. When the note API is enabled for a
vault (Settings → *This vault*; on for this demo vault, **off by
default** everywhere else), every script tag in a note's markdown runs
in reading mode with a `window.clew` object that talks to the app.
The live examples: [[API Playground]], [[Habit Tracker]], and the
[[Adventure]] spread across three notes.

## The surface

All methods return promises.

- **Context** — `clew.context()` → `{path, vault, theme}`.
- **Query** — `clew.notes.list()` · `clew.notes.read(path)` ·
  `clew.index.get(path)` (headings/links/tags from the metadata cache) ·
  `clew.index.backlinks(path)` · `clew.search(query)` (full operator
  syntax) · `clew.properties.get(path)` (typed frontmatter).
- **Mutate** — `clew.notes.write / append / create` ·
  `clew.properties.set(path, key, value)` (`null` removes; refuses
  frontmatter beyond the editable subset).
- **App control** — `clew.open(target, opts)` with full wikilink
  semantics (`'Note#Heading'` works); `opts` takes `newTab` (default
  true) and `mode` (`'reading'` or `'source'`) to override the app's
  new-tab default — the [[Adventure]] navigates with
  `{ newTab: false, mode: 'reading' }` so play stays in one rendered
  tab · `clew.command(id)` — any command-palette command.
- **Shared state** — `clew.kv.get / set / delete / list(prefix)`, stored
  in **`clewdata.json` in the vault root** so app state travels with a
  shared or synced vault. Namespace your keys (`myapp:thing`). Keys are
  written sorted, so the file diffs and merges politely in git.
- **Events** — `clew.on('kv', ({key, value}) => …)` fires in *every*
  open preview and canvas embed on any change (that's what makes the
  vault feel like one app) · `clew.on('render', …)` after each in-place
  re-render · `clew.on('theme', …)`.

## Lifecycle facts

- Scripts run **once per document load**. Live edits morph the DOM in
  place without re-running scripts — your JS state survives typing! —
  and a `render` event (also a `clew:render` DOM event) fires after each
  morph. Bind clicks with **event delegation on `document`** and re-query
  elements inside handlers, and morphs can't strand you.
- Notes render in an isolated origin with no filesystem or Node access;
  everything goes through Clew's own vault-validated channels.
- **Exported HTML has no host**: feature-detect with
  `if (!window.clew) return;` and your note degrades to a static page.
  Calls made anyway reject after a timeout rather than hanging.
- Canvas note embeds get the same API — build a dashboard by dropping
  live notes onto a canvas.

## The shape of a vault app

Put an empty placeholder div in the note, then a script tag holding:

```
(async () => {
  if (!window.clew) return;
  async function build() {
    const state = await clew.kv.list('myapp:');
    document.getElementById('app').innerHTML = render(state);
  }
  document.addEventListener('click', async (e) => {
    if (e.target.dataset.myAction) await clew.kv.set('myapp:key', next);
  });
  clew.on('kv', ({ key }) => { if (key.startsWith('myapp:')) build(); });
  build();
})();
```

State in the store, a renderer, delegated clicks, a `kv` listener:
that skeleton scales from a counter to a spaced-repetition system.

One authoring quirk to know: the engine passes code spans and fenced
blocks through mostly unescaped, so a literal angle bracket inside code
opens a *real* HTML tag — a stray script tag written in prose can
swallow the rest of your note. Keep markup out of code examples (as the
skeleton above does) and name tags in words instead.

## A word on trust

With the API on, *opening a note runs its code*. The surface is
deliberately curated and vault-scoped, but treat the toggle like an
"install" button: enable it for vaults you wrote or trust, leave it off
for vaults you merely cloned.
