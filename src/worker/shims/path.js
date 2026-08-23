// Posix `path` for the engine worker bundle. cwd comes from the process shim.

export const sep = '/';
export const delimiter = ':';

const cwd = () => globalThis.process?.cwd?.() ?? '/';

export function isAbsolute(p) {
	return String(p).startsWith('/');
}

export function normalize(p) {
	p = String(p);
	const abs = isAbsolute(p);
	const trailing = p.length > 1 && p.endsWith('/');
	const parts = [];
	for (const seg of p.split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (parts.length && parts[parts.length - 1] !== '..') parts.pop();
			else if (!abs) parts.push('..');
		} else parts.push(seg);
	}
	let out = parts.join('/');
	if (abs) out = '/' + out;
	if (out === '') out = '.';
	if (trailing && !out.endsWith('/')) out += '/';
	return out;
}

export function join(...args) {
	const joined = args.filter((a) => a !== undefined && a !== '').join('/');
	return joined === '' ? '.' : normalize(joined);
}

export function resolve(...args) {
	let resolved = '';
	for (let i = args.length - 1; i >= -1; i--) {
		const p = i >= 0 ? String(args[i]) : cwd();
		if (p === '') continue;
		resolved = resolved === '' ? p : p + '/' + resolved;
		if (isAbsolute(p)) break;
	}
	if (!isAbsolute(resolved)) resolved = cwd() + '/' + resolved;
	const out = normalize(resolved);
	return out.length > 1 && out.endsWith('/') ? out.slice(0, -1) : out;
}

export function dirname(p) {
	p = String(p);
	const i = p.lastIndexOf('/');
	if (i === -1) return '.';
	if (i === 0) return '/';
	return p.slice(0, i);
}

export function basename(p, ext) {
	p = String(p);
	let base = p.slice(p.lastIndexOf('/') + 1);
	if (ext && base.endsWith(ext) && base !== ext) base = base.slice(0, -ext.length);
	return base;
}

export function extname(p) {
	const base = basename(p);
	const i = base.lastIndexOf('.');
	return i <= 0 ? '' : base.slice(i);
}

export function relative(from, to) {
	const a = resolve(from).split('/').filter(Boolean);
	const b = resolve(to).split('/').filter(Boolean);
	let i = 0;
	while (i < a.length && i < b.length && a[i] === b[i]) i++;
	return [...a.slice(i).map(() => '..'), ...b.slice(i)].join('/') || '.';
}

export function parse(p) {
	const dir = dirname(p);
	const base = basename(p);
	const ext = extname(p);
	return { root: isAbsolute(p) ? '/' : '', dir, base, ext, name: base.slice(0, base.length - ext.length) };
}

export function format({ dir, root, base, name, ext }) {
	const b = base ?? `${name ?? ''}${ext ?? ''}`;
	const d = dir ?? root ?? '';
	return d ? `${d}/${b}` : b;
}

const posix = {
	sep, delimiter, isAbsolute, normalize, join, resolve,
	dirname, basename, extname, relative, parse, format,
};
posix.posix = posix;
posix.win32 = posix;

export { posix };
export default posix;
