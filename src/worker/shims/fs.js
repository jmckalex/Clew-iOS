// Node `fs` over the worker's in-memory vfs. Sync API only (the engine is
// sync throughout); the callback/promise forms exist so incidental library
// code (chokidar's module graph, never actually run on iOS) can import.
import { vfs } from './vfs.js';
import * as fsPromises from './fs-promises.js';

const encode = (data, encoding) => {
	if (encoding === undefined || encoding === null) {
		if (typeof data === 'string') return new TextEncoder().encode(data);
		return data;
	}
	if (typeof data === 'string') return data;
	return new TextDecoder().decode(data);
};

export function readFileSync(p, options) {
	const encoding = typeof options === 'string' ? options : options?.encoding;
	return encode(vfs.read(p), encoding ?? null) ?? vfs.read(p);
}

export function writeFileSync(p, data) {
	vfs.write(p, typeof data === 'string' ? data : new Uint8Array(data.buffer ?? data));
}

export function appendFileSync(p, data) {
	vfs.append(p, data);
}

export function existsSync(p) {
	return vfs.has(p);
}

export function statSync(p, options) {
	try {
		return vfs.stat(p);
	} catch (err) {
		if (options?.throwIfNoEntry === false) return undefined;
		throw err;
	}
}

export const lstatSync = statSync;

export function mkdirSync(p) {
	vfs.mkdir(p);
}

export function readdirSync(p, options) {
	const names = vfs.readdir(p);
	if (!options?.withFileTypes) return names;
	const base = p.endsWith('/') ? p : p + '/';
	return names.map((name) => ({
		name,
		parentPath: p,
		isFile: () => vfs.isFile(base + name),
		isDirectory: () => vfs.isDir(base + name),
		isSymbolicLink: () => false,
	}));
}

export function rmSync(p) { vfs.rm(p); }
export const rmdirSync = rmSync;
export const unlinkSync = rmSync;

export function copyFileSync(src, dest) {
	vfs.write(dest, vfs.read(src));
}

export function renameSync(src, dest) {
	vfs.write(dest, vfs.read(src));
	vfs.rm(src);
}

export function accessSync(p) {
	if (!vfs.has(p)) {
		const err = new Error(`ENOENT: no such file or directory, access '${p}'`);
		err.code = 'ENOENT';
		throw err;
	}
}

export function realpathSync(p) {
	if (p === undefined || p === null) throw new TypeError('path is required');
	return vfs.has(p) ? p : (() => {
		const err = new Error(`ENOENT: no such file or directory, realpath '${p}'`);
		err.code = 'ENOENT';
		throw err;
	})();
}
realpathSync.native = realpathSync;

export class Stats {}

// Callback forms (unused at runtime; present for import compatibility).
const callbackify = (syncFn) => (...args) => {
	const cb = args.pop();
	try { cb(null, syncFn(...args)); } catch (err) { cb(err); }
};
export const readFile = callbackify(readFileSync);
export const writeFile = callbackify(writeFileSync);
export const stat = callbackify(statSync);
export const lstat = callbackify(statSync);
export const readdir = callbackify(readdirSync);

// Watching does not exist in the worker (the host re-renders instead).
export function watch() { return { close() {}, on() {} }; }
export function watchFile() {}
export function unwatchFile() {}

export function createReadStream() {
	throw new Error('[clew-ios] fs.createReadStream is not available in the render worker');
}
export function createWriteStream() {
	throw new Error('[clew-ios] fs.createWriteStream is not available in the render worker');
}

export const constants = { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1 };
export const promises = fsPromises;

export default {
	readFileSync, writeFileSync, appendFileSync, existsSync, statSync, lstatSync,
	mkdirSync, readdirSync, rmSync, rmdirSync, unlinkSync, copyFileSync,
	renameSync, accessSync, realpathSync, Stats, readFile, writeFile, stat,
	lstat, readdir, watch, watchFile, unwatchFile, createReadStream,
	createWriteStream, constants, promises,
};
