// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// All ipcMain handlers in one place. Handlers are thin: resolve the
// sender's VaultSession, validate, delegate, return plain JSON-safe values.
// App-global concerns (settings, the recents list, the menu) stay
// session-free; everything vault-shaped routes through the session.
import { app, dialog, ipcMain, shell } from 'electron';
import * as pdfFonts from './pdf-fonts.js';
import * as officeSlot from './office-slot.js';
import * as zetaAssets from './zeta-assets.js';
import * as officeConvert from './office-convert.js';
import * as officeThumbs from './office-thumbs.js';
import { CH } from '../shared/channels.js';
import { settings } from './settings.js';
import { appMenu } from './menu.js';
import { sessionFor } from './session.js';
import { openVaultAnywhere, openVaultDialog, createVaultDialog, openDemoVault } from './main.js';
import { propagateRename } from './rename-links.js';
import { exportNote } from './export.js';
import { exportSite } from './export-site.js';
import { parseBib } from '../shared/bib.js';
import { direntKind, shouldRecurse, walkGuard, writeFileAtomic } from './fs-utils.js';
import { listSnapshots, readSnapshot } from './history.js';
import { listPlugins } from './plugins.js';
import { paths } from './paths.js';
import { planOpen, pathFromFileUrl } from './open-file.js';
import fs from 'node:fs';
import nodePath from 'node:path';

const bibCache = new Map(); // abs path -> {mtimeMs, entries} (abs paths: safe app-wide)

// Vault-state file names must stay simple basenames (workspace.json etc.).
const sanitizeStateName = (name) => {
	if (!/^[\w-]+\.json$/.test(name)) throw new Error(`Bad state name: ${name}`);
	return name;
};

export function registerIpc() {
	// Session-scoped handler: fn(session, payload, event).
	const handle = (channel, fn) => ipcMain.handle(channel, (event, payload) => {
		const session = sessionFor(event.sender);
		if (!session) throw new Error('No session for this window');
		return fn(session, payload, event);
	});
	// App-global handler: fn(payload, event).
	const handleGlobal = (channel, fn) => ipcMain.handle(channel, (event, payload) => fn(payload, event));

	handle(CH.VAULT_OPEN_DIALOG, (s) => openVaultDialog(s));
	handle(CH.VAULT_CREATE_DIALOG, (s) => createVaultDialog(s));
	handle(CH.VAULT_OPEN_DEMO, (s) => openDemoVault(s));
	handle(CH.VAULT_OPEN_PATH, async (s, { path }) => {
		const target = openVaultAnywhere(path, { preferSession: s });
		await target.opened; // new windows open their vault after load
		return target.vaults.info;
	});
	handle(CH.VAULT_CURRENT, (s) => s.vaults.info);
	handleGlobal(CH.VAULT_RECENT, () => settings.get('recentVaults'));
	handle(CH.VAULT_TREE, (s) => s.vaults.tree());

	handle(CH.NOTE_READ, (s, { path }) => s.vaults.readNote(path));
	handle(CH.NOTE_WRITE, (s, { path, content }) => s.vaults.writeNote(path, content));
	handle(CH.NOTE_CREATE, (s, { path }) => s.vaults.createNote(path));
	handle(CH.FS_CREATE_FOLDER, (s, { path }) => s.vaults.createFolder(path));
	handle(CH.FS_RENAME, (s, { path, newPath }) => {
		s.vaults.rename(path, newPath);
		// Rewrite [[links]] pointing at the renamed note(s), using the
		// pre-rename index state (the watcher re-indexes right after).
		return propagateRename({ oldRel: path, newRel: newPath, indexer: s.indexer, vaults: s.vaults });
	});

	// Note history: list/read snapshots, and restore one. The path is
	// validated by resolve() (must stay inside the vault); the snapshot id
	// is validated by history.js itself. Restore force-snapshots the text
	// it displaces first, then writes through writeNote — the open editor
	// picks the change up over the normal external-change path.
	handle(CH.HISTORY_LIST, (s, { path }) => {
		s.vaults.resolve(path);
		return listSnapshots(s.vaults.root, path);
	});
	handle(CH.HISTORY_READ, (s, { path, id }) => {
		s.vaults.resolve(path);
		return readSnapshot(s.vaults.root, path, id);
	});
	handle(CH.HISTORY_RESTORE, (s, { path, id }) => {
		s.vaults.resolve(path);
		const text = readSnapshot(s.vaults.root, path, id);
		s.vaults.snapshotHistory(path, { force: true });
		s.vaults.writeNote(path, text);
	});

	handle(CH.INDEX_GET, (s) => (s.vaults.isOpen ? s.indexer.snapshot() : null));
	handle(CH.SEARCH, (s, { query }) => s.searchService.search(query));
	handle(CH.UNLINKED_MENTIONS, (s, { path }) => s.searchService.unlinkedMentions(path));
	handle(CH.FS_TRASH, (s, { path }) => s.vaults.trash(path));
	handle(CH.FS_REVEAL, (s, { path }) => s.vaults.reveal(path));
	handle(CH.ATTACH_SAVE, (s, { name, data }) =>
		s.vaults.saveAttachment(name, data, settings.get('attachmentFolder') || 'Attachments'));

	// Citation completion: every entry from every .bib in the vault,
	// mtime-cached per absolute file path.
	handle(CH.BIB_ENTRIES, (s) => {
		if (!s.vaults.isOpen) return [];
		const out = [];
		const seen = walkGuard(s.vaults.root);
		const walk = (dir) => {
			let entries;
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				if (entry.name.startsWith('.') || ['node_modules', '.trash'].includes(entry.name)) continue;
				const abs = nodePath.join(dir, entry.name);
				const kind = direntKind(dir, entry);
				if (kind === 'dir') {
					if (shouldRecurse(abs, seen)) walk(abs);
				} else if (kind === 'file' && entry.name.toLowerCase().endsWith('.bib')) {
					const mtimeMs = fs.statSync(abs).mtimeMs;
					const cached = bibCache.get(abs);
					const parsed = cached?.mtimeMs === mtimeMs
						? cached.entries
						: parseBib(fs.readFileSync(abs, 'utf8'));
					bibCache.set(abs, { mtimeMs, entries: parsed });
					const rel = nodePath.relative(s.vaults.root, abs);
					out.push(...parsed.map((e) => ({ ...e, file: rel })));
				}
			}
		};
		walk(s.vaults.root);
		return out;
	});

	handle(CH.MENU_STATE, (s, state) => appMenu.update(s, state));

	// Vault kv store (note API state).
	handle(CH.KV_GET, (s, { key }) => (s.vaults.isOpen ? s.kvStore.get(key) ?? null : null));
	handle(CH.KV_SET, (s, { key, value }) => (s.vaults.isOpen ? s.kvStore.set(key, value) : null));
	handle(CH.KV_DELETE, (s, { key }) => (s.vaults.isOpen ? s.kvStore.delete(key) : null));
	handle(CH.KV_LIST, (s, { prefix }) => (s.vaults.isOpen ? s.kvStore.list(prefix ?? '') : {}));

	handle(CH.RENDER_SUBSCRIBE, (s, { path }) => s.renderService.subscribe(path));
	handle(CH.RENDER_UNSUBSCRIBE, (s, { path }) => s.renderService.unsubscribe(path));
	handle(CH.RENDER_HTML, (s, { path }) => s.renderService.renderedHtml(path));
	handle(CH.PDF_WRITE, (s, { path, bytes }) => s.vaults.writePdf(path, bytes));
	handle(CH.OFFICE_WRITE, (s, { path, bytes }) => s.vaults.writeOffice(path, bytes));
	// The Excalidraw shape library, per vault: it is a working set that belongs
	// with the notes it illustrates, so a vault carries its own.
	handle(CH.EXCALIDRAW_LIB_GET, (s) => s.vaults.loadState('excalidraw-library.json') ?? []);
	handle(CH.EXCALIDRAW_LIB_SET, (s, { items }) => {
		s.vaults.saveState('excalidraw-library.json', items ?? []);
		return true;
	});
	handleGlobal(CH.PDF_FONTS_STATUS, () => pdfFonts.status());
	handleGlobal(CH.PDF_FONTS_DOWNLOAD, () => pdfFonts.download());
	handleGlobal(CH.PDF_FONTS_REMOVE, () => pdfFonts.remove());

	// Office tabs: the app-global one-LibreOffice slot, the engine bundle,
	// and the close-guard plumbing (see office-dock.js on the renderer side).
	handleGlobal(CH.OFFICE_SLOT_ACQUIRE, (payload, event) => officeSlot.acquire(event.sender, payload ?? {}));
	handleGlobal(CH.OFFICE_SLOT_RELEASE, (_payload, event) => officeSlot.release(event.sender));
	// `soffice` rides along so the offer panel knows whether the desktop-
	// LibreOffice fallback (PDF preview, edit externally) is worth showing.
	handleGlobal(CH.OFFICE_ENGINE_STATUS, () => ({ ...zetaAssets.status(), soffice: officeConvert.available() }));
	handleGlobal(CH.OFFICE_ENGINE_DOWNLOAD, () => zetaAssets.download());
	handleGlobal(CH.OFFICE_ENGINE_REMOVE, () => zetaAssets.remove());
	handle(CH.OFFICE_CONVERT_PDF, (s, { path }) => officeConvert.convertToPdf(s.vaults, path));
	handle(CH.OFFICE_OPEN_EXTERNAL, (s, { path }) => officeConvert.openExternally(s.vaults, path));
	handle(CH.OFFICE_THUMBNAIL, (s, { path }) => officeThumbs.thumbnail(s, path));
	handle(CH.WINDOW_CLOSE_RESOLVED, (s, { proceed }) => s.resolveClose?.(proceed));
	// Save / Discard / Cancel, as a native sheet. CLEW_SMOKE_CONFIRM answers
	// it without UI so the harness can drive every branch of a close flow.
	handle(CH.CONFIRM_DISCARD, async (s, { message, detail }) => {
		if (process.env.CLEW_SMOKE_CONFIRM) return process.env.CLEW_SMOKE_CONFIRM;
		const { response } = await dialog.showMessageBox(s.win, {
			type: 'warning',
			buttons: ['Save', 'Discard Changes', 'Cancel'],
			defaultId: 0,
			cancelId: 2,
			message: String(message ?? 'Unsaved changes'),
			detail: String(detail ?? ''),
		});
		return ['save', 'discard', 'cancel'][response];
	});
	handleGlobal(CH.SHELL_OPEN_EXTERNAL, ({ url }) => {
		if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
	});

	// Hand a file to the OS default app: `[[paper.pdf|external]]` sends a
	// vault-relative path, a file:// link an absolute one. The guards
	// (vault clamp, executable refusal) live in open-file.js.
	handle(CH.SHELL_OPEN_PATH, (s, { path: rel, url }) => {
		let plan;
		if (url) {
			const abs = pathFromFileUrl(url);
			if (!abs) return { ok: false, reason: 'Not a local file:// link' };
			plan = planOpen(s.vaults, { abs });
		} else {
			plan = planOpen(s.vaults, { rel: String(rel ?? '') });
		}
		if (!plan.ok) return plan;
		// openPath resolves to '' on success, or a message on failure.
		shell.openPath(plan.target).then((message) => {
			if (message) console.warn(`[clew] openPath failed (${plan.target}): ${message}`);
		});
		return { ok: true };
	});

	handle(CH.WORKSPACE_LOAD, (s) => s.vaults.loadState('workspace.json'));
	handle(CH.WORKSPACE_SAVE, (s, state) => s.vaults.saveState('workspace.json', state));
	handleGlobal(CH.SETTINGS_GET, () => settings.get());
	handleGlobal(CH.SETTINGS_SET, ({ key, value }) => settings.set(key, value));
	handle(CH.VSTATE_LOAD, (s, { name }) => s.vaults.loadState(sanitizeStateName(name)));
	handle(CH.VSTATE_SAVE, (s, { name, data }) => s.vaults.saveState(sanitizeStateName(name), data));

	// Vault-level settings; render-affecting keys reconfigure the engine.
	handle(CH.VAULT_SETTINGS_GET, (s) => s.vaults.loadState('vault-settings.json') ?? {});
	handle(CH.VAULT_SETTINGS_SET, (s, { key, value }) => {
		const current = s.vaults.loadState('vault-settings.json') ?? {};
		current[key] = value;
		s.vaults.saveState('vault-settings.json', current);
		if (key === 'jmarkdownProject' || key === 'normalSyntax' || key === 'pandocCitations') {
			s.renderService.reconfigure({ [key]: value === true });
		}
		// Bibliography settings rewrite the engine config the same way.
		if (key === 'bibliography' || key === 'bibliographyStyle') {
			s.renderService.reconfigure({ [key]: value });
		}
		// Plugin toggles change the engine config (engine surfaces) and the
		// preview injection; re-render open previews with the new set.
		if (key === 'plugins') s.renderService.reconfigure({ plugins: value });
		return current;
	});

	handle(CH.PLUGINS_LIST, (s) => {
		if (!s.vaults.isOpen) return { plugins: [], enabled: [], globalDir: paths.globalPlugins };
		const vaultSettings = s.vaults.loadState('vault-settings.json') ?? {};
		return {
			plugins: listPlugins(s.vaults.root, paths.globalPlugins),
			enabled: Array.isArray(vaultSettings.plugins) ? vaultSettings.plugins : [],
			globalDir: paths.globalPlugins,
		};
	});

	// "Where do I put them?" — open the global plugin folder, creating it on
	// the way (it does not exist until the first plugin is installed).
	handleGlobal(CH.PLUGINS_REVEAL_GLOBAL, () => {
		fs.mkdirSync(paths.globalPlugins, { recursive: true });
		shell.openPath(paths.globalPlugins);
		return paths.globalPlugins;
	});

	// `outFile` (smoke tests) skips the save dialog, like EXPORT_SITE's outDir.
	// sessionId: the reading-view PDF prints this session's own
	// clew-preview:// document, and the protocol resolves it by sid.
	handle(CH.EXPORT_NOTE, (s, { path, format, outFile }) =>
		exportNote({ win: s.win, vaults: s.vaults, sessionId: s.id, relPath: path, format, outFile }));

	// The whole vault as a static website. `outDir` (smoke tests) skips the
	// dialog; otherwise the user picks a folder and the site lands in a
	// <vault-name>-site subfolder of it.
	handle(CH.EXPORT_SITE, async (s, { outDir } = {}) => {
		if (!s.vaults.isOpen) throw new Error('No vault open');
		let target = outDir;
		if (!target) {
			const { canceled, filePaths } = await dialog.showOpenDialog(s.win, {
				title: 'Export vault as website',
				buttonLabel: 'Export Here',
				properties: ['openDirectory', 'createDirectory'],
			});
			if (canceled || filePaths.length === 0) return null;
			target = nodePath.join(filePaths[0], `${nodePath.basename(s.vaults.root)}-site`);
		}
		const vaultOptions = s.vaults.loadState('vault-settings.json') ?? {};
		const result = await exportSite({
			vaultRoot: s.vaults.root,
			engineDir: nodePath.join(s.vaults.root, '.clew', 'engine'),
			distDir: nodePath.join(app.getAppPath(), 'dist'),
			outDir: target,
			vaultOptions,
		});
		return { outDir: target, ...result };
	});

	// Canvas drawing → PNG. The renderer rasterizes (it owns the theme colors);
	// main only picks the destination and writes. An explicit filePath skips
	// the dialog (smoke tests).
	handle(CH.CANVAS_EXPORT_PNG, async (s, { data, name, filePath }) => {
		let target = filePath;
		if (!target) {
			const { canceled, filePath: chosen } = await dialog.showSaveDialog(s.win, {
				defaultPath: nodePath.join(app.getPath('downloads'), name ?? 'drawing.png'),
				filters: [{ name: 'PNG image', extensions: ['png'] }],
			});
			if (canceled || !chosen) return null;
			target = chosen;
		}
		writeFileAtomic(target, Buffer.from(data, 'base64'));
		return target;
	});

	// User CSS snippets: <vault>/.clew/snippets/*.css, injected by the renderer.
	handle(CH.SNIPPETS_GET, (s) => {
		if (!s.vaults.isOpen) return [];
		const dir = nodePath.join(s.vaults.root, '.clew', 'snippets');
		try {
			return fs.readdirSync(dir)
				.filter((f) => f.endsWith('.css'))
				.map((f) => ({ name: f, css: fs.readFileSync(nodePath.join(dir, f), 'utf8') }));
		} catch {
			return [];
		}
	});
}
