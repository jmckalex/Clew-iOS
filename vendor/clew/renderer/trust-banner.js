// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The vault-trust chrome (docs/dev/frame-bridge.md §4.5, §4.8):
//
//   - THE PROMPT, on the first open of a vault on this device that contains
//     something that would run (main/vault-code.js — its scripts, its own
//     plugins, notes with code, what its settings ask for): "This vault
//     contains code: … Trust this vault on this Mac?" (or this iPad, … —
//     lib/device-name.js) with a Details disclosure naming the files,
//     and — only when the vault asks for it —
//     "Let its scripts reach the internet", off. A vault with nothing to run
//     never asks (the owner's decision 10). Trust reloads the window
//     (ipc.js VAULT_TRUST_SET); Keep restricted records the answer.
//   - THE INDICATOR, "Restricted · Trust…" in the status bar, while a
//     restricted vault has code — what it contains, or what a render
//     refused (the engine's `data-jmd-refused` names from main, and the
//     preview client's report of a script the CSP stopped). It reopens the
//     prompt.
//   - THE NOTICE, once, on the first launch with the full design: what
//     changed, which known vaults are restricted, where Trusted vaults live.
//
// All of it is drawn by the app page, never inside a preview, where a note
// could imitate it.
import { ipc, CH } from './ipc.js';
import { fromPreviewOrigin } from '../shared/message-guard.js';
import { openSettings } from './commands/actions.js';
import { DEVICE } from './lib/device-name.js';

let trusted = true;
let decided = true;
let summary = null;
const refused = new Set();
let sheet = null;
let indicator = null;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function notices() {
	let el = document.querySelector('.clew-notices');
	if (!el) {
		el = document.createElement('div');
		el.className = 'clew-notices';
		document.body.append(el);
	}
	return el;
}

// ---- the indicator ----------------------------------------------------------

function hasCode() {
	return refused.size > 0 || (summary && !summary.empty);
}

function updateIndicator() {
	const bar = document.querySelector('clew-status-bar');
	if (trusted || !hasCode() || !bar) {
		indicator?.remove();
		indicator = null;
		return;
	}
	if (!indicator) {
		indicator = document.createElement('button');
		indicator.className = 'status-item clew-trust-indicator';
		indicator.setAttribute('data-status-keep', '');
		indicator.textContent = 'Restricted · Trust…';
		indicator.addEventListener('click', () => openPrompt());
	}
	if (!indicator.isConnected) bar.prepend(indicator);
	const held = [...refused];
	indicator.title = `This vault's code does not run on ${DEVICE}.`
		+ (held.length ? ` Not run: ${held.join(', ')}.` : '');
}

function addRefused(names) {
	for (const name of names ?? []) if (name) refused.add(String(name));
	updateIndicator();
}

// ---- the prompt ---------------------------------------------------------------

function countsSentence(s) {
	const parts = [];
	if (s.scripts.length) parts.push(plural(s.scripts.length, 'script'));
	if (s.plugins.length) parts.push(`${plural(s.plugins.length, 'plugin')} (${s.plugins.map((p) => p.name).join(', ')})`);
	if (s.noteCount) parts.push(plural(s.noteCount, 'note') + ' with scripts');
	return parts.length ? `This vault contains code: ${parts.join(', ')}.` : 'This vault asks to run code.';
}

function asksSentence(s) {
	const asks = [];
	if (s.requests.noteApi) asks.push('the Note API');
	if (s.requests.dataviewJs) asks.push('dataviewjs');
	if (s.globalRequests.length) asks.push(`your plugin${s.globalRequests.length === 1 ? '' : 's'} ${s.globalRequests.map((p) => p.name).join(', ')}`);
	return asks.length ? `It asks for ${asks.join(', ').replace(/, ([^,]*)$/, ' and $1')}.` : '';
}

function details(s) {
	const box = document.createElement('details');
	box.className = 'clew-trust-details';
	const head = document.createElement('summary');
	head.textContent = 'Details';
	const list = document.createElement('ul');
	const item = (text) => {
		const li = document.createElement('li');
		li.textContent = text;
		list.append(li);
	};
	for (const f of s.scripts) item(`.clew/scripts/${f} — runs in every note`);
	for (const p of s.plugins) item(`.clew/plugins/${p.id} — plugin “${p.name}”`);
	for (const n of s.notes) item(`${n.path} — ${n.kinds.join(', ')}`);
	if (s.noteCount > s.notes.length) item(`… and ${plural(s.noteCount - s.notes.length, 'more note')}`);
	if (s.requests.noteApi) item('Note API — scripts in notes may read and write notes and run commands');
	if (s.requests.dataviewJs) item('dataviewjs — JavaScript blocks run against the vault');
	for (const p of s.globalRequests) item(`your global plugin “${p.name}” — enabled for this vault`);
	box.append(head, list);
	return box;
}

function closePrompt() {
	sheet?.remove();
	sheet = null;
}

function drawPrompt(s) {
	closePrompt();
	sheet = document.createElement('div');
	sheet.className = 'clew-trust-sheet';
	sheet.setAttribute('role', 'dialog');
	sheet.setAttribute('aria-modal', 'true');
	const card = document.createElement('div');
	card.className = 'clew-trust-card';
	const title = document.createElement('h2');
	title.textContent = 'Trust this vault?';
	const lead = document.createElement('p');
	lead.textContent = `${countsSentence(s)} ${asksSentence(s)}`.trim();
	const why = document.createElement('p');
	why.className = 'clew-trust-why';
	why.textContent = `A vault's code can read every note in it. Restricted, none of it runs on ${DEVICE}; `
		+ 'everything Clew itself does — rendering, maths, diagrams, PDFs, queries, editing — still works.';
	card.append(title, lead, why, details(s));
	let network = null;
	if (s.requests.network) {
		const label = document.createElement('label');
		label.className = 'clew-trust-network';
		network = document.createElement('input');
		network.type = 'checkbox';
		label.append(network, ' Let its scripts reach the internet');
		card.append(label);
	}
	const buttons = document.createElement('div');
	buttons.className = 'clew-trust-buttons';
	const keep = document.createElement('button');
	keep.className = 'clew-trust-keep';
	keep.textContent = 'Keep restricted';
	const yes = document.createElement('button');
	yes.className = 'clew-trust-button';
	yes.textContent = `Trust on ${DEVICE}`;
	keep.addEventListener('click', () => {
		closePrompt();
		decided = true;
		ipc.invoke(CH.VAULT_TRUST_SET, { trusted: false }).catch(() => {});
		updateIndicator();
	});
	yes.addEventListener('click', () => {
		yes.disabled = keep.disabled = true;
		const enable = {
			scripts: true,
			plugins: [...s.plugins.map((p) => p.id), ...s.globalRequests.map((p) => p.id)],
			noteApi: s.requests.noteApi,
			dataviewJs: s.requests.dataviewJs,
			network: network?.checked === true,
		};
		ipc.invoke(CH.VAULT_TRUST_SET, { trusted: true, enable })
			.then((result) => {
				// A Cancel in the close question leaves things as they were.
				if (result?.cancelled) yes.disabled = keep.disabled = false;
				else closePrompt();
			})
			.catch(() => { yes.disabled = keep.disabled = false; });
	});
	buttons.append(keep, yes);
	card.append(buttons);
	sheet.append(card);
	// Esc or a click outside puts the question away for now; it is asked
	// again on the next opening, and the indicator still offers it.
	sheet.addEventListener('click', (e) => { if (e.target === sheet) closePrompt(); });
	sheet.addEventListener('keydown', (e) => {
		if (e.key === 'Escape') {
			e.stopPropagation();
			closePrompt();
		}
	});
	document.body.append(sheet);
	// The question has focus, not "Trust": a key typed as it appears must
	// not answer it (app-host.js#drawPrompt, measured 2026-10-04).
	card.tabIndex = -1;
	card.focus();
}

async function openPrompt() {
	summary ??= await ipc.invoke(CH.VAULT_CODE_SUMMARY).catch(() => null);
	drawPrompt(summary ?? {
		scripts: [], plugins: [], notes: [], noteCount: 0, globalRequests: [],
		requests: { noteApi: false, dataviewJs: false, network: false }, empty: true,
	});
}

// ---- the one-time notice -------------------------------------------------------

function showNotice({ restricted = [] } = {}) {
	const note = document.createElement('div');
	note.className = 'clew-notice clew-trust-banner clew-trust-notice';
	note.setAttribute('role', 'status');
	const text = document.createElement('span');
	text.textContent = 'Clew now asks before running a vault\'s code. The vaults you already '
		+ `used are trusted on ${DEVICE}`
		+ (restricted.length ? `; restricted: ${restricted.join(', ')}.` : '.');
	const open = document.createElement('button');
	open.className = 'clew-trust-button';
	open.textContent = 'Trusted vaults…';
	open.addEventListener('click', () => {
		note.remove();
		openSettings();
	});
	const close = document.createElement('button');
	close.className = 'clew-trust-dismiss';
	close.textContent = '×';
	close.setAttribute('aria-label', 'Dismiss');
	close.addEventListener('click', () => note.remove());
	note.append(text, open, close);
	notices().prepend(note);
}

// ---- wiring ----------------------------------------------------------------------

/** A vault is on screen (opened, or the window reloaded): start over. */
export function trustBannerVaultShown() {
	closePrompt();
	trusted = true;
	decided = true;
	summary = null;
	refused.clear();
	updateIndicator();
	ipc.invoke(CH.VAULT_TRUST_GET).then(async (state) => {
		if (state?.notice) showNotice(state.notice);
		trusted = state?.trusted === true;
		decided = state?.decided !== false;
		addRefused(state?.refused);
		if (trusted) return;
		summary = await ipc.invoke(CH.VAULT_CODE_SUMMARY).catch(() => null);
		updateIndicator();
		if (!decided && summary && !summary.empty && state.prompt !== false) drawPrompt(summary);
	}).catch(() => {});
}

export function installTrustBanner() {
	ipc.on(CH.EV_NOTE_CODE_REFUSED, ({ names }) => {
		trusted = false;
		addRefused(names);
	});
	ipc.on(CH.EV_VAULT_TRUST_CHANGED, ({ trusted: now }) => {
		trusted = now === true;
		if (trusted) refused.clear();
		updateIndicator();
	});
	// The preview client reports what the CSP stopped (a note's own
	// <script>, an onclick=) — only a preview-origin document is heard.
	window.addEventListener('message', (event) => {
		if (!fromPreviewOrigin(event)) return;
		const data = event.data;
		if (data?.source === 'clew-preview' && data.type === 'code-refused') addRefused([data.name]);
	});
}
