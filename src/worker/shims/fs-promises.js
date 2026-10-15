// Node `fs/promises` over the vfs — import-compatibility for library code
// (chokidar/readdirp) that never actually runs in the worker, and, in the
// app page, upstream's fs-utils.js#writeFileAtomicAsync: the index cache
// (indexer.js#saveCache, Clew-app ef5f7f2) saves through it. That needs open
// for writing, rename and a forgiving rm; open's handle holds what it is
// given and hands the vfs ONE write on close, as fs.js#closeSync does.
import { vfs } from './vfs.js';
import { BufferShim, decodeUtf8 } from './buffer.js';

export async function stat(p) { return vfs.stat(p); }
export const lstat = stat;
export async function readdir(p) { return vfs.readdir(p); }
export async function realpath(p) { return p; }
export async function readFile(p, options) {
	const data = vfs.read(p);
	const encoding = typeof options === 'string' ? options : options?.encoding;
	if (encoding && typeof data !== 'string') return decodeUtf8(data);
	return data;
}
export async function writeFile(p, data) { vfs.write(p, data); }
export async function mkdir(p) { vfs.mkdir(p); }
// `{ force: true }`: a missing path is no error (and asks no hook).
export async function rm(p, options) {
	if (options?.force && !vfs.has(p)) return;
	vfs.rm(p);
}
export async function rename(src, dest) { vfs.rename(src, dest); }
export async function access(p) {
	if (!vfs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
}

/** A FileHandle for writing, as far as writeFileAtomicAsync uses one. */
class FileHandle {
	#path;
	#chunks;
	constructor(p, chunks) { this.#path = p; this.#chunks = chunks; }
	async chmod() {}
	async sync() {}
	async writeFile(data) {
		if (this.#path === null) throw Object.assign(new Error('file closed'), { code: 'EBADF' });
		// new Uint8Array, never Uint8Array.from: see fs.js#writeSync.
		this.#chunks.push(typeof data === 'string' ? BufferShim.from(data) : new Uint8Array(data));
	}
	async close() {
		if (this.#path === null) return;
		const p = this.#path;
		this.#path = null;
		vfs.write(p, BufferShim.concat(this.#chunks));
	}
}

export async function open(p, flags = 'r') {
	if (!/^[wa]/.test(String(flags))) {
		throw Object.assign(new Error(`[clew-ios] fs.promises.open supports write modes only (got '${flags}' for ${p})`), { code: 'EINVAL' });
	}
	return new FileHandle(p, String(flags).startsWith('a') && vfs.isFile(p) ? [BufferShim.view(vfs.read(p))] : []);
}

export default { stat, lstat, readdir, realpath, readFile, writeFile, mkdir, rm, rename, access, open };
