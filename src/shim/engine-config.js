// One source of truth for the two things every path into the engine worker
// has to agree on: which vault files are TEXT (and so enter the vfs snapshot
// with their bytes), and the jmarkdown config the worker reads at import time.
//
// This module is deliberately dependency-free — no bridge, no vfs, no DOM —
// so the Node-side harness (tools/render-note.mjs, and the test battery it
// backs) imports exactly what the app runs. Before this existed the harness
// carried its own hand-copied config, which silently went stale: the 0.8 sync
// added four engine extensions and the harness rendered notes without them,
// reporting green while callouts, dataview, bases and block refs did nothing.
//
// Mirrors vendor/clew/main/render-service.js #writeEngineConfig +
// #biblifyConfig. Extension paths here are REGISTRY KEYS, not filesystem
// paths: the build patches the engine's dynamic-import loader to consult
// globalThis.__jmdExtensionRegistry, which src/worker/engine-worker.js fills
// with the pre-bundled modules. Adding an extension means editing BOTH.

// `excalidraw` (plain-JSON drawings) and `base` (Obsidian Bases) are text:
// without them a drawing or a base mirrors as a binary stub — unindexed,
// unrenderable, unwritable through the vfs. (`.excalidraw.md` is already
// covered by `md`.)
export const TEXT_EXT = /\.(md|jmd|bib|canvas|json|css|js|mjs|txt|csl|xml|yaml|yml|svg|html|gpx|geojson|tex|bibtex|org|csv|excalidraw|base)$/i;

export const isTextPath = (rel) => TEXT_EXT.test(rel);

// The engine's named bibliography styles: three from @citation-js/plugin-csl,
// five bundled as CSL files in the engine's own csl/ directory. Anything else
// is a custom .csl the engine registers by basename.
const NAMED_BIB_STYLES = ['apa', 'chicago', 'harvard1', 'vancouver', 'bjps', 'ajp', 'econometrica', 'ergo'];

// Those five CSL files (biblify-compile.js#BUNDLED_TEMPLATES reads them from
// '<Jmarkdown app directory>/csl/', i.e. /engine/csl/ in the worker's vfs).
// The build copies them to webroot/engine/csl/ and the render service
// snapshots them into every worker, alongside the templates.
export const ENGINE_CSL_FILES = [
	'chicago-author-date-16th-edition.xml',
	'australasian-journal-of-philosophy.xml',
	'the-british-journal-for-the-philosophy-of-science.xml',
	'econometrica.csl',
	'ergo.csl',
];

// Vault-wide bibliography (vault-settings `bibliography` +
// `bibliographyStyle`), resolved against the mirror root — the vault's
// .bib/.csl files are text, so the snapshot already carries them. Per-note
// `Bibliography:` metadata still wins: headers run after the config file.
function biblifyConfig(vaultRoot, vaultOptions) {
	const bib = String(vaultOptions.bibliography ?? '').trim();
	if (!bib) return {};
	const abs = (p) => (p.startsWith('/') ? p : `${vaultRoot}/${p}`);
	const biblify = { 'bibliography': abs(bib), 'resolve': true };
	const style = String(vaultOptions.bibliographyStyle ?? '').trim();
	if (style) {
		if (NAMED_BIB_STYLES.includes(style)) {
			biblify['bibliography style'] = style;
		} else {
			const file = abs(style);
			const name = file.slice(file.lastIndexOf('/') + 1).replace(/\.csl$/i, '');
			biblify['bibliography style'] = name;
			biblify['template'] = { name, file };
		}
	}
	return { 'Biblify': biblify };
}

/**
 * The generated `.jmarkdown/config.json` contents, as an object.
 *
 * `engineExtensions` are enabled vault plugins' engine surfaces —
 * "exportA, exportB from <vaultRoot>/.clew/plugins/<id>/<file>" strings.
 * Both callers compute them with vendor/clew/main/plugins.js
 * #engineExtensionEntries (the app over the aliased vfs-backed fs, the Node
 * harness over the real one) so manifest reading has one implementation;
 * they are parameters here because this module stays dependency-free.
 * @param {{vaultRoot?: string, vaultOptions?: Record<string, any>,
 *          engineExtensions?: string[]}} opts
 */
export function engineConfig({ vaultRoot = '/vault', vaultOptions = {}, engineExtensions = [] } = {}) {
	return {
		// "jmarkdown project" vaults (the book manuscript case) re-enable the
		// engine's own-line [[file.md]] inclusion in previews.
		'File inclusion': vaultOptions.jmarkdownProject === true,
		// Pandoc-style [@key] / @key citations. Off unless the vault asks: @ is
		// the engine's directive sigil, so with this on a bare @word that is
		// not a registered directive becomes a citation key.
		'Pandoc citations': vaultOptions.pandocCitations === true,
		'Header style': 'fenced',
		'Template': '/engine/clew-template.html',
		'Extensions': [
			'wikiembed, wikilink from /engine-assets/wikilinks.js',
			'mermaidFence, leafletFence from /engine-assets/obsidian-fences.js',
			// TikZ, MetaPost, LaTeX and plain TeX typeset by mp-tikz-wasm in the
			// preview document (vendor/clew/engine/figures.js): the four fences
			// and the :::TiKZ directive. Listed here, i.e. loaded after the
			// engine's own rules, which is what lets the directive win.
			'tikzFence, metapostFence, latexFence, texFence, tikzDirective from /engine-assets/figures.js',
			'queryFence, tasksFence, kanbanFence from /engine-assets/query-fences.js',
			'tableBeforeAnchor, blockAnchorLine, blockAnchor from /engine-assets/block-refs.js',
			// Obsidian's Dataview, for vaults that arrive carrying it.
			'dataviewFence, dataviewJsFence, dataviewInline from /engine-assets/dataview.js',
			// Obsidian Bases. The `![[X.base]]` embed path lives in
			// wikilinks.js; this registers the inline ```base fence.
			'baseFence from /engine-assets/bases.js',
			// The Admonition plugin's ```ad-* fences (pre-callout vaults),
			// mapped onto callout tokens so callouts.js renders them.
			'admonitionFence from /engine-assets/admonitions.js',
			// Meta Bind's INPUT[…]/VIEW[…] widgets — editable cells that
			// live in prose, on the same field-edit write path.
			'metaBindInline, metaBindFence from /engine-assets/meta-bind.js',
			// Registered late on purpose, exactly as upstream: marked offers
			// the most recently registered block extension first, and
			// calloutBlock must be seen before the engine's own GFM-alert rule
			// so that every `> [!type]` — the five GFM ones included —
			// renders identically.
			'calloutBlock from /engine-assets/callouts.js',
			// After callouts (so it is offered first): a note whose
			// frontmatter declares `kanban-plugin` IS a board, and this
			// claims the whole body before any other rule can render it
			// as prose. Inert for every other note.
			'kanbanBoard from /engine-assets/kanban-board.js',
			// Enabled vault plugins' engine surfaces (custom syntax), named by
			// absolute vault path. The worker loads them from its vfs snapshot
			// (__jmdImportSource): they must be SELF-CONTAINED modules — a
			// blob/data import cannot resolve relative siblings, unlike
			// desktop's real-disk dynamic import.
			...engineExtensions,
		],
		// @begin(TiKZ) / @begin(metapost) are block ENVIRONMENTS: the engine
		// keys them by name and loads this line after its own registrations,
		// so these handlers replace the ones that shell out to a local TeX.
		// The engine's environment loader goes through the same patched
		// __jmdImport as Extensions, so the registry answers this key too.
		'Environments': [
			'TiKZ, metapost from /engine-assets/figures.js',
			// @reveal[…] — a presentation in an iframe. One registry entry
			// serves the inline, block and @begin forms (reveal-embed.js).
			'reveal from /engine-assets/reveal-embed.js',
		],
		...biblifyConfig(vaultRoot, vaultOptions),
		'MathJax': { 'src': '/__clew_assets__/mathjax/tex-svg.js' },
		'Mermaid': '/__clew_assets__/mermaid/mermaid.min.js',
		'Fontawesome': '/__clew_assets__/fontawesome/all.min.js',
		'Highlight src': '/__clew_assets__/highlight/atom-one-dark.min.css',
	};
}

/**
 * The env every engine worker spawns with. `CLEW_DATAVIEW_JS` is safe as
 * spawn-time env because reconfigure() discards the warm standby whenever
 * vault options change.
 *
 * `globalTexFragments` is the app-level `texFragments` setting (the
 * vault's own list rides in `vaultOptions`).
 *
 * `noteFonts` is the face → file map behind `font=note` figures
 * (vendor/clew/engine/figures.js#noteFontFaces reads it from
 * process.env.CLEW_NOTE_FONTS, upstream's own fallback for a worker with
 * no globals): the names must be exactly what the scheme handler serves
 * under __clew_assets__/notefonts/, because they land verbatim in the
 * figure's \setmainfont / \font lines. On iOS the bridge builds them from
 * CoreText (NoteFonts.swift); an empty map means fontspec's Latin Modern.
 */
export function engineEnv({
	vaultRoot = '/vault', sessionId = '', vaultOptions = {}, noteFonts = null, globalTexFragments = [],
} = {}) {
	return {
		CLEW_VAULT_ROOT: vaultRoot,
		CLEW_SESSION_ID: sessionId ?? '',
		CLEW_DATAVIEW_JS: vaultOptions.dataviewJs === true ? '1' : '',
		CLEW_NOTE_FONTS: noteFonts && Object.keys(noteFonts).length ? JSON.stringify(noteFonts) : '',
		// Named TeX fragments for `clew-fragments=` (engine/figures.js): both
		// scopes as they are stored, because engine/tex-fragments.js owns the
		// rule that a vault fragment shadows a global one — resolving it here
		// would be a second copy of that rule (upstream render-service.js,
		// verbatim). Editing either list reconfigures, which respawns the
		// standby so the env lands.
		CLEW_TEX_FRAGMENTS: JSON.stringify({
			global: Array.isArray(globalTexFragments) ? globalTexFragments : [],
			vault: Array.isArray(vaultOptions.texFragments) ? vaultOptions.texFragments : [],
		}),
	};
}
