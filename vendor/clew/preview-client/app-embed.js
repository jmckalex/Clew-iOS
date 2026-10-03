// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// An `@app[…]` embed in a preview document (docs/dev/frame-bridge.md §7):
// main resolved it as the document was served (app-embeds-rewrite.js — key,
// name, entry URL on its own origin). This tells the HOST (the app page,
// window.top) the embed is here, and builds the frame only when the host
// says the app may run: in a vault this device has not trusted, that is
// after the user's answer (R1, choice B). The frame is sandboxed —
// `allow-scripts allow-same-origin allow-forms` is safe because its origin
// is not this document's — and carries no referrer, so this document's URL
// (which holds the session id) never reaches it.
//
// The frame is HOISTED out of the morphed flow, as office live embeds are
// (office-embed.js): any DOM move reloads an iframe, and a morph that
// re-creates the `<clew-app-embed>` (an edit above it changing the note's
// structure — measured: an app's own insert turned the heading into a
// paragraph, and the app restarted) would restart the app. So the
// `<clew-app-embed>` stays in the flow as a sized PLACEHOLDER, and the
// running frame lives in a holder on document.body (data-clew-keep: morphs
// never discard it) positioned over it. An embed is known by its key and
// its place among that key's embeds, so a re-created placeholder finds its
// running app again; one that is gone takes its app with it.
import { topOrigin, postTo } from '../shared/message-guard.js';

const asked = new Set();          // embed ids announced to the host
const running = new Set();        // keys the host said may run
const holders = new Map();        // embed id → holder on document.body

/** Every placeholder, with its id: key + its place among that key's. */
function placeholders() {
	const counts = new Map();
	return [...document.querySelectorAll('clew-app-embed[data-app-key]')].map((el) => {
		const key = el.dataset.appKey;
		const n = counts.get(key) ?? 0;
		counts.set(key, n + 1);
		return { el, key, id: `${key}:${n}` };
	});
}

function label(el, text) {
	let span = el.querySelector(':scope > .clew-app-label');
	if (!span) {
		span = document.createElement('span');
		span.className = 'clew-app-label';
		el.prepend(span);
	}
	span.textContent = text;
	span.hidden = !text;
}

function position() {
	const live = new Map(placeholders().map((p) => [p.id, p.el]));
	for (const [id, holder] of holders) {
		const el = live.get(id);
		if (!el) continue;
		const rect = el.getBoundingClientRect();
		holder.style.top = `${rect.top + window.scrollY}px`;
		holder.style.left = `${rect.left + window.scrollX}px`;
		holder.style.width = `${rect.width}px`;
		holder.style.height = `${rect.height}px`;
	}
}

function start({ el, id }) {
	label(el, '');
	if (holders.has(id)) return;
	const frame = document.createElement('iframe');
	frame.className = 'clew-app-frame';
	frame.setAttribute('sandbox', 'allow-scripts allow-same-origin allow-forms');
	frame.setAttribute('referrerpolicy', 'no-referrer');
	frame.title = el.dataset.appName ?? 'App';
	const holder = document.createElement('div');
	holder.className = 'clew-app-holder';
	holder.setAttribute('data-clew-keep', '');
	holder.dataset.appId = id;
	holder.append(frame);
	document.body.append(holder);
	holders.set(id, holder);
	frame.src = el.dataset.appSrc;   // after insertion: a parser-made frame detached early never loads
	position();
}

function stopKey(key, text) {
	for (const [id, holder] of holders) {
		if (id.startsWith(`${key}:`)) { holder.remove(); holders.delete(id); }
	}
	for (const p of placeholders()) if (p.key === key) label(p.el, text(p.el));
}

/** After a load or a re-render: announce what is new, start what may run,
 *  stop what is gone, and put every running app back over its place. */
export function scanAppEmbeds() {
	const now = placeholders();
	for (const p of now) {
		if (running.has(p.key)) { start(p); continue; }
		if (asked.has(p.id)) continue;
		asked.add(p.id);
		label(p.el, p.el.dataset.appRestricted ? `${p.el.dataset.appName ?? 'App'} — waiting for your answer` : `${p.el.dataset.appName ?? 'App'} — starting…`);
		postTo(window.top, { source: 'clew-preview', type: 'app-embed', key: p.key, notePath: p.el.dataset.appNote ?? null }, topOrigin());
	}
	const ids = new Set(now.map((p) => p.id));
	for (const [id, holder] of holders) {
		if (!ids.has(id)) { holder.remove(); holders.delete(id); }
	}
	position();
}

window.addEventListener('message', (event) => {
	if (event.source !== window.top) return;
	const msg = event.data;
	if (msg?.source !== 'clew-preview-host' || typeof msg.key !== 'string') return;
	if (msg.type === 'app-run') {
		running.add(msg.key);
		for (const p of placeholders()) if (p.key === msg.key) start(p);
	} else if (msg.type === 'app-denied') {
		running.delete(msg.key);
		stopKey(msg.key, (el) => `${el.dataset.appName ?? 'App'} — not allowed to run here (Settings → This vault → Apps)`);
	} else if (msg.type === 'app-reload') {
		// Its grants changed: start over — the host asks again if it must.
		running.delete(msg.key);
		stopKey(msg.key, () => '');
		for (const id of [...asked]) if (id.startsWith(`${msg.key}:`)) asked.delete(id);
		scanAppEmbeds();
	}
});

window.addEventListener('resize', position);
// Layout shifts without a morph (images, MathJax) move the placeholders too.
if (document.body) new ResizeObserver(position).observe(document.body);
else document.addEventListener('DOMContentLoaded', () => new ResizeObserver(position).observe(document.body));
