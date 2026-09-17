// What createRequire()('<id>') can answer inside the render worker.
//
// Nothing on a Worker's disk is requirable, so the module shim's require()
// throws for everything (biblify catches that and degrades) — except the
// ids listed here, which map onto modules the bundle already carries.
// highlight.js is here because vendor/clew/engine/figures.js registers a
// MetaPost grammar on the ENGINE's highlight.js by resolving from the worker
// script (`createRequire(process.argv[1] ?? import.meta.url)`); esbuild
// dedupes the package, so this is the same instance marked-highlight uses,
// and ```metapost show=code blocks highlight exactly as on desktop.
//
// Imported by engine-worker.js BEFORE figures.js: an ES module's imports
// evaluate in order, and figures.js registers its grammar at import time.
import hljs from 'highlight.js';

globalThis.__jmdRequireRegistry = {
	'highlight.js': hljs,
};
