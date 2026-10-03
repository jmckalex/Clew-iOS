// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// window.clew — the note API, available to <script> tags inside rendered
// notes (reading mode and canvas embeds). Injected into <head> before any
// note content, so inline scripts can use it immediately; calls made before
// the host attaches simply resolve once it does. Everything is RPC over
// postMessage to the hosting Clew frame — in exported HTML there is no
// host, so feature-detect with `if (window.clew) …` (calls made anyway
// reject after a timeout rather than hanging forever).
//
//   await clew.kv.set('counter', 1);
//   clew.on('kv', ({ key, value }) => …);   // fires in EVERY open preview
//   await clew.open('Some Note#Heading');
//   const hits = await clew.search('tag:#project');

// What the document's CSP stopped (main/preview-csp.js — frame-bridge.md
// §4.4, §4.9), heard from the first script in <head> so nothing in the note
// runs before the listener exists. Every violation is logged as `clew-csp:`
// (the smoke sweeps count them: Clew's own features must cause none). In a
// vault this device has not trusted (`data-clew-restricted`), a refused
// script is reported to the app page's trust indicator, and every inline
// script and on…= handler in the body is marked where it stands, as the
// engine marks the constructs it refused — re-marked after each re-render,
// since a morph replaces the body's children and in such a document every
// one of them is the note's own (Clew's inline script is in <head>).
import { parentOrigin, postTo } from '../shared/message-guard.js';
(() => {
	const restricted = () => document.documentElement.hasAttribute('data-clew-restricted');
	const JS = /^(|text\/javascript|application\/javascript|module)$/i;
	const mark = (el, name) => {
		if (el.nextElementSibling?.hasAttribute('data-clew-refused-script')) return;
		const box = document.createElement(el.tagName === 'SCRIPT' ? 'div' : 'span');
		box.className = 'jmd-error jmd-refused';
		box.setAttribute('data-jmd-refused', name);
		box.setAttribute('data-clew-refused-script', '');
		box.textContent = `[${name} not run: note code is off]`;
		el.after(box);
	};
	const markAll = () => {
		if (!restricted() || !document.body) return;
		for (const el of document.body.querySelectorAll('script:not([src])')) {
			if (JS.test(el.getAttribute('type') ?? '') && !el.hasAttribute('data-type')) mark(el, 'script');
		}
		for (const el of document.body.querySelectorAll('*')) {
			if (el.hasAttribute('data-clew-refused-script')) continue;
			for (const attr of el.attributes) {
				if (/^on/i.test(attr.name)) { mark(el, 'inline handler'); break; }
			}
		}
	};
	document.addEventListener('securitypolicyviolation', (e) => {
		console.warn(`clew-csp: ${e.effectiveDirective} ${e.blockedURI || 'inline'}${e.sourceFile ? ` (${e.sourceFile.split('/').pop()}:${e.lineNumber})` : ''}`);
		if (!restricted() || !/^script-src/.test(e.effectiveDirective)) return;
		const name = e.effectiveDirective === 'script-src-attr' ? 'inline handler' : 'script';
		postTo(window.parent, { source: 'clew-preview', type: 'code-refused', name }, parentOrigin());
	});
	document.addEventListener('DOMContentLoaded', markAll);
	document.addEventListener('clew:render', markAll);
})();

(() => {
	const pending = new Map(); // id -> {resolve, reject, timer}
	const listeners = new Map(); // event name -> Set<fn>
	let counter = 0;

	const CALL_TIMEOUT_MS = 10000;

	function call(method, params = {}) {
		return new Promise((resolve, reject) => {
			const id = `api${++counter}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`clew.${method}: no host responded (exported HTML, or Clew is busy)`));
			}, CALL_TIMEOUT_MS);
			pending.set(id, { resolve, reject, timer });
			postTo(window.parent, { source: 'clew-preview', type: 'api-request', id, method, params }, parentOrigin());
		});
	}

	function emit(name, payload) {
		for (const fn of listeners.get(name) ?? []) {
			try { fn(payload); } catch (err) { console.error('clew listener failed:', err); }
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		// Answers and events come from the host this document asked — its
		// parent — never from a frame the note embeds.
		if (!msg || msg.source !== 'clew-preview-host' || event.source !== window.parent) return;
		if (msg.type === 'api-response') {
			const entry = pending.get(msg.id);
			if (!entry) return;
			pending.delete(msg.id);
			clearTimeout(entry.timer);
			if (msg.ok) entry.resolve(msg.result);
			else entry.reject(new Error(msg.error));
		} else if (msg.type === 'event') {
			if (msg.name === 'kv') {
				for (const change of msg.payload?.changes ?? []) emit('kv', change);
			} else {
				emit(msg.name, msg.payload);
			}
		} else if (msg.type === 'theme') {
			emit('theme', { theme: msg.theme });
		}
	});

	// Morph re-renders don't re-execute scripts; surface them as an event too.
	document.addEventListener('clew:render', () => emit('render', {}));

	window.clew = {
		call,
		on(name, fn) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(fn);
			return () => listeners.get(name)?.delete(fn);
		},

		context: () => call('context'),
		open: (target, opts = {}) => call('open', { target, ...opts }),
		command: (id) => call('command', { id }),
		search: (query) => call('search', { query }),

		notes: {
			list: () => call('notes.list'),
			read: (path) => call('notes.read', { path }),
			write: (path, content) => call('notes.write', { path, content }),
			append: (path, text) => call('notes.append', { path, text }),
			create: (path, content) => call('notes.create', { path, content }),
		},

		index: {
			get: (path) => call('index.get', { path }),
			backlinks: (path) => call('index.backlinks', { path }),
		},

		properties: {
			get: (path) => call('properties.get', { path }),
			set: (path, key, value) => call('properties.set', { path, key, value }),
		},

		kv: {
			get: (key) => call('kv.get', { key }),
			set: (key, value) => call('kv.set', { key, value }),
			delete: (key) => call('kv.delete', { key }),
			list: (prefix = '') => call('kv.list', { prefix }),
		},
	};
})();
