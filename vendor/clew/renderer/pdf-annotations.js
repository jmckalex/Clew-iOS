// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// PDF annotations → note (docs/dev/live-edit.md §5.15), the app side. The
// annotations live in the viewer (EmbedPDF, in a PDF tab's clew-preview
// document): this asks that viewer for them — opening a tab when none is
// open — and hands them to the pure builder (shared/pdf-annotations-note.js),
// which writes or MERGES `<pdf> — Annotations.md` beside the PDF.
import { workspaceStore } from './state/workspace-store.js';
import { vaultStore } from './state/vault-store.js';
import { ipc, CH } from './ipc.js';
import { notice } from './plugins.js';
import { annotationsNote, annotationsNotePath } from '../shared/pdf-annotations-note.js';

// A view lingering while its PDF saves (pdf-frames.js) is not the tab's.
const frameFor = (path) => [...document.querySelectorAll('clew-file-view:not([data-clew-retiring])')]
	.find((v) => v.path === path)?.querySelector('iframe.pdf-frame') ?? null;

/**
 * The annotations of a vault PDF, from its viewer.
 *
 * @param {string} path
 * @returns {Promise<{id, page, kind, text, contents, color}[]>}
 */
export async function listAnnotations(path) {
	let frame = frameFor(path);
	if (!frame) {
		workspaceStore.openFile(path, { newTab: true });
		for (let i = 0; i < 100 && !(frame = frameFor(path)); i += 1) await new Promise((r) => setTimeout(r, 100));
		if (!frame) throw new Error('No viewer for that PDF');
	}
	// The viewer answers once its document and annotations are in; ask
	// until it does (a fresh tab is still loading).
	for (let attempt = 0; attempt < 40; attempt += 1) {
		const requestId = `${Date.now()}-${Math.random()}`;
		const answer = await new Promise((resolve) => {
			const onMessage = (event) => {
				const msg = event.data;
				if (event.source !== frame.contentWindow || msg?.source !== 'clew-preview' || msg.type !== 'annotations' || msg.requestId !== requestId) return;
				window.removeEventListener('message', onMessage);
				resolve(msg);
			};
			window.addEventListener('message', onMessage);
			frame.contentWindow?.postMessage({ source: 'clew-preview-host', type: 'list-annotations', requestId }, '*');
			setTimeout(() => { window.removeEventListener('message', onMessage); resolve(null); }, 8000);
		});
		if (answer && !answer.error) return answer.annotations;
		await new Promise((r) => setTimeout(r, 500));
	}
	throw new Error('The PDF viewer did not answer');
}

/**
 * The command: write or merge the annotations note beside `path`.
 *
 * @returns {Promise<{notePath: string, added: number}|null>}
 */
export async function extractAnnotations(path) {
	if (!path || !/\.pdf$/i.test(path)) { notice('Not a PDF'); return null; }
	let annotations;
	try { annotations = await listAnnotations(path); } catch (err) { notice(`Could not read the annotations: ${err.message}`); return null; }
	const notePath = annotationsNotePath(path);
	const existing = vaultStore.pathExists(notePath)
		? await ipc.invoke(CH.NOTE_READ, { path: notePath }).catch(() => null)
		: null;
	const { text, added } = annotationsNote(path, annotations, existing);
	if (existing === null || text !== existing) await ipc.invoke(CH.NOTE_WRITE, { path: notePath, content: text });
	notice(added
		? `${added} annotation${added === 1 ? '' : 's'} → ${notePath.split('/').pop()}`
		: annotations.length ? 'No new annotations' : 'This PDF has no annotations');
	return { notePath, added };
}
