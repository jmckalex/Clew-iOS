// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// window.clew INSIDE AN APP (docs/dev/frame-bridge.md §7, §8): injected
// first into every HTML document the clew-frame handler serves. It says
// hello to the app page — `window.top`, `clew-app://app`, addressed by name
// — which knows the app by this frame's ORIGIN (only Clew's handler can
// serve it) and answers, once the user has answered the app's prompt, with
// a MessageChannel port: from then on the port IS the embed. The preview
// document around the frame never sees the port.
//
//   await clew.ready                       // { v, granted, tier2 }
//   clew.can('note.read')
//   const text = await clew.notes.read();  // the note this app sits in
//   await clew.kv.set('best', 42);         // app.kv
//   clew.on('theme', ({ theme }) => …);
//   await clew.notes.write(null, text);   // note.write: through the editor
//   clew.on('find', ({ query }) => …);    // Clew's Find in this note
//   clew.on('note-changed', ({ path }) => …);   // the note changed on disk (note.read)
//   clew.on('grant-changed', ({ granted }) => …); // more was allowed, live
(() => {
	const HOST = 'clew-app://app';
	const pending = new Map();
	const listeners = new Map();
	let port = null;
	let granted = [];
	let counter = 0;
	let resolveReady;
	let rejectReady;
	const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });

	const emit = (name, payload) => {
		for (const fn of listeners.get(name) ?? []) {
			try { fn(payload); } catch (err) { console.error('clew listener failed:', err); }
		}
	};

	window.addEventListener('message', (event) => {
		if (event.origin !== HOST || event.source !== window.top) return;
		const msg = event.data;
		if (msg?.source !== 'clew-app-host') return;
		if (msg.type === 'welcome' && event.ports?.[0] && !port) {
			port = event.ports[0];
			granted = Array.isArray(msg.granted) ? msg.granted : [];
			port.onmessage = (e) => {
				const m = e.data;
				if (m?.id && pending.has(m.id)) {
					const { resolve, reject, timer } = pending.get(m.id);
					pending.delete(m.id);
					clearTimeout(timer);
					if (m.ok) resolve(m.result);
					else reject(Object.assign(new Error(m.error?.message ?? 'failed'), { code: m.error?.code ?? 'internal' }));
				} else if (m?.event) {
					if (m.event === 'granted' || m.event === 'grant-changed') granted = Array.isArray(m.payload?.granted) ? m.payload.granted : granted;
					emit(m.event, m.payload);
				}
			};
			resolveReady({ v: msg.v, granted: [...granted], tier2: msg.tier2 ?? false });
		} else if (msg.type === 'refused') {
			rejectReady(Object.assign(new Error(msg.message ?? 'refused'), { code: 'denied' }));
		}
	});

	// Hello until answered: the answer waits for the user's, so it may take
	// a while; a lost message (a frame moved in the DOM) is asked again.
	let tries = 0;
	const hello = () => {
		if (port || tries++ > 120) return;
		try { window.top.postMessage({ source: 'clew-app', type: 'hello', v: [1] }, HOST); } catch { /* not in Clew */ }
		setTimeout(hello, 1000);
	};
	hello();

	function call(method, params = {}) {
		return ready.then(() => new Promise((resolve, reject) => {
			const id = `c${++counter}`;
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(Object.assign(new Error(`clew.${method}: no answer`), { code: 'unavailable' }));
			}, 30000);
			pending.set(id, { resolve, reject, timer });
			const transfer = params?.data instanceof ArrayBuffer ? [params.data] : [];
			port.postMessage({ v: 1, id, method, params }, transfer);
		}));
	}

	window.clew = Object.freeze({
		ready,
		can: (capability) => granted.includes(capability),
		context: () => call('context'),
		// A null path is the note the app sits in (note.read / note.write);
		// any other path needs notes.read / notes.write.
		notes: Object.freeze({
			read: (path) => call('notes.read', path ? { path } : {}),
			list: () => call('notes.list'),
			write: (path, content) => call('notes.write', { ...(path ? { path } : {}), content }),
			append: (path, text) => call('notes.append', { ...(path ? { path } : {}), text }),
			create: (path, content = '') => call('notes.create', { path, content }),
		}),
		properties: Object.freeze({
			get: (path) => call('properties.get', path ? { path } : {}),
			set: (path, key, value) => call('properties.set', { ...(path ? { path } : {}), key, value }),
		}),
		editor: Object.freeze({ insert: (text) => call('editor.insert', { text }) }),
		find: Object.freeze({ show: (query) => call('find.show', { query }) }),
		clipboard: Object.freeze({
			copy: (text) => call('clipboard.copy', { text }),
			paste: () => call('clipboard.paste'),
		}),
		search: (query) => call('search', { query }),
		index: Object.freeze({
			get: (path) => call('index.get', { path }),
			backlinks: (path) => call('index.backlinks', path ? { path } : {}),
		}),
		kv: Object.freeze({
			get: (key) => call('kv.get', { key }),
			set: (key, value) => call('kv.set', { key, value }),
			delete: (key) => call('kv.delete', { key }),
			list: (prefix = '') => call('kv.list', { prefix }),
		}),
		files: Object.freeze({
			list: (path = '') => call('files.list', { path }),
			read: (path, { as = 'text' } = {}) => call('files.read', { path, as }),
			write: (path, data) => call('files.write', { path, data }),
			delete: (path) => call('files.delete', { path }),
			mkdir: (path) => call('files.mkdir', { path }),
		}),
		open: (target) => call('open', { target }),
		on(name, fn) {
			if (!listeners.has(name)) listeners.set(name, new Set());
			listeners.get(name).add(fn);
			return () => listeners.get(name)?.delete(fn);
		},
	});
})();
