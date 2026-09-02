// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The ZetaOffice host page. Boots LibreOffice-in-wasm via zetajs, feeds
// it a vault document fetched as bytes (URL loaders would mangle the
// clew-preview scheme — pdf-core's lesson), and pushes saves back over
// the office-save bridge. Parameters:
//   ?src=<clew-preview URL of the document>   required
//   &path=<vault-relative path>               tab mode: save-back target
//   &noload=1                                 boot only, skip the document
//
// Without &path the page is the measurement rig: it auto-runs a store
// round-trip after load and never touches the vault.
//
// The office logic itself runs in the LOWA worker (zeta-thread.js, listed
// in Module.uno_scripts); this page owns fetch, the Emscripten FS, timing,
// and reporting. Timings go three ways at once: the #status overlay (so a
// screenshot carries them), window.__zetaReport (for frame scripts), and
// postMessage to window.top (for the smoke scenario, the office dock, and
// the save bridge — TOP, not parent, because this page also runs nested
// inside preview documents as a live `![[x.docx|live]]` embed, and the
// bridges live on the app page).
//
//   &thumb=1      thumbnail mode: chromeless LibreOffice (no menubar,
//                 toolbars or sidebar), no save-back, no status overlay —
//                 the offscreen thumbnailer (main/office-thumbs.js)
//                 captures the window once the document is up.
//
// Saving is LibreOffice's own explicit gesture (toolbar Save, Ctrl+S, or
// a 'zeta-save' message from the app): every store resets the model's
// modified flag, the thread reports the transition, and this page then
// reads the stored bytes out of the Emscripten FS and posts them to the
// app page — which is what makes disk the source of truth again. No
// debounced autosave on purpose: a half-edited spreadsheet is not a PDF
// annotation.

'use strict';

const ASSET_BASE = 'clew-preview://vault/__clew_assets__/zeta/';
const THREAD_URL = 'clew-preview://vault/__clew_assets__/clewzeta/zeta-thread.js';
const ZETA_URL = ASSET_BASE + 'zeta.js';

const params = new URLSearchParams(location.search);
const src = params.get('src');
const vaultPath = params.get('path'); // tab/embed mode; absent in the measure rig
const thumbMode = params.get('thumb') === '1';
const statusEl = document.getElementById('status');
const canvas = document.getElementById('qtcanvas');

const t0 = performance.now();
const report = { sab: typeof SharedArrayBuffer !== 'undefined' };
window.__zetaReport = report;
let thrPort = null; // the zetajs MessagePort, once soffice.js is up

const lines = [];
function status(line) {
	lines.push(line);
	statusEl.textContent = lines.join('\n');
}

function mark(name) {
	report[name] = Math.round(performance.now() - t0);
	status(`${name}: ${report[name]} ms`);
	tellParent({ cmd: 'zeta-progress', name, ms: report[name] });
}

function tellParent(msg) {
	try { window.top.postMessage(msg, '*'); } catch { /* no parent */ }
}

function fail(message) {
	report.error = String(message);
	status(`ERROR: ${report.error}`);
	tellParent({ cmd: 'zeta-error', message: report.error });
}

// Save filters by extension: store back in the format the file already
// has, named explicitly so LibreOffice never asks about "alien formats".
const FILTERS = {
	'.odt': 'writer8', '.ods': 'calc8', '.odp': 'impress8',
	'.docx': 'MS Word 2007 XML',
	'.xlsx': 'Calc MS Excel 2007 XML',
	'.pptx': 'Impress MS PowerPoint 2007 XML',
};

const ext = (src ?? '').replace(/^.*(\.[a-z0-9]+)$/i, '$1').toLowerCase();
const fsPath = '/tmp/office/document' + ext;

if (!report.sab) {
	fail('SharedArrayBuffer is not available — the pthreads build cannot run');
} else if (!src && !params.get('noload')) {
	fail('no ?src= document URL');
} else {
	boot();
}

async function boot() {
	let bytes = null;
	if (src) {
		const res = await fetch(src);
		if (!res.ok) return fail(`document fetch failed: ${res.status}`);
		bytes = new Uint8Array(await res.arrayBuffer());
		report.docBytes = bytes.length;
		mark('tFetched');
	}

	// The Emscripten Module global must exist before soffice.js runs.
	globalThis.Module = {
		canvas,
		uno_scripts: [ZETA_URL, THREAD_URL],
		locateFile: (path, prefix) => (prefix || ASSET_BASE) + path,
		// soffice.js is not in the page's own directory, so the pthread
		// workers need telling where to importScripts it from.
		mainScriptUrlOrBlob: new Blob(
			[`importScripts('${ASSET_BASE}soffice.js');`], { type: 'text/javascript' }),
		print: (text) => console.log('[soffice]', text),
		printErr: (text) => console.warn('[soffice]', text),
	};

	const soffice = document.createElement('script');
	soffice.src = ASSET_BASE + 'soffice.js';
	soffice.onerror = () => fail('soffice.js failed to load');
	soffice.onload = () => {
		mark('tSofficeJs');
		Module.uno_main.then((port) => {
			thrPort = port;
			port.onmessage = (e) => onThreadMessage(port, e.data, bytes);
		}, (err) => fail(`uno_main rejected: ${err}`));
	};
	document.body.appendChild(soffice);
	status(`loading soffice.js (doc: ${report.docBytes ?? 0} bytes)`);
}

function onThreadMessage(port, msg, bytes) {
	switch (msg.cmd) {
	case 'thr_running': {
		mark('tThreadRunning');
		if (!bytes) { tellParent({ cmd: 'zeta-ready', report }); break; }
		const efs = globalThis.FS ?? Module.FS;
		try { efs.mkdir('/tmp/office'); } catch { /* exists */ }
		efs.writeFile(fsPath, bytes);
		port.postMessage({ cmd: 'load', fileUrl: 'file://' + fsPath, chromeless: thumbMode });
		break;
	}
	case 'ui_ready':
		mark('tUiReady');
		// Size the embedded LO window to the canvas (the example's trick).
		window.dispatchEvent(new Event('resize'));
		tellParent({ cmd: 'zeta-ready', report });
		if (thumbMode) {
			// Thumbnail mode: the capture wants the document, not the log.
			statusEl.style.display = 'none';
		} else if (vaultPath) {
			// Tab mode: quiet down once the document is up; from here the
			// overlay is a transient save indicator.
			setTimeout(() => { if (!report.error) statusEl.style.display = 'none'; }, 1500);
		} else {
			// Measure mode: store round-trip back into the FS in the
			// original format and count the bytes — the save path in
			// miniature, without a vault to write to.
			port.postMessage({
				cmd: 'savetest',
				fileUrl: 'file://' + fsPath,
				filterName: FILTERS[ext] ?? null,
			});
		}
		break;
	case 'modified':
		onModified(msg.state);
		break;
	case 'edited':
		tellParent({ cmd: 'zeta-edited' });
		break;
	case 'saved': {
		mark('tSaved');
		const saved = (globalThis.FS ?? Module.FS).readFile(fsPath);
		report.savedBytes = saved.length;
		status(`savetest: ${saved.length} bytes`);
		tellParent({ cmd: 'zeta-saved', report });
		break;
	}
	case 'error':
		fail(msg.message);
		break;
	default:
		console.warn('zeta-page: unknown thread message', msg);
	}
}

// ---- the save path (tab mode) ---------------------------------------------

let seenDirty = false;
let saveSeq = 0;
let explicitSave = false; // a 'zeta-save' is in flight from the app page

function flash(text) {
	statusEl.textContent = text;
	statusEl.style.display = '';
	clearTimeout(flash.timer);
	flash.timer = setTimeout(() => { statusEl.style.display = 'none'; }, 2500);
}

// modified→false means the Emscripten FS now matches the model (the load
// state or a completed store — LibreOffice's clean state IS the last
// store). Push only when edits happened since the last push, so opening a
// document never writes the vault.
function onModified(state) {
	tellParent({ cmd: 'zeta-modified', state });
	if (state) { seenDirty = true; return; }
	if (!seenDirty || !vaultPath) {
		// An explicit save that found nothing to store still gets its
		// answer — the dock's save-and-close waits on it.
		if (explicitSave) tellParent({ cmd: 'zeta-vault-saved', ok: true });
		explicitSave = false;
		return;
	}
	seenDirty = false;
	explicitSave = false;
	pushToVault();
}

function pushToVault() {
	const bytes = (globalThis.FS ?? Module.FS).readFile(fsPath);
	const id = ++saveSeq;
	const onResult = (e) => {
		const d = e.data ?? {};
		if (d.source !== 'clew-zeta-host' || d.type !== 'office-save-result' || d.id !== id) return;
		window.removeEventListener('message', onResult);
		if (d.ok) flash(`Saved ${vaultPath}`);
		else fail(`vault save failed: ${d.error}`);
		// The office dock waits on this to finish a save-and-close, and
		// timestamps it to tell the watcher's echo of this write from a
		// real external change.
		tellParent({ cmd: 'zeta-vault-saved', ok: d.ok === true });
	};
	window.addEventListener('message', onResult);
	// window.top: the save bridge lives on the app page, and this page may
	// be nested one level deeper when running as a live embed in a preview.
	window.top.postMessage(
		{ source: 'clew-zeta', type: 'office-save', id, path: vaultPath, bytes }, '*');
}

// The app page can also ask for a save (menu command, close flow) — and
// the smoke harness for a verifiable edit.
window.addEventListener('message', (e) => {
	if (e.data?.cmd === 'zeta-save') {
		explicitSave = true;
		thrPort?.postMessage({ cmd: 'save' });
	}
	if (e.data?.cmd === 'zeta-test-edit') thrPort?.postMessage({ cmd: 'testedit' });
});

// Qt reads the canvas CSS size on window resize.
window.addEventListener('resize', () => { /* Qt listens itself; nothing to do */ });
