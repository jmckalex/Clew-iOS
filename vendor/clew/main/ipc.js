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
import * as pdfThumbs from './pdf-thumbs.js';
import { CH } from '../shared/channels.js';
import { settings } from './settings.js';
import { appMenu } from './menu.js';
import { allSessions, sessionFor } from './session.js';
import { openVaultAnywhere, openVaultDialog, createVaultDialog, openDemoVault } from './main.js';
import { propagateRename } from './rename-links.js';
import { exportNote } from './export.js';
import { exportSite } from './export-site.js';
import { parseBib, bibFilePath } from '../shared/bib.js';
import { direntKind, shouldRecurse, walkGuard, writeFileAtomic } from './fs-utils.js';
import { listSnapshots, readSnapshot } from './history.js';
import { listPlugins } from './plugins.js';
import { ShellSessions } from './shell-core.js';
import { paths } from './paths.js';
import { trust } from './trust.js';
import { registeredRemoteUrl, saveRemoteCopy } from './remote-pdfs.js';
import { planOpen, pathFromFileUrl } from './open-file.js';
import { iconTable, resolvedCallouts } from './callout-types.js';
import { iconKey } from '#jmarkdown/callout-definitions.js';
import fs from 'node:fs';
import nodePath from 'node:path';

const bibCache = new Map(); // abs path -> {mtimeMs, entries} (abs paths: safe app-wide)

// Vault-state file names must stay simple basenames (workspace.json etc.).
const sanitizeStateName = (name) => {
	if (!/^[\w-]+\.json$/.test(name)) throw new Error(`Bad state name: ${name}`);
	return name;
};

/** Every window's shell, keyed by session id (main/shell-core.js). */
export const shells = new ShellSessions();

/**
 * Where an entry's BibTeX `file` field points (§5.14): relative to its .bib's
 * folder first, then the vault root; `inVault` paths are vault-relative (a
 * Clew PDF tab), others absolute (the OS, through the open-file guard).
 *
 * @returns {{ path: string, inVault: boolean, exists: boolean } | null}
 */
function resolveBibFile(value, bibDir, root) {
	const raw = bibFilePath(value);
	if (!raw) return null;
	const candidates = nodePath.isAbsolute(raw) ? [raw] : [nodePath.join(bibDir, raw), nodePath.join(root, raw)];
	const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
	const abs = found ?? candidates[0];
	const rel = nodePath.relative(root, abs);
	const inVault = !rel.startsWith('..') && !nodePath.isAbsolute(rel);
	return { path: inVault ? rel.split(nodePath.sep).join('/') : abs, inVault, exists: Boolean(found) };
}

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
	handle(CH.VAULT_CURRENT, (s) => s.vaults.ownInfo);
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
		const walk = (dir, rel) => {
			let entries;
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
			for (const entry of entries) {
				const childRel = rel ? `${rel}/${entry.name}` : entry.name;
				// A .bib inside a library folder is that library's, not this
				// vault's: completion should never offer it.
				if (s.vaults.excludes.isUnindexed(childRel)) continue;
				const abs = nodePath.join(dir, entry.name);
				const kind = direntKind(dir, entry);
				if (kind === 'dir') {
					if (shouldRecurse(abs, seen)) walk(abs, childRel);
				} else if (kind === 'file' && entry.name.toLowerCase().endsWith('.bib')) {
					const mtimeMs = fs.statSync(abs).mtimeMs;
					const cached = bibCache.get(abs);
					const parsed = cached?.mtimeMs === mtimeMs
						? cached.entries
						: parseBib(fs.readFileSync(abs, 'utf8'));
					bibCache.set(abs, { mtimeMs, entries: parsed });
					const rel = nodePath.relative(s.vaults.root, abs);
					out.push(...parsed.map((e) => ({ ...e, bib: rel, pdf: resolveBibFile(e.file, dir, s.vaults.root) })));
				}
			}
		};
		walk(s.vaults.root, '');
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
	// A PDF's first page as a picture (portals; docs/dev/pdf-unification.md §2).
	handle(CH.PDF_THUMBNAIL, (s, { path }) => pdfThumbs.thumbnail(s, path));
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
	handle(CH.SHELL_OPEN_PATH, async (s, { path: rel, url }) => {
		let plan;
		if (url) {
			const abs = pathFromFileUrl(url);
			if (!abs) return { ok: false, reason: 'Not a local file:// link' };
			plan = planOpen(s.vaults, { abs });
		} else {
			plan = planOpen(s.vaults, { rel: String(rel ?? '') });
		}
		if (!plan.ok) return plan;
		// A scenario must never launch an app: it reads this line instead.
		if (process.env.CLEW_SMOKE) {
			console.log(`smoke-open-path: ${plan.target}`);
			return { ok: true };
		}
		// openPath resolves to '' on success, or the OS's own message (no app
		// for the type, …) — returned, so the caller shows it as a notice
		// rather than the open failing in silence.
		const message = await shell.openPath(plan.target);
		if (message) console.warn(`[clew] openPath failed (${plan.target}): ${message}`);
		return message ? { ok: false, reason: message } : { ok: true };
	});

	handle(CH.WORKSPACE_LOAD, (s) => s.vaults.loadState('workspace.json'));
	handle(CH.WORKSPACE_SAVE, (s, state) => s.vaults.saveState('workspace.json', state));
	handleGlobal(CH.SETTINGS_GET, () => settings.get());
	handleGlobal(CH.SETTINGS_SET, ({ key, value }) => {
		settings.set(key, value);
		// The global TeX fragments are read at worker spawn, and every window
		// has its own worker — so a change here reconfigures them ALL, not
		// just the sender's. (Nothing else app-global reaches the engine.)
		if (key === 'texFragments') {
			for (const session of allSessions()) session.renderService.reconfigure({});
		}
		// The global callout types: every window's worker and every window's
		// editor (live edit draws callouts itself, from the same table).
		if (key === 'callouts') {
			for (const session of allSessions()) {
				session.renderService.reconfigure({});
				session.send(CH.EV_CALLOUTS_CHANGED);
			}
		}
	});
	// Custom callout types for the sender's vault, resolved. The vault's
	// list is read from disk, so a hand edit is what this answers with.
	handle(CH.CALLOUTS_RESOLVED, (s) => {
		const vaultList = s.vaults.root ? s.vaults.loadState('vault-settings.json')?.callouts : undefined;
		const { custom, problems } = resolvedCallouts(settings.get('callouts'), vaultList, paths.faIcons);
		return { custom, problems };
	});
	// The icon table, for Settings only (never a render): whole for the
	// picker, or just the names a list of rows uses, for their previews.
	handleGlobal(CH.CALLOUT_ICONS, (args) => {
		const table = iconTable(paths.faIcons);
		if (!Array.isArray(args?.names)) return table;
		const icons = {};
		for (const name of args.names.slice(0, 500)) {
			const key = iconKey(name, table.icons);
			if (key) icons[String(name)] = { key, icon: table.icons[key] };
		}
		return { version: table.version, icons };
	});
	handle(CH.VSTATE_LOAD, (s, { name }) => s.vaults.loadState(sanitizeStateName(name)));
	handle(CH.VSTATE_SAVE, (s, { name, data }) => s.vaults.saveState(sanitizeStateName(name), data));

	// Vault-level settings; render-affecting keys reconfigure the engine.
	handle(CH.VAULT_SETTINGS_GET, (s) => s.vaults.loadState('vault-settings.json') ?? {});
	// Trust is the DEVICE's (vault-trust.js), never a vault setting: nothing
	// the vault carries reaches it, and it is set only from this window's own
	// chrome — the banner and Settings → This vault.
	handle(CH.VAULT_TRUST_GET, (s) => ({
		trusted: s.trusted === true,
		refused: s.trusted ? [] : s.renderService.refusedNames(),
	}));
	handle(CH.VAULT_TRUST_SET, (s, { trusted }) => {
		if (!s.vaults.root) return { trusted: false };
		if (trusted === true) trust.trust(s.vaults.root);
		else trust.revoke(s.vaults.root);
		s.trusted = trusted === true;
		// Rewrites the engine config and re-renders every open preview.
		s.renderService.setNoteCode(s.trusted);
		s.send(CH.EV_VAULT_TRUST_CHANGED, { trusted: s.trusted });
		return { trusted: s.trusted };
	});
	// Web PDFs (remote-pdfs.js): the viewer names a HASH; the URL is looked
	// up in this window's own registrations, never taken from the message.
	handle(CH.REMOTE_PDF_SAVE_COPY, (s, { key }) =>
		({ path: saveRemoteCopy(s, key, settings.get('attachmentFolder') || 'Attachments') }));
	handle(CH.REMOTE_PDF_OPEN, (s, { key }) => {
		const url = registeredRemoteUrl(s, key);
		if (!url || !/^https?:\/\//i.test(url)) throw new Error('Not a web PDF open in this window');
		// A scenario must never launch a browser: it reads this line instead.
		if (process.env.CLEW_SMOKE) console.log(`smoke-open-external: ${url}`);
		else shell.openExternal(url);
		return { url };
	});
	handle(CH.VAULT_SETTINGS_SET, (s, { key, value }) => {
		const current = s.vaults.loadState('vault-settings.json') ?? {};
		current[key] = value;
		s.vaults.saveState('vault-settings.json', current);
		// dataviewJs reaches the worker only at spawn (CLEW_DATAVIEW_JS), so
		// it needs the fresh standby too — without it the toggle waited for
		// the vault's next opening.
		if (key === 'jmarkdownProject' || key === 'normalSyntax' || key === 'pandocCitations'
			|| key === 'dataviewJs') {
			s.renderService.reconfigure({ [key]: value === true });
		}
		// Bibliography settings rewrite the engine config the same way.
		if (key === 'bibliography' || key === 'bibliographyStyle') {
			s.renderService.reconfigure({ [key]: value });
		}
		// The exclusion lists (vault-excludes.js): every walk in the app was
		// made under the old rules, so tree, watcher and index all go again.
		if (key === 'hidden' || key === 'unindexed') {
			s.vaults.reloadExcludes();
			s.indexer.openVault(s.vaults.root, s.vaults.excludes);
		}
		// This vault's TeX fragments: the worker reads them at spawn, so the
		// standby has to go and the open previews re-render (engine/
		// tex-fragments.js, engine/figures.js#applyTexFragments).
		if (key === 'texFragments') s.renderService.reconfigure({ texFragments: value });
		// This vault's callout types: the worker's table (CLEW_CALLOUTS is
		// read at spawn) and this window's editor.
		if (key === 'callouts') {
			s.renderService.reconfigure({ callouts: value });
			s.send(CH.EV_CALLOUTS_CHANGED);
		}
		// Plugin toggles change the engine config (engine surfaces) and the
		// preview injection; re-render open previews with the new set.
		if (key === 'plugins') s.renderService.reconfigure({ plugins: value });
		return current;
	});

	// ---- the shell panel ---------------------------------------------------
	// Keyed by the window's session id, so a shell belongs to its window and
	// is reaped when the window goes. It starts at the vault root and stays
	// alive while the panel is hidden — a build running behind a closed
	// panel is the whole point of keeping it.
	handle(CH.SHELL_OPEN, (s) => {
		if (!s.vaults.isOpen) return { ok: false, error: 'no vault open' };
		if (shells.has(s.id)) return { ok: true, running: true };
		const info = shells.open(s.id, {
			cwd: s.vaults.root,
			onData: (data) => s.send(CH.EV_SHELL_DATA, { data }),
			onExit: (end) => s.send(CH.EV_SHELL_EXIT, end),
		});
		return { ok: true, running: false, ...info };
	});
	handle(CH.SHELL_WRITE, (s, { data }) => ({ ok: shells.write(s.id, String(data ?? '')) }));
	handle(CH.SHELL_RESIZE, (s, { cols, rows }) => ({ ok: shells.resize(s.id, cols, rows) }));
	handle(CH.SHELL_CLOSE, (s) => ({ ok: shells.close(s.id) }));

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
	// An export into the vault shows in the explorer at once (refreshIfInside:
	// the watcher may never report it — a vault whose budget is spent).
	handle(CH.EXPORT_NOTE, async (s, { path, format, outFile }) => {
		const result = await exportNote({ win: s.win, vaults: s.vaults, sessionId: s.id, callerToken: s.callerToken, relPath: path, format, outFile, trusted: s.trusted });
		if (result?.output) s.vaults.refreshIfInside(result.output);
		return result;
	});

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
		s.vaults.refreshIfInside(target);
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
		s.vaults.refreshIfInside(target);
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
