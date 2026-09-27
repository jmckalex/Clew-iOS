// The one layout difference between the golden master and this mirror that
// an import can see: upstream keeps its engine at <repo>/vendor/jmarkdown
// and the app at <repo>/src, so a renderer module reaches the engine with
// `../../../../vendor/jmarkdown/src/x.js`. Here the app is mirrored one
// level deeper (<repo>/vendor/clew), so that same relative path lands on a
// vendor/vendor/… that does not exist. scripts/build.js rewrites it for the
// bundles (rendererPatches#onResolve); this hook is the same rule for the
// test suites, which import the vendored sources directly under Node.
//
// Scope is deliberately narrow: a `(../)+vendor/jmarkdown/` specifier from a
// file under vendor/clew/. Nothing else is touched.
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const vendorClew = pathToFileURL(path.join(root, 'vendor', 'clew') + path.sep).href;
const RE = /^(?:\.\.\/)+vendor\/jmarkdown\/(.+)$/;

export function resolve(specifier, context, next) {
	const m = RE.exec(specifier);
	if (m && context.parentURL?.startsWith(vendorClew)) {
		return next(pathToFileURL(path.join(root, 'vendor', 'jmarkdown', m[1])).href, context);
	}
	return next(specifier, context);
}
