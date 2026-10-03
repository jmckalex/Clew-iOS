// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Vault → static website (File → Export Vault as Website): every note
// renders through the engine with CLEW_SITE_EXPORT set (wikilinks become
// real relative hrefs; media URLs come out under the /@@SITE@@/ marker via
// the usual session mechanism) and lands as <out>/<note path>.html, with
// attachments copied alongside and the handful of runtime assets (MathJax,
// mermaid, leaflet, highlight css, preview.css, site-client) under assets/.
// Queries and tasks bake to their render-time results — a published
// dashboard is a snapshot, which is exactly right for a website. TikZ and
// MetaPost figures bake too (figure-bake.js): the SVG goes into the page, so
// a published site needs no wasm and no TeX.
//
// Workers: same one-shot fork discipline as the render service, with the
// next worker warming while the current note builds, so an N-note vault
// costs ~one warm-up total, not N.
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './paths.js';
import { settings } from './settings.js';
import { compileExcludes } from './vault-excludes.js';
import { readNoteFonts } from './note-fonts.js';
import { calloutsEnv } from './callout-types.js';
import { toolchainPath } from './render-service.js';
import { enabledPlugins, previewPluginScripts } from './plugins.js';
import { bakeFigures, figureEngineAvailable, hasFigures } from './figure-bake.js';
import { siteFiles, staticAppEmbeds, NOTE_EXT } from './site-files.js';

const SITE_MARK = '@@SITE@@';

// `access` is the window's effective access (vault-trust.js#effectiveAccess):
// a site bakes what the vault's previews show on THIS device, so a vault this
// device has not trusted exports without its scripts, its own plugins and
// dataviewjs, as its previews render without them (frame-bridge.md §4.4).
export async function exportSite({ vaultRoot, engineDir, outDir, distDir, vaultOptions = {}, access = { trusted: false, plugins: [] }, onProgress = () => {} }) {
	fs.mkdirSync(outDir, { recursive: true });

	// What goes out (site-files.js): what the explorer shows, without Clew's
	// machinery and without private state — clewdata.json and every app's
	// data/ folder — and, in a restricted vault, nothing a link reaches
	// outside it. `hidden` is not in the vault as far as Clew is concerned;
	// `unindexed` is listed and openable, so it goes out with the rest.
	const { notes, files } = siteFiles(vaultRoot, { excludes: compileExcludes(vaultOptions), trusted: Boolean(access.trusted) });

	// One-shot workers with overlap: spawn the next while this one builds.
	const spawnWorker = () => {
		const child = fork(paths.engineWorker, [], {
			cwd: engineDir,
			stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
			env: {
				...process.env,
				PATH: toolchainPath(),
				CLEW_VAULT_ROOT: vaultRoot,
				CLEW_VAULT_RESTRICTED: access.trusted ? '' : '1',
				CLEW_SESSION_ID: SITE_MARK,
				CLEW_SITE_EXPORT: '1',
				// The same per-vault gate the live render service passes — an
				// exported site bakes what the vault's previews show.
				CLEW_DATAVIEW_JS: access.dataviewJs ? '1' : (access.trusted ? '' : 'restricted'),
				// The note's typeface, for a `font=note` figure's wrapper
				// (engine/figures.js#noteFontPreamble): the preamble names the
				// face BY FILE, so a worker without this emits fontspec with no
				// \setmainfont and the figure is baked in Latin Modern — while
				// figure-bake.js dutifully hands the engine face files nothing
				// references. Measured 2026-09-18 on one exported line: the
				// baked viewBox was 194.32 x 9.08 without this (fontspec's own
				// Latin Modern) and 197.51 x 10.04 with it — the same figure
				// the preview shows.
				CLEW_NOTE_FONTS: JSON.stringify(readNoteFonts(paths.noteFonts)?.faces ?? {}),
				// The named TeX fragments a `clew-fragments=` figure asks for,
				// both scopes, exactly as the live render service passes them:
				// a figure refused here would bake its refusal into the page.
				CLEW_TEX_FRAGMENTS: JSON.stringify({
					global: settings.get('texFragments') ?? [],
					vault: vaultOptions.texFragments ?? [],
				}),
				// Custom callout types, as the live render service passes them:
				// the page carries each one's colour on the element, so the
				// exported site needs no stylesheet of its own for them.
				CLEW_CALLOUTS: calloutsEnv(settings.get('callouts'), vaultOptions.callouts, paths.faIcons),
			},
		});
		child.stdout.on('data', () => {});
		child.stderr.on('data', () => {});
		const ready = new Promise((resolve, reject) => {
			child.on('message', (msg) => { if (msg?.type === 'ready') resolve(child); });
			child.once('exit', () => reject(new Error('site worker died during warm-up')));
			child.once('error', reject);
		});
		ready.catch(() => {});
		return { child, ready };
	};

	let standby = spawnWorker();
	const tmp = path.join(outDir, '.clew-site-tmp.html');
	const failures = [];
	// Pages carrying a TikZ/MetaPost figure, typeset after the notes are
	// written (one engine for the whole export).
	const figurePages = [];
	for (let i = 0; i < notes.length; i++) {
		const rel = notes[i];
		onProgress({ done: i, total: notes.length, note: rel });
		const worker = standby;
		standby = spawnWorker();
		try {
			const child = await worker.ready;
			const result = await new Promise((resolve) => {
				child.on('message', (msg) => {
					if (msg?.type === 'done' || msg?.type === 'error') resolve(msg);
				});
				child.once('exit', (code) => resolve({ type: 'error', message: `worker exited (${code})` }));
				child.send({
					type: 'build',
					file: path.join(vaultRoot, rel),
					options: {
						to: 'html',
						output: tmp,
						normalSyntax: vaultOptions.normalSyntax === true,
					},
				});
			});
			if (result.type !== 'done') throw new Error(result.message);
			const html = fs.readFileSync(tmp, 'utf8');
			const outFile = path.join(outDir, rel.replace(NOTE_EXT, '.html'));
			fs.mkdirSync(path.dirname(outFile), { recursive: true });
			const page = finishPage(html, rel, vaultRoot, access);
			fs.writeFileSync(outFile, page);
			if (hasFigures(page)) figurePages.push(outFile);
		} catch (err) {
			failures.push({ note: rel, message: String(err.message ?? err) });
		}
	}
	standby.child.kill();
	fs.rmSync(tmp, { force: true });

	// Attachments and other plain files, structure preserved.
	for (const rel of files) {
		const target = path.join(outDir, rel);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.copyFileSync(path.join(vaultRoot, rel), target);
	}

	// Figures: typeset once each and written into the pages. A vault with no
	// figures never loads the engines; a machine with no staged build says so
	// rather than publishing pages that show their own source as text.
	if (figurePages.length) {
		if (figureEngineAvailable(paths.mptikzAssets)) {
			onProgress({ done: notes.length, total: notes.length, note: 'typesetting figures…' });
			try {
				const baked = await bakeFigures(figurePages, paths.mptikzAssets, ({ done, total }) => {
					onProgress({ done: notes.length, total: notes.length, note: `figure ${done} of ${total}…` });
				}, { noteFontsDir: paths.noteFonts });
				if (baked.failed) {
					failures.push({ note: `${baked.failed} figure(s)`, message: 'did not typeset; the page shows the error log instead' });
				}
			} catch (err) {
				failures.push({ note: 'figures', message: `not typeset: ${String(err.message ?? err)}` });
			}
		} else {
			failures.push({
				note: 'figures',
				message: `${figurePages.length} page(s) hold a TikZ/MetaPost figure, but no mp-tikz-wasm build is installed to typeset them`,
			});
		}
	}

	copyAssets(outDir, vaultRoot, distDir, access);

	// index.html: the vault's home note, already exported at depth 0.
	for (const home of ['Welcome.md', 'Start Here.md', 'Home.md', 'index.md', notes[0]]) {
		if (home && notes.includes(home) && !home.includes('/')) {
			const page = path.join(outDir, home.replace(NOTE_EXT, '.html'));
			if (fs.existsSync(page)) fs.copyFileSync(page, path.join(outDir, 'index.html'));
			break;
		}
	}

	onProgress({ done: notes.length, total: notes.length, note: null });
	return { notes: notes.length, files: files.length, failures };
}

/** Relativize marker URLs and wire in the static runtime. */
function finishPage(html, rel, vaultRoot, access) {
	const depth = rel.split('/').length - 1;
	const prefix = depth === 0 ? '' : '../'.repeat(depth);
	// An app has no bridge, origin or grant on a website: its box says so.
	let out = staticAppEmbeds(html)
		.split(`/${SITE_MARK}/`).join(prefix || './')
		// sitePath percent-encodes the marker (@ → %40) in URLs it builds.
		.split(`/${encodeURIComponent(SITE_MARK)}/`).join(prefix || './')
		.split('/__clew_assets__/').join(`${prefix || './'}assets/`);
	// Vault scripts (.clew/scripts/*.js) ship with the site too.
	let vaultScripts = '';
	if (access.scripts) try {
		vaultScripts = fs.readdirSync(path.join(vaultRoot, '.clew', 'scripts'))
			.filter((f) => f.endsWith('.js')).sort()
			.map((f) => `<script src="${prefix || './'}assets/vault-scripts/${encodeURIComponent(f)}"></script>`)
			.join('');
	} catch { /* none */ }
	// Enabled plugins' preview surfaces ship too (engine surfaces already ran
	// in the worker; without this half their fences would land as inert divs).
	// Both scopes land in assets/plugins/<id>/ below, so the emitted src is
	// the same whether the plugin was installed in the vault or globally.
	const pluginScripts = previewPluginScripts(vaultRoot, access, paths.globalPlugins)
		.map((p) => `<script src="${prefix || './'}assets/plugins/${encodeURIComponent(p.id)}/${
			encodeURIComponent(p.file)}"></script>`)
		.join('');
	// Web Awesome widgets (Meta Bind) render disabled on a static page, but
	// they still need their definitions to LOOK like anything.
	const usesWa = /<wa-[a-z]/.test(out);
	const waRuntime = usesWa
		? `<link rel="stylesheet" href="${prefix || './'}assets/wa.css">`
			+ `<script src="${prefix || './'}assets/wa.js"></script>`
			+ `<script>document.documentElement.classList.add('wa-dark')</script>`
		: '';
	const runtime = `<script>window.__clewAssetBase=${JSON.stringify((prefix || './') + 'assets')}</script>`
		+ vaultScripts
		+ `<script src="${prefix || './'}assets/site-client.js"></script>`
		+ pluginScripts + waRuntime;
	return out.replace(/<\/body>/i, `${runtime}</body>`);
}

function copyAssets(outDir, vaultRoot, distDir, access) {
	const assets = path.join(outDir, 'assets');
	const nm = paths.previewAssets;
	const engineAssets = paths.engineAssets;
	const jobs = [
		[path.join(engineAssets, 'preview.css'), 'preview/preview.css'],
		[path.join(nm, 'mathjax', 'es5', 'tex-svg.js'), 'mathjax/tex-svg.js'],
		[path.join(nm, 'mermaid', 'dist', 'mermaid.min.js'), 'mermaid/mermaid.min.js'],
		[path.join(nm, 'highlight.js', 'styles', 'atom-one-dark.min.css'), 'highlight/atom-one-dark.min.css'],
		[path.join(nm, '@fortawesome', 'fontawesome-free', 'js', 'all.min.js'), 'fontawesome/all.min.js'],
		[path.join(nm, 'jquery', 'dist', 'jquery.min.js'), 'jquery/jquery.min.js'],
		[path.join(nm, 'leaflet', 'dist', 'leaflet.js'), 'leaflet/leaflet.js'],
		[path.join(nm, 'leaflet', 'dist', 'leaflet.css'), 'leaflet/leaflet.css'],
		[path.join(nm, 'leaflet', 'dist', 'images'), 'leaflet/images'],
	];
	for (const [from, to] of jobs) {
		if (!from || !fs.existsSync(from)) continue;
		const target = path.join(assets, to);
		fs.mkdirSync(path.dirname(target), { recursive: true });
		fs.cpSync(from, target, { recursive: true });
	}
	// The static runtime bundle (built to dist/preview-client; readable from
	// the asar in packaged apps because this runs in the main process).
	const siteClient = path.join(distDir, 'preview-client', 'site-client.js');
	if (fs.existsSync(siteClient)) fs.copyFileSync(siteClient, path.join(assets, 'site-client.js'));
	// Web Awesome bundle for Meta Bind widgets (finishPage links it only on
	// pages that carry a widget).
	for (const name of ['wa.js', 'wa.css']) {
		const from = path.join(distDir, 'preview-client', name);
		if (fs.existsSync(from)) fs.copyFileSync(from, path.join(assets, name));
	}
	// Vault scripts.
	const scriptsDir = path.join(vaultRoot, '.clew', 'scripts');
	if (access.scripts && fs.existsSync(scriptsDir)) {
		fs.cpSync(scriptsDir, path.join(assets, 'vault-scripts'), { recursive: true });
	}
	// Enabled plugins with a preview surface travel whole (a surface may load
	// siblings from its own folder — the Charts plugin fetches chart.umd.js).
	for (const plugin of enabledPlugins(vaultRoot, access, paths.globalPlugins)) {
		if (!plugin.surfaces.preview) continue;
		fs.cpSync(plugin.dir, path.join(assets, 'plugins', plugin.id), { recursive: true });
	}
}
