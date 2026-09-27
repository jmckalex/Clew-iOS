// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Paste/drop attachments into the editor: the file is saved into the vault's
// attachment folder (main dedupes the name) and an `![[…]]` embed (or plain
// `[[…]]` link for non-media files) is inserted at the paste/drop position.
import { EditorView } from '@codemirror/view';
import { ipc, CH } from '../ipc.js';
import { isEmbeddablePath } from '../lib/file-types.js';

function timestampName(ext) {
	const d = new Date();
	const pad = (n) => String(n).padStart(2, '0');
	return `Pasted image ${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`
		+ `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${ext}`;
}

export async function saveAndInsert(view, files, pos) {
	let insertAt = pos;
	for (const file of files) {
		const generic = !file.name || /^image\.(png|jpe?g|gif|webp)$/i.test(file.name);
		const ext = file.name?.includes('.') ? file.name.slice(file.name.lastIndexOf('.')) : '.png';
		const name = generic ? timestampName(ext) : file.name;
		let rel;
		try {
			const data = new Uint8Array(await file.arrayBuffer());
			rel = await ipc.invoke(CH.ATTACH_SAVE, { name, data });
		} catch (err) {
			console.error('Attachment save failed:', err);
			continue;
		}
		const base = rel.split('/').pop();
		const text = (isEmbeddablePath(rel) ? `![[${base}]]` : `[[${base}]]`) + '\n';
		view.dispatch({
			changes: { from: insertAt, insert: text },
			selection: { anchor: insertAt + text.length },
		});
		insertAt += text.length;
	}
	view.focus();
}

export function attachments() {
	return EditorView.domEventHandlers({
		paste(event, view) {
			const files = [...(event.clipboardData?.items ?? [])]
				.filter((item) => item.kind === 'file')
				.map((item) => item.getAsFile())
				.filter(Boolean);
			if (files.length === 0) return false;
			event.preventDefault();
			saveAndInsert(view, files, view.state.selection.main.head);
			return true;
		},
		drop(event, view) {
			const files = [...(event.dataTransfer?.files ?? [])];
			if (files.length === 0) return false;
			event.preventDefault();
			const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
				?? view.state.selection.main.head;
			saveAndInsert(view, files, pos);
			return true;
		},
	});
}
