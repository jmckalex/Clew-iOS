// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Autosave bridges for the two editors that live in their own documents:
// the PDF viewer's annotations, and the Excalidraw editor's drawings.
//
// PDF viewers run in three different frames (a rendered note preview, the
// file tab's viewer page, a canvas node's viewer page) but all three are
// children of this window and all three post the same message, so one
// listener serves them rather than three near-identical cases in three
// components.
//
// This is NOT a general binary-write channel for previews: main-side
// vault.writePdf refuses anything that is not an existing .pdf inside the
// vault, so the worst a hostile note could do with it is overwrite a PDF the
// user already has — the same thing annotating does on purpose.
import { ipc } from './ipc.js';
import { CH } from '../shared/channels.js';
import { isExcalidrawPath } from '../shared/excalidraw-file.js';
import { vaultStore } from './state/vault-store.js';
import { vaultFileUrl } from './lib/preview-url.js';

/**
 * Excalidraw saves, app-page side. The editor runs in an iframe under
 * __clew_assets__, so it cannot reach IPC itself and posts here instead.
 *
 * Constrained the same way vault.writePdf is: the path must be a drawing.
 * NOTE_WRITE will happily write any text anywhere, and a preview document is
 * vault-authored content, so the gate is that this bridge only ever forwards
 * a path isExcalidrawPath() recognises.
 */
export function installExcalidrawSaveBridge() {
	window.addEventListener('message', async (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-excalidraw' || msg.type !== 'excalidraw-save') return;
		const reply = (ok, error) => event.source?.postMessage(
			{ source: 'clew-excalidraw-host', type: 'excalidraw-save-result', id: msg.id, ok, error }, '*');
		if (!isExcalidrawPath(msg.path ?? '')) {
			reply(false, 'not a drawing');
			return;
		}
		try {
			await ipc.invoke(CH.NOTE_WRITE, { path: msg.path, content: msg.text });
			reply(true);
		} catch (err) {
			console.warn('[clew] drawing save failed:', err);
			reply(false, String(err?.message ?? err));
		}
	});
}

/**
 * The Excalidraw library, app-page side. Dropping a .excalidrawlib onto the
 * canvas is Excalidraw's own gesture; all we do is remember what it produced,
 * so the shapes are still there tomorrow.
 */
export function installExcalidrawLibraryBridge() {
	window.addEventListener('message', async (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-excalidraw') return;
		const reply = (payload) => event.source?.postMessage(
			{ source: 'clew-excalidraw-host', id: msg.id, ...payload }, '*');
		try {
			if (msg.type === 'excalidraw-library-load') {
				reply({ type: 'excalidraw-library-result', items: await ipc.invoke(CH.EXCALIDRAW_LIB_GET) });
			} else if (msg.type === 'excalidraw-library-save') {
				await ipc.invoke(CH.EXCALIDRAW_LIB_SET, { items: msg.items });
				reply({ type: 'excalidraw-library-result', ok: true });
			}
		} catch (err) {
			console.warn('[clew] excalidraw library:', err);
			reply({ type: 'excalidraw-library-result', items: [], ok: false });
		}
	});
}

/**
 * Embedded-file resolution for drawings. Obsidian's Excalidraw plugin stores
 * pasted images as vault attachments named from the markdown's Embedded Files
 * section, so the editor page asks us to turn those wikilink targets into
 * vault paths — the same resolution a wikilink click uses. Read-only: the
 * page fetches the bytes itself, over the preview protocol it lives on.
 */
export function installExcalidrawResolveBridge() {
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-excalidraw' || msg.type !== 'excalidraw-resolve-files') return;
		const paths = {};
		for (const name of Array.isArray(msg.names) ? msg.names.slice(0, 500) : []) {
			paths[String(name)] = vaultStore.resolveFileName(String(name));
		}
		event.source?.postMessage(
			{ source: 'clew-excalidraw-host', type: 'excalidraw-resolve-result', id: msg.id, paths }, '*');
	});
}

/**
 * ZetaOffice saves, app-page side. Like the PDF bridge: the viewer runs in
 * an iframe under __clew_assets__, posts bytes here, and main-side
 * vault.writeOffice refuses anything that is not an existing office
 * document inside the vault.
 */
export function installOfficeSaveBridge() {
	window.addEventListener('message', async (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-zeta' || msg.type !== 'office-save') return;
		const reply = (ok, error) => event.source?.postMessage(
			{ source: 'clew-zeta-host', type: 'office-save-result', id: msg.id, ok, error }, '*');
		try {
			await ipc.invoke(CH.OFFICE_WRITE, { path: msg.path, bytes: msg.bytes });
			reply(true);
		} catch (err) {
			console.warn('[clew] office save failed:', err);
			reply(false, String(err?.message ?? err));
		}
	});
}

/**
 * Office thumbnail requests, app-page side. Preview documents ask for the
 * cached thumbnail of an office embed (rendering it on demand is main's
 * job — an offscreen ZetaOffice, see main/office-thumbs.js); the reply
 * carries a ready-to-use preview URL. Read-only and idempotent.
 */
export function installOfficeThumbBridge() {
	window.addEventListener('message', async (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-office-embed' || msg.type !== 'office-thumb') return;
		const reply = (payload) => event.source?.postMessage(
			{ source: 'clew-office-embed-host', id: msg.id, ...payload }, '*');
		try {
			const res = await ipc.invoke(CH.OFFICE_THUMBNAIL, { path: msg.path });
			if (res?.ok) reply({ ok: true, url: `${vaultFileUrl(res.path)}?v=${res.stamp}` });
			else reply({ ok: false, reason: res?.reason ?? 'unavailable' });
		} catch (err) {
			reply({ ok: false, reason: String(err?.message ?? err) });
		}
	});
}

export function installPdfSaveBridge() {
	window.addEventListener('message', async (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-pdf' || msg.type !== 'pdf-save') return;
		const reply = (ok, error) => event.source?.postMessage(
			{ source: 'clew-pdf-host', type: 'pdf-save-result', id: msg.id, ok, error }, '*');
		try {
			await ipc.invoke(CH.PDF_WRITE, { path: msg.path, bytes: msg.bytes });
			reply(true);
		} catch (err) {
			console.warn('[clew] PDF save failed:', err);
			reply(false, String(err?.message ?? err));
		}
	});
}
