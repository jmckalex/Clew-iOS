---
tags: [guide]
---
# Plugins

Clew vaults can carry **plugins**: folders under `.clew/plugins/<id>/`
that extend the app. Plugins travel *with the vault* (share the folder,
share the behavior), and every plugin is **off until you enable it** in
Settings → This vault — a plugin is arbitrary code, so enabling one is a
statement of trust, exactly like the note API toggle.

This very vault ships three: **Note Headers**, a preview surface that
draws the banner on [[Welcome]] and can run a whole animated HTML page
behind it ([[Note Headers]]); **Word Count**, the app surface whose
manifest and code appear below; and **Charts**, an engine + preview
pair — the engine surface parses ` ```chart ` fences into Chart.js
configurations, the preview surface draws them ([[Charts]]). Its folder
is the worked example for a plugin that adds *syntax*.

## The three surfaces

A plugin extends Clew at up to three seams, declared in its manifest:

- **engine** — a jmarkdown extension module loaded into the render
  worker. This is the most powerful surface for *syntax*: new fences,
  inline directives, block transforms — the same mechanism Clew itself
  uses for `[[wikilinks]]` and ```` ```leaflet ```` maps. Runs
  out-of-process in the one-shot worker, so a broken extension can't
  take the app down.
- **preview** — a plain script injected into every rendered note, after
  Clew's preview client. It decorates the *rendered document*: read the
  DOM, restyle it, add widgets. Re-apply work on the `clew:render`
  event (fired after every live update), and use the `window.clew` note
  API if that gate is also on.
- **app** — a script run in the app itself against a small, versioned
  API (`clew.apiVersion` = 1): register palette/hotkey commands, read
  and write vault files, open notes, listen to vault/workspace events,
  and show notices. Deliberately narrow — plugins get a stable contract,
  not the app's internals.

## Anatomy

```
.clew/plugins/word-count/
├── manifest.json
├── engine.js      (optional)
├── preview.js     (optional)
└── app.js         (optional)
```

`manifest.json`:

```
{
	"id": "word-count",
	"name": "Word Count",
	"version": "1.0.0",
	"description": "What it does, for the settings screen.",
	"apiVersion": 1,
	"surfaces": {
		"engine": { "file": "engine.js", "extensions": "myFence" },
		"preview": "preview.js",
		"app": "app.js"
	}
}
```

The folder name must equal `id`. An engine surface names its exports —
marked extension objects — in `extensions`.

## Writing each surface

**engine.js** exports marked-style extensions (see the jmarkdown docs):

```
export const myFence = {
	name: 'myFence', level: 'block',
	start(src) { return src.match(/^```my/m)?.index; },
	tokenizer(src) { /* … */ },
	renderer(token) { return '<div class="my">…</div>'; },
};
```

**preview.js** is a plain script in the rendered document:

```
(() => {
	const apply = () => {
		for (const h2 of document.querySelectorAll('h2')) h2.dataset.decorated = '1';
	};
	document.addEventListener('clew:render', apply);
	apply();
})();
```

**app.js** receives one binding, `clew`:

```
clew.commands.register({
	id: 'count', name: 'Word count of this note', hotkeys: ['Mod-Alt-w'],
	run: async () => {
		const path = clew.workspace.activePath();
		const text = await clew.vault.read(path);
		clew.ui.notice(`${text.split(/\s+/).length} words`);
	},
});
```

Commands appear in the palette and the hotkey editor automatically,
namespaced as `plugin:<id>:<command>`. Everything a plugin registers is
unwound when the vault closes or the plugin is disabled.

## Vault scripts (lighter than plugins)

Just want shared JavaScript in your notes — custom elements, helper
functions? Drop `.js` files into `.clew/scripts/` and every rendered
note loads them (alphabetically), no manifest needed — the JS twin of
the `.clew/snippets/` CSS convention. A single note can also pull in a
script with jmarkdown's own metadata header:

```
---
Script: ./my-element.js
---
```

Custom elements render their own content, and Clew's live updates
respect that: a re-render keeps your element and syncs its attributes
(firing `attributeChangedCallback`) instead of wiping its DOM.

## Notes

- Toggling a plugin re-renders open previews; if a preview surface
  doesn't appear, reopen the note's tab.
- The [[Note API]] is the *in-note* scripting story (a note controlling
  the app); plugins are the *vault-wide* one. They compose.
- There is no sandbox: engine surfaces run with Node in the worker, app
  surfaces run in the app. Enable plugins only in vaults you trust.
