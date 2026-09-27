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
import { vaultFileUrl, pdfViewerUrl, excalidrawUrl } from '../../lib/preview-url.js';
import { workspaceStore } from '../../state/workspace-store.js';
import { officeDock } from '../../office-dock.js';
import { ipc, CH } from '../../ipc.js';

class ClewFileView extends ClewElement {
	tabId = null;
	path = null;

	subscribe() {
		if (fileKind(this.path) === 'office') {
			// Engine install progress, the one-instance guard freeing up (in
			// this window or another), boots and teardowns — all re-render.
			this.listen(officeDock, 'changed', () => this.render());
		}
	}

	cleanup() {
		officeDock.detach(this);
	}

	render() {
		this.classList.add('file-view');
		const url = vaultFileUrl(this.path);
		const kind = fileKind(this.path);

		let el;
		if (kind === 'excalidraw') {
			// The Excalidraw editor, in its own document. React is confined to
			// that iframe and loads only when a drawing is opened.
			el = document.createElement('iframe');
			el.className = 'excalidraw-frame';
			el.allow = 'fullscreen; clipboard-write';
			el.src = excalidrawUrl(this.path);
		} else if (kind === 'image') {
			el = document.createElement('img');
			el.src = url;
			el.alt = this.path;
		} else if (kind === 'pdf') {
			// Our own EmbedPDF page rather than Chromium's plugin, so the tab
			// gains annotation and matches both the note-embed surface and
			// Clew-iOS. Unsandboxed: the viewer fetches the PDF from its own
			// origin.
			el = document.createElement('iframe');
			el.className = 'pdf-frame';
			el.allow = 'fullscreen';
			// A page anchor the tab was opened at (actions.openWikilink).
			const page = workspaceStore.findTab(this.tabId)?.tab.view.pdfPage ?? null;
			el.src = pdfViewerUrl(url, { page });
		} else if (kind === 'office') {
			// ZetaOffice (LibreOffice wasm). The iframe itself belongs to the
			// office dock (an overlay that survives tab switches — see
			// office-dock.js); this view contributes only the host rectangle
			// the dock tracks, or a notice/download panel when it can't run.
			el = this.#officeContent();
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

	#pdfPreviewPath = null;

	#officeContent() {
		if (this.#pdfPreviewPath) return this.#pdfPreview();
		const engine = officeDock.engineStatus();
		if (engine.pending) {
			return this.#notice('');
		}
		if (engine.downloading || !engine.installed) {
			const panel = this.#downloadPanel(engine);
			if (!engine.downloading) panel.append(this.#fallbackRow(engine));
			return panel;
		}
		const host = document.createElement('div');
		host.className = 'office-host';
		const { verdict, path } = officeDock.claim(this, host);
		if (verdict === 'mine') return host;
		const which = path ? `“${basename(path)}”` : 'another document';
		const blocked = this.#notice(verdict === 'other-window'
			? `One office document at a time — ${which} is open in another window. Close it and this document opens by itself.`
			: `One office document at a time — ${which} is open in another tab. Close it and this document opens by itself.`);
		blocked.append(this.#fallbackRow(engine));
		return blocked;
	}

	/**
	 * The desktop-LibreOffice rung: a read-only PDF (converted headlessly
	 * into .clew/cache, shown in the EmbedPDF viewer Clew already has) and
	 * "edit it out there". Offered wherever the wasm editor is not running —
	 * no engine downloaded, or the one instance is busy elsewhere.
	 */
	#fallbackRow(engine) {
		const row = document.createElement('div');
		row.className = 'office-fallback';
		if (engine.soffice) {
			const preview = document.createElement('button');
			preview.textContent = 'Preview as PDF';
			preview.addEventListener('click', async () => {
				preview.disabled = true;
				preview.textContent = 'Converting…';
				const res = await ipc.invoke(CH.OFFICE_CONVERT_PDF, { path: this.path }).catch((err) => ({ ok: false, reason: String(err?.message ?? err) }));
				if (res.ok) {
					this.#pdfPreviewPath = res.path;
					this.render();
				} else {
					preview.textContent = 'Preview as PDF';
					preview.disabled = false;
					row.querySelector('.office-fallback-error')?.remove();
					const error = document.createElement('span');
					error.className = 'office-fallback-error';
					error.textContent = res.reason;
					row.append(error);
				}
			});
			row.append(preview);
		}
		const external = document.createElement('button');
		external.textContent = engine.soffice ? 'Open in LibreOffice' : 'Open in default app';
		external.addEventListener('click', () => {
			ipc.invoke(CH.OFFICE_OPEN_EXTERNAL, { path: this.path }).catch(() => {});
		});
		row.append(external);
		return row;
	}

	#pdfPreview() {
		const wrap = document.createElement('div');
		wrap.className = 'office-pdf-preview';
		const banner = document.createElement('div');
		banner.className = 'office-preview-banner';
		const text = document.createElement('span');
		text.textContent = `Read-only PDF preview of “${basename(this.path)}” — edits made elsewhere re-convert on reopen.`;
		const back = document.createElement('button');
		back.textContent = 'Back';
		back.addEventListener('click', () => {
			this.#pdfPreviewPath = null;
			this.render();
		});
		banner.append(text, back);
		const frame = document.createElement('iframe');
		frame.className = 'pdf-frame';
		frame.allow = 'fullscreen';
		frame.src = pdfViewerUrl(vaultFileUrl(this.#pdfPreviewPath));
		wrap.append(banner, frame);
		return wrap;
	}

	/**
	 * The first-open offer (and progress) for the LibreOffice engine, which
	 * is downloaded on demand rather than shipped — 53 MB against the pins
	 * in zeta-manifest.json. Settings → Office documents is the same
	 * control with a remove button.
	 */
	#downloadPanel(engine) {
		const panel = document.createElement('div');
		panel.className = 'panel-empty office-download';
		const mb = (bytes) => `${Math.round((bytes ?? 0) / 1048576)} MB`;
		const text = document.createElement('p');
		const detail = document.createElement('p');
		detail.className = 'office-download-detail';
		panel.append(text, detail);
		if (engine.downloading) {
			const p = engine.progress ?? {};
			text.textContent = 'Downloading the office engine…';
			detail.textContent = p.file
				? `${p.file} — ${mb(p.received)}${p.expected ? ` of ${mb(p.expected)}` : ''} (file ${p.done + 1} of ${p.total})`
				: 'Starting…';
			return panel;
		}
		text.textContent = 'Editing Word, Excel and PowerPoint documents in Clew uses LibreOffice, '
			+ `a one-time ${mb(engine.wireBytes)} download. Nothing is fetched until you ask.`;
		if (engine.lastError) {
			detail.textContent = `The last download did not finish: ${engine.lastError}`;
		}
		const button = document.createElement('button');
		button.textContent = `Download LibreOffice (${mb(engine.wireBytes)})`;
		button.addEventListener('click', () => officeDock.downloadEngine());
		panel.append(button);
		return panel;
	}

	#notice(message) {
		const el = document.createElement('div');
		el.className = 'panel-empty';
		el.textContent = message;
		return el;
	}
}

const basename = (p) => String(p ?? '').split('/').pop();

customElements.define('clew-file-view', ClewFileView);
