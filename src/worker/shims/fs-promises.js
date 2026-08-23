// Node `fs/promises` over the vfs — import-compatibility for library code
// (chokidar/readdirp) that never actually runs in the worker.
import { vfs } from './vfs.js';

export async function stat(p) { return vfs.stat(p); }
export const lstat = stat;
export async function readdir(p) { return vfs.readdir(p); }
export async function realpath(p) { return p; }
export async function readFile(p, options) {
	const data = vfs.read(p);
	const encoding = typeof options === 'string' ? options : options?.encoding;
	if (encoding && typeof data !== 'string') return new TextDecoder().decode(data);
	return data;
}
export async function writeFile(p, data) { vfs.write(p, data); }
export async function mkdir(p) { vfs.mkdir(p); }
export async function rm(p) { vfs.rm(p); }
export async function access(p) {
	if (!vfs.has(p)) throw Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
}
export async function open() {
	throw new Error('[clew-ios] fs.promises.open is not available in the render worker');
}

export default { stat, lstat, readdir, realpath, readFile, writeFile, mkdir, rm, access, open };
