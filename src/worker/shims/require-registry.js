// What createRequire()('<id>') can answer inside the render worker.
//
// Nothing on a Worker's disk is requirable, so the module shim's require()
// throws for everything — except the ids listed here, which map onto
// modules the bundle already carries.
//
// highlight.js is here because vendor/clew/engine/figures.js registers a
// MetaPost grammar on the ENGINE's highlight.js by resolving from the worker
// script (`createRequire(process.argv[1] ?? import.meta.url)`); esbuild
// dedupes the package, so this is the same instance marked-highlight uses,
// and ```metapost show=code blocks highlight exactly as on desktop.
//
// citation-js is here because the engine's compile-time Biblify
// (vendor/jmarkdown/src/biblify-compile.js) requires it at import; without
// it every \cite rendered as an empty span and every bibliography as an
// empty div. Desktop requires the umbrella `citation-js` package, which also
// registers the DOI, RIS, BibJSON and Wikidata input plugins — 1.9 MB
// minified, 1.1 MB of it Wikidata's property tables. Biblify only ever hands
// Cite raw BibTeX and asks for CSL output, so the worker carries core + the
// BibTeX and CSL plugins (0.7 MB) under the umbrella's shape: the Cite
// constructor with the plugin registry as `Cite.plugins`, which is what
// biblify reads (`Cite.plugins.config.get('@csl')`).
//
// Imported by engine-worker.js BEFORE figures.js and the engine: an ES
// module's imports evaluate in order, and both figures.js and
// biblify-compile.js require at import time.
import hljs from 'highlight.js';
import { Cite, plugins } from '@citation-js/core';
import '@citation-js/plugin-bibtex';
import '@citation-js/plugin-csl';

Cite.plugins = plugins;

globalThis.__jmdRequireRegistry = {
	'highlight.js': hljs,
	'citation-js': Cite,
};
