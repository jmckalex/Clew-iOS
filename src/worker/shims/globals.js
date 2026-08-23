// Injected globals for the engine worker bundle: `process`, `Buffer`, and
// `global`. esbuild's `inject` substitutes these exports for the free
// identifiers throughout the bundle.
//
// process.exit is the engine's error-path escape hatch — in the worker it
// throws a recognizable error instead; the worker entry catches it, reports
// an error result, and the host discards the (now dirty) worker.

export class ProcessExitError extends Error {
	constructor(code) {
		super(`process.exit(${code ?? 0})`);
		this.code = code ?? 0;
		this.isProcessExit = true;
	}
}

const processShim = {
	env: {},
	// argv[1] must stay unresolvable: index.js's isCliEntry guard realpaths it
	// to decide whether to run the commander CLI (it must not).
	argv: ['node'],
	argv0: 'node',
	platform: 'ios',
	version: 'v23.0.0',
	versions: { node: '23.0.0' },
	execPath: '/usr/bin/node',
	pid: 1,
	_cwd: '/',
	cwd() { return this._cwd; },
	chdir(dir) { this._cwd = dir; },
	exit(code) { throw new ProcessExitError(code); },
	on() {}, once() {}, off() {}, removeListener() {},
	send: undefined,
	nextTick(fn, ...args) { queueMicrotask(() => fn(...args)); },
	hrtime: Object.assign((prev) => {
		const ms = performance.now();
		const s = Math.floor(ms / 1000);
		const ns = Math.round((ms % 1000) * 1e6);
		return prev ? [s - prev[0], ns - prev[1]] : [s, ns];
	}, { bigint: () => BigInt(Math.round(performance.now() * 1e6)) }),
	stdout: { write(chunk) { console.log(String(chunk)); return true; }, isTTY: false },
	stderr: { write(chunk) { console.warn(String(chunk)); return true; }, isTTY: false },
	// isTTY must be truthy: processFile treats a falsy isTTY plus a missing
	// filename as "read stdin" and would await a stream that never ends.
	stdin: {
		[Symbol.asyncIterator]() { return { next: async () => ({ done: true }) }; },
		isTTY: true,
	},
};

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

class BufferShim extends Uint8Array {
	toString(encoding = 'utf8') {
		if (encoding === 'base64') {
			let binary = '';
			for (const b of this) binary += String.fromCharCode(b);
			return btoa(binary);
		}
		if (encoding === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
		return textDecoder.decode(this);
	}

	static from(value, encoding) {
		if (typeof value === 'string') {
			if (encoding === 'base64') {
				const binary = atob(value);
				const bytes = new BufferShim(binary.length);
				for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
				return bytes;
			}
			const encoded = textEncoder.encode(value);
			const out = new BufferShim(encoded.length);
			out.set(encoded);
			return out;
		}
		const source = value instanceof ArrayBuffer ? new Uint8Array(value) : value;
		const out = new BufferShim(source.length ?? 0);
		if (source.length) out.set(source);
		return out;
	}

	static concat(list) {
		const total = list.reduce((n, b) => n + b.length, 0);
		const out = new BufferShim(total);
		let offset = 0;
		for (const b of list) { out.set(b, offset); offset += b.length; }
		return out;
	}

	static isBuffer(value) { return value instanceof BufferShim; }
	static alloc(n) { return new BufferShim(n); }
}

// `global` must be the worker's real global object: the engine deliberately
// hangs shared state (cheerio, require, isLatex, script-block exports) on it.
const globalShim = globalThis;
globalThis.process = processShim;
globalThis.Buffer = BufferShim;

export { processShim as process, BufferShim as Buffer, globalShim as global };
