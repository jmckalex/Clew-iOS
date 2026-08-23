// Small Node builtins for the engine worker bundle: events, stream, os, url,
// vm, child_process, module, http, crypto. Each is re-exported by a matching
// one-line entry file (esbuild aliases resolve module names to files 1:1).

// ---- events ---------------------------------------------------------------

export class EventEmitter {
	#listeners = new Map();

	on(event, fn) {
		if (!this.#listeners.has(event)) this.#listeners.set(event, []);
		this.#listeners.get(event).push(fn);
		return this;
	}
	addListener(event, fn) { return this.on(event, fn); }
	prependListener(event, fn) {
		if (!this.#listeners.has(event)) this.#listeners.set(event, []);
		this.#listeners.get(event).unshift(fn);
		return this;
	}
	once(event, fn) {
		const wrapper = (...args) => { this.off(event, wrapper); fn(...args); };
		return this.on(event, wrapper);
	}
	off(event, fn) {
		const list = this.#listeners.get(event);
		if (list) this.#listeners.set(event, list.filter((f) => f !== fn));
		return this;
	}
	removeListener(event, fn) { return this.off(event, fn); }
	removeAllListeners(event) {
		if (event === undefined) this.#listeners.clear();
		else this.#listeners.delete(event);
		return this;
	}
	emit(event, ...args) {
		const list = this.#listeners.get(event);
		if (!list?.length) return false;
		for (const fn of [...list]) fn(...args);
		return true;
	}
	listenerCount(event) { return this.#listeners.get(event)?.length ?? 0; }
	listeners(event) { return [...(this.#listeners.get(event) ?? [])]; }
}

// ---- stream ---------------------------------------------------------------

export class Readable extends EventEmitter {
	readable = true;
	push() { return false; }
	read() { return null; }
	pipe(dest) { return dest; }
	destroy() { this.emit('close'); }
	static from() { throw new Error('[clew-ios] streams are not available in the render worker'); }
	static toWeb() { throw new Error('[clew-ios] streams are not available in the render worker'); }
}
export class Writable extends EventEmitter {
	writable = true;
	write() { return true; }
	end() { this.emit('finish'); }
	destroy() { this.emit('close'); }
}
export { Readable as Stream, Readable as Duplex, Readable as Transform, Readable as PassThrough };

// ---- os -------------------------------------------------------------------

export const os = {
	type: () => 'Darwin',
	platform: () => 'ios',
	release: () => '0.0.0',
	arch: () => 'arm64',
	tmpdir: () => '/tmp',
	homedir: () => '/home',
	hostname: () => 'clew-ios',
	cpus: () => [],
	EOL: '\n',
};

// ---- url ------------------------------------------------------------------

export function fileURLToPath(url) {
	const href = typeof url === 'string' ? url : url.href;
	return decodeURIComponent(href.replace(/^file:\/\//, '')) || '/';
}
export function pathToFileURL(p) {
	const href = 'file://' + String(p).split('/').map(encodeURIComponent).join('/');
	return { href, toString: () => href, pathname: p };
}

// ---- vm -------------------------------------------------------------------

// Script blocks in notes run through vm.runInThisContext on the desktop; an
// indirect eval is the browser equivalent (the worker's CSP allows it — the
// app page's does not, which is one more reason the engine lives out here).
export function runInThisContext(code) {
	return (0, eval)(code);
}

// ---- child_process --------------------------------------------------------

const noProcesses = (api) => () => {
	const err = new Error(
		`[clew-ios] ${api} is not available on iOS: `
		+ 'LaTeX, MetaPost, TikZ, and Mathematica blocks cannot be rendered here.');
	err.code = 'ENOENT';
	throw err;
};
export const execSync = noProcesses('child_process.execSync');
export const execFileSync = noProcesses('child_process.execFileSync');
export const spawnSync = noProcesses('child_process.spawnSync');
export const exec = noProcesses('child_process.exec');
export const execFile = noProcesses('child_process.execFile');
export const spawn = noProcesses('child_process.spawn');
export const fork = noProcesses('child_process.fork');

// ---- module ---------------------------------------------------------------

// createRequire: script blocks and biblify use require() for optional CJS
// modules. Nothing is requirable in the worker (biblify catches the throw and
// degrades to unstyled citations); bundling citation-js is a follow-up.
export function createRequire() {
	const require = (id) => {
		throw new Error(`[clew-ios] require('${id}') is not available in the render worker`);
	};
	require.resolve = (id) => {
		throw new Error(`[clew-ios] require.resolve('${id}') is not available in the render worker`);
	};
	return require;
}

// ---- http (imported by watch.js's module graph; never served) -------------

export const http = {
	createServer: () => {
		throw new Error('[clew-ios] http server is not available in the render worker');
	},
};

// ---- crypto ---------------------------------------------------------------

// createHash is used by the engine only for cache-key filenames (tikz/
// metapost/mermaid caches), never for security — a real SHA-1 keeps the
// digests stable and well-formed whatever the algorithm name asked for.
function sha1Hex(bytes) {
	const data = typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes;
	const ml = data.length;
	const withOne = new Uint8Array(((ml + 8) >> 6 << 6) + 64);
	withOne.set(data);
	withOne[ml] = 0x80;
	const dv = new DataView(withOne.buffer);
	dv.setUint32(withOne.length - 4, ml << 3, false);
	dv.setUint32(withOne.length - 8, Math.floor(ml / 0x20000000), false);
	let h0 = 0x67452301, h1 = 0xEFCDAB89, h2 = 0x98BADCFE, h3 = 0x10325476, h4 = 0xC3D2E1F0;
	const w = new Uint32Array(80);
	const rol = (n, s) => (n << s) | (n >>> (32 - s));
	for (let i = 0; i < withOne.length; i += 64) {
		for (let j = 0; j < 16; j++) w[j] = dv.getUint32(i + j * 4, false);
		for (let j = 16; j < 80; j++) w[j] = rol(w[j - 3] ^ w[j - 8] ^ w[j - 14] ^ w[j - 16], 1);
		let [a, b, c, d, e] = [h0, h1, h2, h3, h4];
		for (let j = 0; j < 80; j++) {
			const [f, k] = j < 20 ? [(b & c) | (~b & d), 0x5A827999]
				: j < 40 ? [b ^ c ^ d, 0x6ED9EBA1]
				: j < 60 ? [(b & c) | (b & d) | (c & d), 0x8F1BBCDC]
				: [b ^ c ^ d, 0xCA62C1D6];
			const t = (rol(a, 5) + f + e + k + w[j]) >>> 0;
			e = d; d = c; c = rol(b, 30) >>> 0; b = a; a = t;
		}
		h0 = (h0 + a) >>> 0; h1 = (h1 + b) >>> 0; h2 = (h2 + c) >>> 0;
		h3 = (h3 + d) >>> 0; h4 = (h4 + e) >>> 0;
	}
	return [h0, h1, h2, h3, h4].map((n) => n.toString(16).padStart(8, '0')).join('');
}

export function createHash() {
	let buffer = '';
	return {
		update(data) { buffer += typeof data === 'string' ? data : new TextDecoder().decode(data); return this; },
		digest(format) {
			const hex = sha1Hex(buffer);
			return format === 'hex' || format === undefined ? hex : hex;
		},
	};
}

export function randomBytes(n) {
	const bytes = new Uint8Array(n);
	globalThis.crypto.getRandomValues(bytes);
	bytes.toString = function (enc) {
		if (enc === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
		return Object.prototype.toString.call(this);
	};
	return bytes;
}

export const randomUUID = () => globalThis.crypto.randomUUID();
