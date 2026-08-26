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
 * @param {{vaultRoot?: string, vaultOptions?: Record<string, any>}} opts
 */
export function engineConfig({ vaultRoot = '/vault', vaultOptions = {} } = {}) {
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
			'queryFence, tasksFence, kanbanFence from /engine-assets/query-fences.js',
			'tableBeforeAnchor, blockAnchorLine, blockAnchor from /engine-assets/block-refs.js',
			// Obsidian's Dataview, for vaults that arrive carrying it.
			'dataviewFence, dataviewJsFence, dataviewInline from /engine-assets/dataview.js',
			// Obsidian Bases. The `![[X.base]]` embed path lives in
			// wikilinks.js; this registers the inline ```base fence.
			'baseFence from /engine-assets/bases.js',
			// LAST on purpose, exactly as upstream: marked offers the most
			// recently registered block extension first, and calloutBlock must
			// be seen before the engine's own GFM-alert rule so that every
			// `> [!type]` — the five GFM ones included — renders identically.
			'calloutBlock from /engine-assets/callouts.js',
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
 */
export function engineEnv({ vaultRoot = '/vault', sessionId = '', vaultOptions = {} } = {}) {
	return {
		CLEW_VAULT_ROOT: vaultRoot,
		CLEW_SESSION_ID: sessionId ?? '',
		CLEW_DATAVIEW_JS: vaultOptions.dataviewJs === true ? '1' : '',
	};
}
