/*
	CommonJS preload for the watch worker (`node --require watch-fs-preload.cjs`).

	Patches the fs read functions BEFORE any ESM module links 'fs'. This matters
	because `import { readFileSync } from 'fs'` (a named import, used by
	file-inclusion.js and others) binds to a snapshot of fs's exports taken when
	the 'fs' namespace is first linked — reassigning `fs.readFileSync` from inside
	an ESM module afterwards would NOT be seen by those named imports. Running as a
	-r preload guarantees the patch is in place before the snapshot is taken, so
	every read — default-import or named-import — is recorded.

	Recorded paths land in a global Set that dep-tracker.js reads.
*/
const fs = require('fs');
const path = require('path');
const { fileURLToPath } = require('url');

const deps = (global.__JMD_DEPS = global.__JMD_DEPS || new Set());

function note(p) {
	if (typeof p === 'string') { try { deps.add(path.resolve(p)); } catch (e) { /* ignore */ } }
	else if (p instanceof URL) { try { deps.add(path.resolve(fileURLToPath(p))); } catch (e) { /* ignore */ } }
	// numeric fds / Buffers are not file paths — ignore.
}

function wrap(orig) {
	return function (p, ...rest) { note(p); return orig.apply(this, [p, ...rest]); };
}

fs.readFileSync = wrap(fs.readFileSync);
fs.readFile = wrap(fs.readFile);
if (fs.promises && fs.promises.readFile) {
	const orig = fs.promises.readFile;
	fs.promises.readFile = function (p, ...rest) { note(p); return orig.apply(this, [p, ...rest]); };
}
