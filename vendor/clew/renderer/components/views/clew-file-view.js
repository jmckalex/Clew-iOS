// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// <clew-file-view>: viewer tab for non-note files — images, PDFs (Chromium's
// built-in viewer), audio, video — served through clew-preview://.
import { ClewElement } from '../base/clew-element.js';
import { fileKind } from '../../lib/file-types.js';
import { vaultFileUrl } from '../../lib/preview-url.js';

class ClewFileView extends ClewElement {
	tabId = null;
	path = null;

	render() {
		this.classList.add('file-view');
		const url = vaultFileUrl(this.path);
		const kind = fileKind(this.path);

		let el;
		if (kind === 'image') {
			el = document.createElement('img');
			el.src = url;
			el.alt = this.path;
		} else if (kind === 'pdf') {
			// Unsandboxed (unlike note previews) so the PDF viewer plugin runs;
			// the document is Chromium's own viewer, not vault-authored content.
			el = document.createElement('iframe');
			el.className = 'pdf-frame';
			el.src = url;
		} else if (kind === 'audio') {
			el = document.createElement('audio');
			el.controls = true;
			el.src = url;
		} else if (kind === 'video') {
			el = document.createElement('video');
			el.controls = true;
			el.src = url;
		} else {
			el = document.createElement('div');
			el.className = 'panel-empty';
			el.textContent = 'No viewer for this file type';
		}
		this.replaceChildren(el);
	}
}

customElements.define('clew-file-view', ClewFileView);
