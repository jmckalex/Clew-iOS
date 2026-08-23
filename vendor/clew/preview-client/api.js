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
			window.parent.postMessage({ source: 'clew-preview', type: 'api-request', id, method, params }, '*');
		});
	}

	function emit(name, payload) {
		for (const fn of listeners.get(name) ?? []) {
			try { fn(payload); } catch (err) { console.error('clew listener failed:', err); }
		}
	}

	window.addEventListener('message', (event) => {
		const msg = event.data;
		if (!msg || msg.source !== 'clew-preview-host') return;
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
