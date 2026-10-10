// Stage mp-tikz-wasm into mptikz-assets/ — the wasm MetaPost/TeX engines
// (MetaPost 2.11, pdfTeX, LuaTeX, dvisvgm) and the TeX bundles their
// kpathsea reads, which typeset TikZ / MetaPost / LaTeX / plain TeX figures
// IN the preview document (vendor/clew/preview-client/figures.js loads the
// library's auto.js from /__clew_assets__/mptikz/).
//
// The iOS twin of upstream's scripts/stage-mptikz.js, with one more source:
// the tree upstream itself staged. Sources, in order — the master build
// first, as upstream's own paths.js prefers it in dev, because that is
// where work done upstream (the `opentype` bundle, a luaotfload patch)
// lands first, and upstream's staged copy can lag it by a day —
//
//   1. MPTIKZ_SRC, when set (a staging test, or a machine laid out differently)
//   2. ~/Source/mp-tikz-wasm/dist  — the owner's master build
//   3. ../Clew-app/mptikz-assets   — what upstream staged (the master's build
//                                    or the pin, whichever it found)
//   4. the SHA256-pinned GitHub release named in the VENDORED
//      vendor/clew/shared/mptikz-manifest.json — so the pin is upstream's,
//      never a second copy that could drift
//
// Why the engines ship in the app bundle rather than downloading on demand
// (the CJK-fonts / ZetaOffice shape): iOS has no downloader yet, the release
// is a .tar.gz Foundation cannot unpack, and a figure in a note must simply
// render. ~70 MB on the listing is the cost (UPSTREAM-0.11-PLAN.md §2).
//
// mptikz-assets/ is gitignored; `npm run build` (scripts/build.js
// #stageStatic) copies it into dist/webroot/preview-assets/mptikz, minus
// type declarations and source maps. --require makes a missing build a hard
// failure — what ios/ci_scripts/ci_post_clone.sh passes, so Xcode Cloud never
// ships an app whose figures cannot typeset. --force restages regardless.
//
// From 0.4.0 the release pins a SECOND archive beside the engines,
// `manifest.ghostscript`: Ghostscript's module (ghostscript/gs.mjs +
// gs.wasm, GNU AGPL v3, which upstream ships apart). It is SHA256-verified
// like the first and unpacked into the same tree. --no-ghostscript leaves it
// out (preview-client/figures.js then treats PostScript as unavailable: it
// asks for it only when ghostscript/SOURCE.md is there). --release skips
// the local candidates and stages the pinned release itself.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENGINE_TIKZ_LIBRARIES, UNBUNDLED_TIKZ_LIBRARIES } from '../vendor/clew/engine/figures.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'vendor', 'clew', 'shared', 'mptikz-manifest.json'), 'utf8'));
const dest = path.join(root, 'mptikz-assets');
const stamp = path.join(dest, 'STAGED.json');
const required = process.argv.includes('--require');
const force = process.argv.includes('--force');
const fromRelease = process.argv.includes('--release');
const withGhostscript = !process.argv.includes('--no-ghostscript');

const isBuild = (dir) => fs.existsSync(path.join(dir, 'index.js')) && fs.existsSync(path.join(dir, 'bundles'));

const candidates = fromRelease ? [] : [
	process.env.MPTIKZ_SRC,
	path.join(os.homedir(), 'Source', 'mp-tikz-wasm', 'dist'),
	path.resolve(root, '..', 'Clew-app', 'mptikz-assets'),
].filter((dir) => dir && isBuild(dir));

function staged() {
	try { return JSON.parse(fs.readFileSync(stamp, 'utf8')); } catch { return null; }
}

/**
 * The identity of a copied tree: which files, how fresh. bundles/index.json
 * and hot.json are in the list because the engines and the TeX bundles are
 * rebuilt SEPARATELY upstream, and a bundles-only rebuild must not look
 * "already current" here (upstream's lesson with spath3).
 */
function identityOf(from) {
	// bundles/index.json is in the list because bundles are rebuilt separately
	// from the engines upstream (adding `opentype` was exactly that).
	const mtimes = ['index.js', 'mplib.wasm', 'tex.wasm', 'dvisvgm.wasm', 'luatex.wasm',
		path.join('bundles', 'index.json'), path.join('bundles', 'hot.json'), path.join('ghostscript', 'gs.wasm')]
		.map((f) => { try { return fs.statSync(path.join(from, f)).mtimeMs; } catch { return 0; } });
	// Upstream's own stamp, when the source is its staged tree: says whether
	// THAT came from the master or the pin.
	let via = null;
	try { via = JSON.parse(fs.readFileSync(path.join(from, 'STAGED.json'), 'utf8')); } catch { /* not a staged tree */ }
	return { source: 'copy', from, describe: via ? `${via.source}: ${via.describe ?? via.from}` : from, mtimes };
}

const sameIdentity = (a, b) => !!a && !!b && a.source === b.source && a.from === b.from
	&& JSON.stringify(a.mtimes ?? a.sha256) === JSON.stringify(b.mtimes ?? b.sha256);

function copyTree(from) {
	fs.rmSync(dest, { recursive: true, force: true, maxRetries: 3 });
	fs.mkdirSync(dest, { recursive: true });
	fs.cpSync(from, dest, {
		recursive: true,
		// Maps and type declarations are a third of the JavaScript and nothing
		// here reads them; the source tree's own stamp and download cache are
		// its business, not ours.
		filter: (src) => !/\.(js\.map|d\.ts)$/.test(src)
			&& path.basename(src) !== 'STAGED.json' && path.basename(src) !== '.cache'
			&& (withGhostscript || path.relative(from, src).split(path.sep)[0] !== 'ghostscript'),
	});
}

function countFiles(dir) {
	let n = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) n += 1;
	}
	return n;
}

function report(identity) {
	const files = countFiles(dest);
	fs.writeFileSync(stamp, JSON.stringify({ ...identity, staged: new Date().toISOString(), files }, null, '\t'));
	console.log(`stage-mptikz: ${files} files in mptikz-assets/ (${identity.describe})`);
	checkDirectiveLibraries(identity);
}

/**
 * Does the staged tree carry every TikZ library the DIRECTIVES preload?
 * `:::TiKZ` / `@begin(TiKZ)` emit the whole list on every figure and ONE
 * \usetikzlibrary that cannot be found takes the figure down — so a bundle
 * missing one name breaks every directive figure in every vault. The names
 * come from the vendored figures.js: one source of truth with the renderer
 * and the tests. A refusal under --require, a warning otherwise.
 */
function checkDirectiveLibraries(identity) {
	const bundles = path.join(dest, 'bundles');
	if (!fs.existsSync(bundles)) return;
	const names = new Set();
	for (const entry of fs.readdirSync(bundles, { withFileTypes: true, recursive: true })) {
		if (entry.isFile()) names.add(entry.name);
	}
	const missing = ENGINE_TIKZ_LIBRARIES.split(',').filter((lib) =>
		!UNBUNDLED_TIKZ_LIBRARIES.has(lib)
		&& !names.has(`tikzlibrary${lib}.code.tex`)
		&& !names.has(`pgflibrary${lib}.code.tex`));
	if (!missing.length) return;
	const message = `stage-mptikz: the staged bundles (${identity.describe}) are missing ${missing.length} TikZ `
		+ `librar${missing.length === 1 ? 'y' : 'ies'} the :::TiKZ / @begin(TiKZ) directives preload:\n`
		+ `  ${missing.join(', ')}\nEvery directive figure would fail, not just the ones using them. `
		+ `Re-stage from a build that carries them, or name them in UNBUNDLED_TIKZ_LIBRARIES upstream.`;
	if (required) { console.error(message); process.exit(1); }
	console.warn(message);
}

// ---- 1–3. a build already on this machine ----------------------------------

if (candidates.length) {
	const from = candidates[0];
	const identity = identityOf(from);
	if (!force && sameIdentity(staged(), identity)) {
		console.log(`stage-mptikz: mptikz-assets/ already current with ${identity.describe}; nothing to do.`);
		process.exit(0);
	}
	copyTree(from);
	report(identity);
	process.exit(0);
}

// ---- 4. the pinned release --------------------------------------------------
// The main archive, and — from 0.4.0 — Ghostscript's module as an archive of
// its own (`manifest.ghostscript`), whose dist/ghostscript/ unpacks into the
// same tree. Each is SHA256-pinned and verified; a manifest without the
// second, or --no-ghostscript, stages the first alone. Upstream's
// scripts/stage-mptikz.js, with this repo's cache folder.

const cache = path.join(root, 'build', 'mptikz-cache');
const assets = [manifest, withGhostscript ? manifest.ghostscript : null].filter(Boolean);
const pins = assets.map((a) => a.sha256);

function sha256(file) {
	return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function download(asset, file) {
	console.log(`stage-mptikz: fetching ${asset.url} (${Math.round(asset.bytes / 1e6)} MB)…`);
	const res = await fetch(asset.url, { redirect: 'follow' });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
	fs.mkdirSync(cache, { recursive: true });
	fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
}

/** The asset's archive in the cache, fetched if need be and VERIFIED. */
async function verified(asset) {
	const file = path.join(cache, asset.archive);
	if (!fs.existsSync(file)) await download(asset, file);
	const digest = sha256(file);
	if (digest !== asset.sha256) {
		// REFUSE rather than "probably fine": the pin names one exact file.
		fs.rmSync(file, { force: true });
		throw new Error(`SHA256 mismatch for ${asset.archive}\n  expected ${asset.sha256}\n  got      ${digest}`);
	}
	return file;
}

const current = staged();
if (!force && current?.source === 'release' && current.version === manifest.version
	&& JSON.stringify(current.archives ?? [current.sha256]) === JSON.stringify(pins) && isBuild(dest)) {
	console.log(`stage-mptikz: mptikz-assets/ already holds the pinned ${manifest.version}; nothing to do.`);
	process.exit(0);
}

try {
	const files = [];
	for (const asset of assets) files.push(await verified(asset));
	const unpacked = path.join(cache, 'unpacked');
	fs.rmSync(unpacked, { recursive: true, force: true });
	fs.mkdirSync(unpacked, { recursive: true });
	// dist/ inside each archive IS (part of) the tree, two components deep.
	assets.forEach((asset, i) => {
		execFileSync('tar', ['xzf', files[i], '-C', unpacked, '--strip-components=2', asset.unpackedDir], { stdio: 'inherit' });
	});
	copyTree(unpacked);
	fs.rmSync(unpacked, { recursive: true, force: true });
	report({
		source: 'release', version: manifest.version, from: manifest.url,
		describe: `pinned ${manifest.tag}${assets.includes(manifest.ghostscript) ? ' + ghostscript' : ''}`,
		sha256: manifest.sha256, archives: pins,
	});
} catch (err) {
	const message = `stage-mptikz: no mp-tikz-wasm build staged — ${String(err.message ?? err)}`;
	if (required) {
		console.error(`${message}\n\nBuilding without it would ship an app that cannot typeset a TikZ or\nMetaPost figure. Stage a build (see the header of this script), then re-run.`);
		process.exit(1);
	}
	console.log(`${message}\nFigures will not render until this succeeds (vendor/clew/preview-client/figures.js says so in the figure's place).`);
}
