// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// ![[drawing.excalidraw]] inside a rendered note.
//
// The engine emits a placeholder; this turns it into the editor page running
// in VIEW MODE — the drawing, pannable and zoomable, with no toolbar and
// nothing editable. Reading a note should not put you one stray click away
// from altering a diagram; the title bar links to the real editor for that.
//
// Built lazily, because each one is a React instance: a note holding six
// diagrams must not start six of them above the fold.
const CSS = `
.excalidraw-embed-box { margin: 1em 0; }
.excalidraw-embed { height: 60vh; position: relative; border-radius: 4px; overflow: hidden; }
.excalidraw-embed iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; display: block; }
.excalidraw-embed-note { padding: 20px; text-align: center; opacity: 0.75; }
`;

function ensureStyles() {
	if (document.getElementById('clew-excalidraw-embed-css')) return;
	const style = document.createElement('style');
	style.id = 'clew-excalidraw-embed-css';
	style.textContent = CSS;
	document.head.append(style);
}

export function initExcalidrawEmbeds() {
	for (const host of document.querySelectorAll('.excalidraw-embed')) {
		if (host.dataset.mounted) continue;
		host.dataset.mounted = '1';
		// Survive morphdom: rebuilding the iframe on every save would restart
		// React and flash the drawing away mid-read.
		host.setAttribute('data-clew-keep', '');
		ensureStyles();
		mount(host);
	}
}

function mount(host) {
	const src = host.dataset.excalidrawSrc;
	const path = host.dataset.excalidrawPath ?? '';
	if (!src) {
		host.innerHTML = '<div class="excalidraw-embed-note">Drawing not found.</div>';
		return;
	}
	const observer = new IntersectionObserver((entries) => {
		if (!entries.some((entry) => entry.isIntersecting)) return;
		observer.disconnect();
		const frame = document.createElement('iframe');
		frame.setAttribute('allow', 'fullscreen');
		frame.setAttribute('tabindex', '-1');
		frame.src = '/__clew_assets__/clewex/page.html'
			+ `?src=${encodeURIComponent(src)}&path=${encodeURIComponent(path)}&view=1`;
		host.replaceChildren(frame);
	}, { rootMargin: '100% 0%' });
	observer.observe(host);
}
