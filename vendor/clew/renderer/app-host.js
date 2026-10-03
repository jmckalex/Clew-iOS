// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The app page's half of the bridge (docs/dev/frame-bridge.md §7–§9). The
// app page is the HOST — never the preview document around an app, which is
// vault content:
//
//   1. A preview document that holds an `@app[…]` embed (preview-client/
//      app-embed.js) tells the host `app-embed` with the app's key. The host
//      asks main what the app may do (APP_STATUS) and, when something is
//      unanswered, draws the PROMPT — on the app page, outside every frame,
//      so neither the app nor the note can forge it. In a vault this device
//      has not trusted the frame is not even created until the answer (R1,
//      choice B); in a trusted one it starts at once and waits for its port.
//   2. The app's bridge client (clew-bridge.js) says hello to window.top.
//      The host knows WHICH app by the sender's origin — clew-frame://<key>,
//      which only Clew's handler serves — and accepts it only from a frame
//      whose parent is a document that announced that key. It answers with
//      a fresh MessageChannel port, transferred to that frame's origin.
//   3. Over the port: `{v, id, method, params}` → limits here (size, in
//      flight, rate) → main (APP_CALL), which checks the grant at call time.
//      `context` and `open` are answered here, `open` under `links.open`.
//   4. A grant revoked (Settings): every port of that app closes and its
//      frames reload — and ask again if they must. A grant ADDED (an app
//      asking for more later, answered Allow) reaches its live ports as a
//      `grant-changed` event instead; the embedding note's changes reach
//      the apps that may read it as `note-changed` (§8).
//   5. While an app with a write grant holds a live port, the status bar
//      says so (§9); Settings lists every live embed.
import { ipc, CH } from './ipc.js';
import { fromPreviewOrigin, PREVIEW_ORIGIN } from '../shared/message-guard.js';
import { settingsStore } from './state/settings-store.js';
import { workspaceStore } from './state/workspace-store.js';
import { vaultStore } from './state/vault-store.js';
import { editorPool } from './editor/pool.js';
import { minimalChange } from './editor/minimal-change.js';
import { parseProperties, applyProperties } from '../shared/frontmatter.js';
import { openSearchPanel, setSearchQuery, SearchQuery } from '@codemirror/search';
import { openWikilink } from './commands/actions.js';

const MAX_REQUEST = 1024 * 1024;
const MAX_IN_FLIGHT = 32;
const RATE = 50;     // requests per second, refilled continuously
const BURST = 200;
const WRITE_RATE = 5; // writes per second (§8)
const WRITES = new Set(['notes.write', 'notes.append', 'properties.set', 'notes.create', 'editor.insert', 'files.write', 'files.delete', 'kv.set']);

/** key → Set<WindowProxy> of the documents embedding it */
const embedders = new Map();
/** WindowProxy → note path it announced */
const notePaths = new Map();
/** key → Promise of the prompt being shown */
const prompts = new Map();
/** key → Set<port record> */
const ports = new Map();

const queue = [];
let showing = null;

function tellEmbedders(key, type) {
	for (const win of embedders.get(key) ?? []) {
		try { win.postMessage({ source: 'clew-preview-host', type, key }, PREVIEW_ORIGIN); } catch { /* gone */ }
	}
}

// ---- the prompt -----------------------------------------------------------

function promptText(status) {
	const asks = status.ask.map((c) => status.describe?.[c] ?? c);
	const where = status.restricted ? 'a vault you haven\'t trusted' : 'this vault';
	let lead = status.changed
		? `“${status.name}” has changed since you allowed it.`
		: `“${status.name}” is an app in ${where}.`;
	const wants = [];
	if (status.askRun) wants.push('run here');
	if (asks.length) {
		// The pair that matters most, said as the pair it is (§9).
		const reads = status.ask.some((c) => c === 'note.read' || c === 'notes.read');
		const net = status.ask.includes('network');
		wants.push(`${wants.length ? 'and to ' : ''}${asks.join(', ').replace(/, ([^,]*)$/, ' and $1')}`);
		if (reads && net) lead += ' It asks both to read and to send data out.';
	}
	return { lead, wants: wants.length ? `It wants to ${wants.join(', ')}.` : '' };
}

function drawPrompt(status, done) {
	const sheet = document.createElement('div');
	sheet.className = 'clew-trust-sheet clew-app-sheet';
	sheet.setAttribute('role', 'dialog');
	sheet.setAttribute('aria-modal', 'true');
	sheet.dataset.appKey = status.key;
	const card = document.createElement('div');
	card.className = 'clew-trust-card';
	const title = document.createElement('h2');
	title.textContent = `Allow “${status.name}”?`;
	const { lead, wants } = promptText(status);
	const p1 = document.createElement('p');
	p1.textContent = `${lead} ${wants}`.trim();
	const p2 = document.createElement('p');
	p2.className = 'clew-trust-why';
	p2.textContent = `Its code runs apart from Clew and from the vault, on an origin of its own; it reaches only what you allow here, on this device. From ${status.folder}/.`;
	const buttons = document.createElement('div');
	buttons.className = 'clew-trust-buttons';
	const no = document.createElement('button');
	no.className = 'clew-trust-keep';
	no.textContent = 'Don\'t allow';
	const yes = document.createElement('button');
	yes.className = 'clew-trust-button';
	yes.textContent = 'Allow';
	const answer = (allow) => {
		yes.disabled = no.disabled = true;
		ipc.invoke(CH.APP_ANSWER, { key: status.key, allow }).catch(() => null).then((after) => {
			sheet.remove();
			done(after);
		});
	};
	no.addEventListener('click', () => answer(false));
	yes.addEventListener('click', () => answer(true));
	buttons.append(no, yes);
	card.append(title, p1, p2, buttons);
	sheet.append(card);
	document.body.append(sheet);
	yes.focus();
}

function nextPrompt() {
	if (showing || queue.length === 0) return;
	const { status, resolve } = queue.shift();
	showing = status.key;
	drawPrompt(status, (after) => {
		showing = null;
		resolve(after);
		nextPrompt();
	});
}

/** The prompt for an app, once however many embeds ask; resolves to the
 *  status after the answer. */
function ensurePrompt(status) {
	if (!prompts.has(status.key)) {
		prompts.set(status.key, new Promise((resolve) => {
			queue.push({ status, resolve });
			nextPrompt();
		}).then((after) => {
			// A frame already running (a trusted vault's starts before the
			// answer) has its CSP from before it: a `network` grant reaches it
			// only through a reload.
			if (after?.granted?.includes('network') && !status.granted.includes('network')) tellEmbedders(status.key, 'app-reload');
			// Frames already holding a port (an app asking for more later):
			// what was granted reaches them live.
			else refreshGrants(status.key);
			return after;
		}).finally(() => prompts.delete(status.key)));
	}
	return prompts.get(status.key);
}

const status = (key) => ipc.invoke(CH.APP_STATUS, { key }).catch(() => null);
const needsAnswer = (st) => st && (st.askRun || st.ask.length > 0);

// ---- 1: a document announces an embed ---------------------------------------

async function onEmbed(event, msg) {
	const key = String(msg.key ?? '');
	if (!embedders.has(key)) embedders.set(key, new Set());
	embedders.get(key).add(event.source);
	if (typeof msg.notePath === 'string') notePaths.set(event.source, msg.notePath);
	let st = await status(key);
	if (!st) return tellEmbedders(key, 'app-denied');
	// Trusted: the frame starts now; only capabilities wait (for its port).
	if (st.mayRun && !st.askRun) {
		event.source.postMessage({ source: 'clew-preview-host', type: 'app-run', key }, PREVIEW_ORIGIN);
		if (st.ask.length) ensurePrompt(st);
		return;
	}
	if (needsAnswer(st)) st = (await ensurePrompt(st)) ?? (await status(key));
	tellEmbedders(key, st?.mayRun ? 'app-run' : 'app-denied');
}

// ---- 2: the app says hello ----------------------------------------------------

function keyOf(origin) {
	try {
		const url = new URL(origin);
		return url.protocol === 'clew-frame:' ? url.hostname : null;
	} catch {
		return null;
	}
}

async function onHello(event) {
	const key = keyOf(event.origin);
	const parent = event.source?.parent;
	if (!key || !parent || !embedders.get(key)?.has(parent)) return;   // not a frame a document announced
	if ([...(ports.get(key) ?? [])].some((r) => r.frame === event.source)) return;   // already has its port
	let st = await status(key);
	if (st && needsAnswer(st)) st = (await ensurePrompt(st)) ?? (await status(key));
	if (!st?.mayRun) {
		event.source.postMessage({ source: 'clew-app-host', type: 'refused', message: 'not allowed to run here' }, event.origin);
		return;
	}
	if ([...(ports.get(key) ?? [])].some((r) => r.frame === event.source)) return;
	const channel = new MessageChannel();
	const record = {
		key, name: st.name ?? st.id ?? 'App', frame: event.source, port: channel.port1, notePath: notePaths.get(parent) ?? null,
		granted: new Set(st.granted), inFlight: 0, tokens: BURST, at: performance.now(),
		writeTokens: WRITE_RATE, writeAt: performance.now(),
	};
	if (!ports.has(key)) ports.set(key, new Set());
	ports.get(key).add(record);
	channel.port1.onmessage = (e) => onRequest(record, e.data);
	event.source.postMessage({ source: 'clew-app-host', type: 'welcome', v: 1, granted: st.granted, tier2: false }, event.origin, [channel.port2]);
	livePortsChanged();
}

// ---- 3: requests over the port --------------------------------------------------

function reply(record, id, outcome) {
	try { record.port.postMessage({ v: 1, id, ...outcome }); } catch { /* closed */ }
}

function take(record, write) {
	const now = performance.now();
	record.tokens = Math.min(BURST, record.tokens + ((now - record.at) / 1000) * RATE);
	record.at = now;
	if (write) {
		record.writeTokens = Math.min(WRITE_RATE, record.writeTokens + ((now - record.writeAt) / 1000) * WRITE_RATE);
		record.writeAt = now;
		if (record.writeTokens < 1) return false;
	}
	if (record.tokens < 1) return false;
	record.tokens -= 1;
	if (write) record.writeTokens -= 1;
	return true;
}

async function onRequest(record, msg) {
	if (!msg || msg.v !== 1 || typeof msg.id !== 'string' || typeof msg.method !== 'string') return;
	const fail = (code, message) => reply(record, msg.id, { ok: false, error: { code, message } });
	let size = 0;
	try { size = JSON.stringify(msg.params ?? null).length; } catch { size = 0; }
	if (msg.params?.data instanceof ArrayBuffer) size += msg.params.data.byteLength;
	if (size > MAX_REQUEST && msg.method !== 'files.write') return fail('too-large', 'a request is limited to 1 MB');
	if (record.inFlight >= MAX_IN_FLIGHT) return fail('rate-limited', 'too many requests in flight');
	if (!take(record, WRITES.has(msg.method))) return fail('rate-limited', WRITES.has(msg.method) ? 'too many writes (5 a second)' : 'too many requests');
	record.inFlight++;
	try {
		if (msg.method === 'context') {
			return reply(record, msg.id, { ok: true, result: { path: record.notePath, theme: settingsStore.get('theme') ?? 'dark', vault: vaultStore.vault?.name ?? null } });
		}
		if (msg.method === 'open') return reply(record, msg.id, await openTarget(record, msg.params?.target));
		const out = await ipc.invoke(CH.APP_CALL, { key: record.key, notePath: record.notePath, method: msg.method, params: msg.params ?? {} })
			.catch((err) => ({ ok: false, error: { code: 'internal', message: String(err?.message ?? err) } }));
		// Main authorized a note edit; it is made HERE, through the editor
		// pool (§10), so undo, the dirty dot, auto-save and the conflict
		// banner treat it as they treat the user's own.
		if (out.ok && out.result?.perform) return reply(record, msg.id, await perform(out.result, msg.params ?? {}));
		reply(record, msg.id, out);
	} finally {
		record.inFlight--;
	}
}

async function openTarget(record, target) {
	if (!record.granted.has('links.open')) return { ok: false, error: { code: 'denied', message: 'open needs "links.open"' } };
	const t = String(target ?? '').trim();
	if (/^(https?:|mailto:)/i.test(t)) {
		await ipc.invoke(CH.SHELL_OPEN_EXTERNAL, { url: t }).catch(() => {});
		return { ok: true, result: true };
	}
	if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return { ok: false, error: { code: 'denied', message: 'only notes, http(s) and mailto links' } };
	const [notePart] = t.split('#');
	const path = vaultStore.notePaths().includes(notePart) ? notePart : vaultStore.resolveNoteName(notePart);
	if (!path || !vaultStore.notePaths().includes(path)) return { ok: false, error: { code: 'not-found', message: `no note ${notePart}` } };
	await openWikilink(t, { newTab: true });
	return { ok: true, result: true };
}

// ---- the write side, through the editor pool (§10) ---------------------------

const fail = (code, message) => ({ ok: false, error: { code, message } });
let headless = 0;

/** Apply `edit(text) → text` to a note: as a transaction on the editor the
 *  user has it open in, or through a headless pool entry that saves at once.
 *  A note whose editor has an unresolved conflict answers `conflict`. */
async function editNote(path, edit) {
	const editing = editorFor(path);
	if (editing) {
		const entry = editing;
		if (entry.conflict) return fail('conflict', `${path} changed on disk while it had unsaved edits; the user must resolve it first`);
		const before = entry.view.state.doc.toString();
		const change = minimalChange(before, edit(before));
		if (change) entry.view.dispatch({ changes: change, userEvent: 'input.app' });
		return { ok: true, result: true };
	}
	const tabId = `app-write:${++headless}`;
	try {
		const entry = await editorPool.open(tabId, path);
		if (entry.conflict) return fail('conflict', `${path} cannot be written now`);
		const before = entry.view.state.doc.toString();
		const change = minimalChange(before, edit(before));
		if (change) {
			entry.view.dispatch({ changes: change, userEvent: 'input.app' });
			await editorPool.saveNow(tabId);
		}
		return { ok: true, result: true };
	} finally {
		editorPool.close(tabId);
	}
}

/**
 * The editor the user is EDITING a note in, or null. A note can have
 * several pool entries — a split, a reading-mode tab whose editor stays
 * pooled — each its own state, kept in step through the disk: an app's edit
 * goes to ONE, the one in an editing mode (the active tab first), and
 * reaches the rest the way the user's own edits do. Only reading-mode
 * entries means "not open in an editor": the write goes headless.
 */
function editorFor(path) {
	const editing = editorPool.tabsFor(path).filter((id) => {
		const mode = workspaceStore.findTab(id)?.tab?.view?.mode;
		return mode === 'source' || mode === 'live';
	});
	const active = workspaceStore.activeTab()?.id;
	const id = editing.includes(active) ? active : editing[0];
	return id ? editorPool.get(id) : null;
}

async function perform(order, params) {
	try {
		switch (order.perform) {
			case 'write':
				return await editNote(order.path, () => String(params.content));
			case 'append':
				return await editNote(order.path, (text) => {
					const base = text === '' || text.endsWith('\n') ? text : `${text}\n`;
					return base + String(params.text);
				});
			case 'properties':
				return await editNote(order.path, (text) => {
					const { entries, clean } = parseProperties(text);
					if (!clean) throw Object.assign(new Error('frontmatter beyond the editable subset; refusing to rewrite it'), { code: 'denied' });
					const at = entries.findIndex((e) => e.key === params.key);
					if (params.value === null || params.value === undefined) { if (at !== -1) entries.splice(at, 1); }
					else if (at !== -1) entries[at].value = params.value;
					else entries.push({ key: params.key, value: params.value });
					return applyProperties(text, entries);
				});
			case 'insert': {
				const entry = editorFor(order.path);
				if (!entry?.view) return fail('unavailable', 'the note is not open in an editor');
				if (entry.conflict) return fail('conflict', 'the note has an unresolved conflict');
				entry.view.dispatch(entry.view.state.replaceSelection(String(params.text)), { userEvent: 'input.app' });
				return { ok: true, result: true };
			}
			case 'find': {
				const entry = editorFor(order.path);
				if (!entry?.view) return fail('unavailable', 'the note is not open in an editor');
				openSearchPanel(entry.view);
				entry.view.dispatch({ effects: setSearchQuery.of(new SearchQuery({ search: order.query })) });
				return { ok: true, result: true };
			}
			default:
				return fail('internal', `unknown order ${order.perform}`);
		}
	} catch (err) {
		return fail(err.code && !/^E[A-Z]+$/.test(err.code) ? err.code : 'internal', String(err.message ?? err));
	}
}

/** Clew's Find in a note, to the apps embedded in it that take part (§9). */
function forwardFind({ path, query }) {
	for (const set of ports.values()) {
		for (const record of set) {
			if (record.notePath !== path || !record.granted.has('find')) continue;
			try { record.port.postMessage({ v: 1, event: 'find', payload: { query } }); } catch { /* gone */ }
		}
	}
}

// ---- 4: grants changed ------------------------------------------------------------

function closePorts(key) {
	for (const record of ports.get(key) ?? []) {
		try { record.port.postMessage({ v: 1, event: 'closed', payload: {} }); } catch { /* gone */ }
		try { record.port.close(); } catch { /* gone */ }
	}
	ports.delete(key);
	livePortsChanged();
}

/**
 * The app's grants changed (an answer to a prompt, Settings). What was
 * ADDED reaches its live ports at once, as a `grant-changed` event (§8) —
 * an app asking for more later carries on with it, no reload. Anything
 * TAKEN AWAY — a capability, the run, or `network` either way (the CSP is
 * fixed when the document loads) — closes every port and reloads its frames,
 * which ask again if they must.
 */
async function refreshGrants(key) {
	const live = ports.get(key);
	if (!live?.size) return;
	const st = await status(key);
	const now = new Set(st?.mayRun ? st.granted : []);
	const reload = [...live].some((r) => [...r.granted].some((c) => !now.has(c)) || r.granted.has('network') !== now.has('network'));
	if (!st?.mayRun || reload) {
		closePorts(key);
		tellEmbedders(key, 'app-reload');
		return;
	}
	for (const record of live) {
		if ([...now].every((c) => record.granted.has(c))) continue;
		record.granted = new Set(now);
		try { record.port.postMessage({ v: 1, event: 'grant-changed', payload: { granted: [...now] } }); } catch { /* gone */ }
	}
	livePortsChanged();
}

// ---- 5: what the user is told -------------------------------------------------------

/** An app holding any of these can change notes. */
const WRITE_CAPS = ['note.write', 'notes.write', 'notes.create', 'editor.insert'];
let indicator = null;

/** Every live embed: { key, name, notePath, writes } — Settings lists them. */
export function liveEmbeds() {
	const out = [];
	for (const set of ports.values()) {
		for (const r of set) out.push({ key: r.key, name: r.name, notePath: r.notePath, writes: WRITE_CAPS.some((c) => r.granted.has(c)) });
	}
	return out;
}

/** Ports whose frame has gone (its note closed, re-rendered without it). */
function sweep() {
	let gone = false;
	for (const [key, set] of ports) {
		for (const r of [...set]) {
			if (r.frame && r.frame.closed) {
				try { r.port.close(); } catch { /* gone */ }
				set.delete(r);
				gone = true;
			}
		}
		if (!set.size) ports.delete(key);
	}
	if (gone) livePortsChanged();
}

/**
 * While an app with a WRITE grant holds a live port, the status bar says so
 * (§9: "an indicator shows while an app with write grants holds a live
 * port") — quiet, in the trust indicator's place, and a click opens Settings
 * at This vault → Apps, where it can be revoked.
 */
function livePortsChanged() {
	const writers = [...new Set(liveEmbeds().filter((e) => e.writes).map((e) => e.name))];
	const bar = document.querySelector('clew-status-bar');
	if (!writers.length || !bar) {
		indicator?.remove();
		indicator = null;
		return;
	}
	if (!indicator) {
		indicator = document.createElement('button');
		indicator.className = 'status-item clew-app-write-indicator';
		indicator.setAttribute('data-status-keep', '');
		indicator.addEventListener('click', openAppSettings);
	}
	indicator.textContent = writers.length === 1 ? `✎ ${writers[0]} can edit notes` : `✎ ${writers.length} apps can edit notes`;
	indicator.title = `Open now, and allowed to change your notes: ${writers.join(', ')}. Settings → This vault → Apps to revoke.`;
	if (!indicator.isConnected) bar.prepend(indicator);
}

async function openAppSettings() {
	const { runCommand } = await import('./commands/registry.js');
	runCommand('app:settings');
	for (let i = 0; i < 30; i++) {
		const apps = document.querySelector('[data-settings-subsection="apps"]');
		if (apps) { apps.scrollIntoView({ block: 'center' }); return; }
		await new Promise((r) => setTimeout(r, 100));
	}
}

/** The embedding note changed on disk (a save, a sync, another app): the
 *  apps in it that may READ it are told — `note-changed` (§8) — at most
 *  once per quarter second each. */
const noteTimers = new WeakMap();
function noteChanged(path) {
	for (const set of ports.values()) {
		for (const record of set) {
			if (record.notePath !== path || !(record.granted.has('note.read') || record.granted.has('notes.read'))) continue;
			if (noteTimers.has(record)) continue;
			noteTimers.set(record, setTimeout(() => {
				noteTimers.delete(record);
				try { record.port.postMessage({ v: 1, event: 'note-changed', payload: { path } }); } catch { /* gone */ }
			}, 250));
		}
	}
}

export function installAppHost() {
	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (msg?.source === 'clew-preview' && msg.type === 'app-embed' && fromPreviewOrigin(event)) {
			onEmbed(event, msg);
		} else if (msg?.source === 'clew-app' && msg.type === 'hello' && /^clew-frame:/.test(event.origin) && event.source) {
			onHello(event);
		}
	});
	// Settings → Revoke forgets the app here: its ports close and its frames
	// reload, so it asks again (an answer to a prompt goes through
	// refreshGrants instead, which tells live ports what was ADDED).
	ipc.on(CH.EV_APP_GRANTS_CHANGED, ({ key }) => {
		closePorts(key);
		tellEmbedders(key, 'app-reload');
	});
	ipc.on(CH.EV_FILE_CHANGED, ({ path } = {}) => { if (path) noteChanged(path); });
	setInterval(sweep, 2000);
	settingsStore.on('settings-changed', (k) => {
		if (k !== 'theme') return;
		for (const set of ports.values()) {
			for (const record of set) {
				try { record.port.postMessage({ v: 1, event: 'theme', payload: { theme: settingsStore.get('theme') } }); } catch { /* gone */ }
			}
		}
	});
	editorPool.on('find-query', forwardFind);
	ipc.on(CH.EV_VAULT_OPENED, () => {
		for (const key of [...ports.keys()]) closePorts(key);
		embedders.clear();
		notePaths.clear();
	});
}
