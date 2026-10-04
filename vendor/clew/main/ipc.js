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
import { app, clipboard, dialog, ipcMain, shell } from 'electron';
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
import { getPdfMeta, setPdfMeta } from './pdf-meta.js';
import { listPlugins, enabledPlugins } from './plugins.js';
import { ShellSessions } from './shell-core.js';
import { paths } from './paths.js';
import { trust, takeTrustNotice } from './trust.js';
import { ENABLE_KEYS, identityKey } from './vault-trust.js';
import { readVaultRequests } from './vault-requests.js';
import { codeSummary } from './vault-code.js';
import { insideByRealpath } from '../engine/vault-bounds.js';
import { appByKey, stateOf, grants } from './app-registry.js';
import { appKey, appsById, describeCapabilities } from './app-frames.js';
import { callApp } from './app-calls.js';
import { checkForUpdate } from './updater.js';
import { registeredRemoteUrl, saveRemoteCopy } from './remote-pdfs.js';
import { planOpen, pathFromFileUrl } from './open-file.js';
import { resolvedCallouts } from './callout-types.js';
import { iconTable } from './callout-files.js';
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

/** Settings → General → Trusted vaults: every vault this device has
 *  decided on, newest decision first, with whether a window has it open. */
function trustedVaultsList() {
	const open = new Map(allSessions().filter((x) => x.vaults.root).map((x) => [identityKey(x.vaults.root), x]));
	return Object.entries(trust.entries())
		.map(([key, entry]) => ({
			key,
			name: nodePath.basename(key),
			trusted: entry.trusted === true,
			decided: entry.decided !== false,
			source: entry.source ?? null,
			at: entry.at ?? null,
			exists: fs.existsSync(key),
			open: open.has(key),
		}))
		.sort((a, b) => String(b.at).localeCompare(String(a.at)));
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
	// `guard`: an editor's save, refused over a version not seen
	// (write-guard.js) — answered `{ conflict, disk }`; `force` overrides.
	handle(CH.NOTE_WRITE, (s, { path, content, guard = false, force = false }) => s.vaults.writeNote(path, content, { guard, force }));
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
	// Quote-and-cite's memory of a PDF (pdf-meta.js): its chosen entry, its
	// printed-page offset. The path is checked to be the vault's own PDF.
	handle(CH.PDF_META_GET, (s, { path }) => {
		if (!s.vaults.root || !/\.pdf$/i.test(String(path))) return null;
		s.vaults.resolve(path);
		return getPdfMeta(s.vaults.root, path);
	});
	handle(CH.PDF_META_SET, (s, { path, patch }) => {
		if (!s.vaults.root || !/\.pdf$/i.test(String(path))) throw new Error('Not a PDF in this vault');
		s.vaults.resolve(path);
		return setPdfMeta(s.vaults.root, path, patch);
	});
	// A conflict's versions, kept before anything is chosen (conflicts.js).
	handle(CH.HISTORY_KEEP, (s, { path, text }) => s.vaults.keepVersion(path, text));
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
				// A restricted vault's link out is not part of it.
				if (s.vaults.restricted && kind && !insideByRealpath(abs, s.vaults.root)) continue;
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
	// Guarded by the version the viewer loaded (`base`); `force` is "Keep
	// mine", `create` the conflict copy (main/pdf-guard.js, vault.writePdf).
	// What a clew:// link or the `clew` command left for this window to show
	// (main/deep-link-host.js) — handed over ONCE.
	handle(CH.DEEP_LINK_TAKE, (s) => {
		const links = s.pendingLinks ?? [];
		s.pendingLinks = [];
		return links;
	});
	handle(CH.PDF_WRITE, (s, { path, bytes, base, force, create }) => s.vaults.writePdf(path, bytes, { base, force: Boolean(force), create: Boolean(create) }));
	// A conflict's version from the PDF's history — the conflict sheet's way
	// to "Keep mine" / "Keep both" when the viewer that held mine is gone.
	handle(CH.PDF_VERSION_RESTORE, (s, { path, name, to, create }) => {
		const bytes = s.vaults.pdfVersion(path, name);
		if (!bytes) throw new Error(`No such version of ${path}: ${name}`);
		return s.vaults.writePdf(to ?? path, bytes, { force: !create, create: Boolean(create) });
	});
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
		if (!/^https?:|^mailto:/i.test(url)) return;
		// A scenario must never launch a browser: it reads this line instead.
		if (process.env.CLEW_SMOKE) console.log(`smoke-open-external: ${url}`);
		else shell.openExternal(url);
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
		const { custom, problems } = resolvedCallouts(settings.get('callouts'), vaultList, () => iconTable(paths.faIcons));
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
		decided: s.access.decided === true,
		refused: s.trusted ? [] : s.renderService.refusedNames(),
		notice: takeTrustNotice(),
		// The prompt is modal; under the smoke harness every fixture is
		// undecided, and one over a fixture with code would swallow a
		// scenario's input — so it is drawn there only when asked for.
		prompt: !process.env.CLEW_SMOKE || !!process.env.CLEW_SMOKE_TRUST_PROMPT,
	}));
	// Trusting or restricting reloads the window (§4.6): code that already
	// runs — vault scripts in previews, plugins in the app page — can only be
	// stopped, or started under a new CSP, by a fresh page. Asked first with
	// the close question, so an unsaved office document or PDF annotation
	// gets its Save/Discard/Cancel moment; a Cancel changes nothing.
	// `enable` (the prompt's yes) is what the vault asked for; a vault never
	// decided about and trusted from Settings gets its request too.
	handle(CH.VAULT_TRUST_SET, async (s, { trusted, enable = null }) => {
		if (!s.vaults.root) return { trusted: false };
		const root = s.vaults.root;
		// Keep restricted, for a vault already restricted: the answer is
		// recorded and nothing that runs changes — no reload.
		if (trusted !== true && !s.trusted) {
			trust.revoke(root);
			s.refreshAccess();
			return { trusted: false };
		}
		const proceed = await (s.askToReload ? s.askToReload() : Promise.resolve(true));
		if (!proceed) return { trusted: s.trusted, cancelled: true };
		if (trusted === true) {
			const grant = enable ?? (s.access.decided ? null : readVaultRequests(root)?.enable ?? null);
			trust.trust(root, 'user', grant);
		} else {
			trust.revoke(root);
		}
		s.refreshAccess();
		s.send(CH.EV_VAULT_TRUST_CHANGED, { trusted: s.trusted });
		setImmediate(() => { if (!s.win?.isDestroyed()) s.win.webContents.reload(); });
		return { trusted: s.trusted, reloading: true };
	});
	// What this vault may run here, with the device's enablement record and
	// the vault's own request beside it (Settings → This vault).
	handle(CH.VAULT_ACCESS_GET, (s) => {
		if (!s.vaults.root) return null;
		return {
			...s.access,
			enable: trust.enablements(s.vaults.root),
			requests: readVaultRequests(s.vaults.root)?.enable ?? null,
			refused: s.trusted ? [] : s.renderService.refusedNames(),
		};
	});
	// One enablement (§4.6). Also written into the vault's own settings as
	// its REQUEST, so a vault keeps asking for what its author uses when it
	// is shared onwards — never read back as a grant. Vault scripts and the
	// network change what a loaded preview runs, so they reload the window
	// like trust; the rest apply live (plugins as their toggle always has).
	handle(CH.VAULT_ACCESS_SET, async (s, { key, value }) => {
		if (!s.vaults.root || !ENABLE_KEYS.includes(key)) return null;
		const root = s.vaults.root;
		const reload = (key === 'scripts' || key === 'network') && s.trusted;
		if (reload && s.askToReload && !(await s.askToReload())) return { cancelled: true };
		trust.setEnable(root, { [key]: value });
		if (key !== 'scripts') {
			const current = s.vaults.loadState('vault-settings.json') ?? {};
			if (key === 'plugins' ? JSON.stringify(current.plugins ?? []) !== JSON.stringify(value) : (current[key] === true) !== (value === true)) {
				current[key] = key === 'plugins' ? value : value === true;
				s.vaults.saveState('vault-settings.json', current);
			}
		}
		s.refreshAccess();
		s.send(CH.EV_VAULT_ACCESS_CHANGED, s.access);
		if (reload) setImmediate(() => { if (!s.win?.isDestroyed()) s.win.webContents.reload(); });
		return { ...s.access, reloading: reload };
	});
	// What the vault contains that would run (§4.5): the prompt's counts
	// and Details, read from the tree and the index.
	handle(CH.VAULT_CODE_SUMMARY, (s) => {
		if (!s.vaults.root) return null;
		return codeSummary({
			root: s.vaults.root,
			notePaths: s.indexer.notes.keys(),
			requests: readVaultRequests(s.vaults.root),
			globalDir: paths.globalPlugins,
		});
	});
	// Settings → General → Trusted vaults: every vault this device has
	// decided on, and whether a window has it open.
	handleGlobal(CH.TRUSTED_VAULTS_LIST, () => trustedVaultsList());
	// Revoke, trust or forget one of them. A vault open in a window goes
	// through that window (the reload, its close question).
	handleGlobal(CH.TRUSTED_VAULTS_SET, async ({ key, action }) => {
		const open = allSessions().find((x) => x.vaults.root && identityKey(x.vaults.root) === key);
		if (open) {
			const proceed = await (open.askToReload ? open.askToReload() : Promise.resolve(true));
			if (!proceed) return { cancelled: true, list: trustedVaultsList() };
		}
		const root = open?.vaults.root ?? key;
		if (action === 'forget') trust.forgetKey(key);
		else if (action === 'trust') trust.trust(root);
		else if (action === 'revoke') trust.revoke(root);
		if (open) {
			open.refreshAccess();
			open.send(CH.EV_VAULT_TRUST_CHANGED, { trusted: open.trusted });
			setImmediate(() => { if (!open.win?.isDestroyed()) open.win.webContents.reload(); });
		}
		return { list: trustedVaultsList() };
	});
	// ---- the update check (docs/dev/auto-update.md) -------------------------
	handleGlobal(CH.UPDATE_CHECK, () => checkForUpdate({ manual: true }));
	handleGlobal(CH.UPDATE_SKIP, ({ version }) => {
		if (typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version)) settings.set('skippedUpdate', version);
		return true;
	});

	// ---- apps in notes (frame-bridge.md §7–§9) ---------------------------
	// An app's clipboard (the `clipboard` capability) is the system's — but
	// never under the smoke harness, which must leave the user's clipboard
	// alone, unless a scenario asks for the real one (CLEW_SMOKE_CLIPBOARD).
	const memoryClipboard = (() => { let text = ''; return { writeText: (t) => { text = String(t); }, readText: () => text }; })();
	const appClipboard = process.env.CLEW_SMOKE && !process.env.CLEW_SMOKE_CLIPBOARD ? memoryClipboard : clipboard;
	// Only for an app THIS window registered (it served the note embedding
	// it): a key another window holds is not this window's business.
	const ownApp = (s, key) => {
		const registered = appByKey(key);
		return registered && registered.sessionId === s.id ? registered : null;
	};
	const appStatus = (s, key, registered) => {
		const restricted = !s.trusted;
		const st = stateOf(registered, restricted);
		return {
			key, id: registered.manifest.id, name: registered.manifest.name, folder: registered.folder,
			capabilities: registered.manifest.capabilities, network: registered.manifest.network,
			ask: st.ask, askRun: st.askRun, changed: st.changed, mayRun: st.mayRun, granted: st.granted,
			restricted, describe: Object.fromEntries(registered.manifest.capabilities.map((c, i) => [c, describeCapabilities(registered.manifest.capabilities, registered.manifest.network)[i]])),
		};
	};
	handle(CH.APP_STATUS, (s, { key }) => {
		const registered = ownApp(s, key);
		return registered ? appStatus(s, key, registered) : null;
	});
	// The prompt's answer, for everything it asked: Allow grants the asked
	// capabilities (and, restricted, the run); Don't allow denies them. In a
	// restricted vault an app holding `network` is pinned to the code that
	// was approved (choice C).
	handle(CH.APP_ANSWER, (s, { key, allow }) => {
		const registered = ownApp(s, key);
		if (!registered) return null;
		const restricted = !s.trusted;
		const st = stateOf(registered, restricted);
		const asked = st.ask;
		const pin = restricted && allow === true && (asked.includes('network') || st.granted.includes('network'));
		grants.answer(registered.vault, registered.manifest.id, {
			granted: allow === true ? asked : [],
			denied: allow === true ? [] : asked,
			...(st.askRun || st.changed ? { run: allow === true } : {}),
			...(pin ? { code: st.code() } : (allow === true && st.changed ? { code: null } : {})),
			folder: registered.folder,
		});
		// No EV_APP_GRANTS_CHANGED here: the host that asked is waiting on
		// this answer and carries on (app-host.js); that event is for a grant
		// changed from elsewhere (Settings → Revoke), which reloads frames.
		return appStatus(s, key, registered);
	});
	handle(CH.APP_CALL, (s, { key, notePath, method, params }) => {
		const registered = ownApp(s, key);
		if (!registered) return { ok: false, error: { code: 'denied', message: 'no such app in this window' } };
		const restricted = !s.trusted;
		const st = stateOf(registered, restricted);
		if (!st.mayRun) return { ok: false, error: { code: 'denied', message: 'this app has not been allowed to run here' } };
		const out = callApp({
			root: s.vaults.root, restricted, excludes: s.vaults.excludes,
			notePath: typeof notePath === 'string' ? notePath : null,
			app: registered, granted: new Set(st.granted),
			indexer: s.indexer, search: s.searchService, kv: s.kvStore, clipboard: appClipboard,
		}, String(method), params);
		// A note an app created is a new file Clew wrote: the tree shows it
		// now, whatever the watcher's budget (CLAUDE.md).
		if (out.ok && out.result?.created) s.vaults.refreshTree();
		return out;
	});
	// Settings → This vault → Apps: every app the vault carries, with what
	// this device has let it do.
	handle(CH.APPS_LIST, (s) => {
		if (!s.vaults.root) return [];
		const vault = identityKey(s.vaults.root);
		const records = grants.list(vault);
		const ids = appsById(s.vaults.root, s.indexer.appFolders);
		const out = [];
		for (const [id, folders] of ids) {
			const r = records[id] ?? null;
			out.push({ id, key: appKey(vault, id), folders, duplicate: folders.length > 1, granted: Object.keys(r?.granted ?? {}), denied: Object.keys(r?.denied ?? {}), run: Boolean(r?.run), runDenied: Boolean(r?.runDenied), pinned: Boolean(r?.code) });
		}
		for (const [id, r] of Object.entries(records)) {
			if (!ids.has(id)) out.push({ id, key: appKey(vault, id), folders: r.folder ? [r.folder] : [], missing: true, granted: Object.keys(r.granted ?? {}), denied: Object.keys(r.denied ?? {}), run: Boolean(r.run), runDenied: Boolean(r.runDenied), pinned: Boolean(r.code) });
		}
		return out.sort((a, b) => a.id.localeCompare(b.id));
	});
	// Revoking forgets the app here: its ports close and its frames reload,
	// so it asks again (§9).
	handle(CH.APP_REVOKE, (s, { id }) => {
		if (!s.vaults.root) return false;
		const vault = identityKey(s.vaults.root);
		const done = grants.revoke(vault, String(id));
		s.send(CH.EV_APP_GRANTS_CHANGED, { key: appKey(vault, String(id)) });
		return done;
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
		// (`plugins`, `noteApi`, `dataviewJs` and `network` written here are
		// the vault's REQUEST only — frame-bridge.md §4.2. What runs is the
		// device's enablement, changed through VAULT_ACCESS_SET, which
		// reconfigures through the session's access.)
		if (key === 'jmarkdownProject' || key === 'normalSyntax' || key === 'pandocCitations') {
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

	// Every plugin available here, and which may run: `enabled` is what the
	// DEVICE enabled for this vault and trust allows (a vault plugin only in
	// a trusted vault — enabledPlugins), `requested` the vault's own ask.
	// The list includes a restricted vault's own plugins, so Settings can
	// show them as held back.
	handle(CH.PLUGINS_LIST, (s) => {
		if (!s.vaults.isOpen) return { plugins: [], enabled: [], requested: [], trusted: false, globalDir: paths.globalPlugins };
		const vaultSettings = s.vaults.loadState('vault-settings.json') ?? {};
		return {
			plugins: listPlugins(s.vaults.root, paths.globalPlugins, { vault: true }),
			enabled: enabledPlugins(s.vaults.root, s.access, paths.globalPlugins).map((p) => p.id),
			switchedOn: [...s.access.plugins],
			requested: Array.isArray(vaultSettings.plugins) ? vaultSettings.plugins : [],
			trusted: s.trusted === true,
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
			access: s.access,
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
