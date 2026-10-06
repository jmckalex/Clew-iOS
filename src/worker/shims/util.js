// `util` for the engine worker bundle: what the engine imports from it.
// book.js (jmarkdown dc36e9b) compares configuration values with
// isDeepStrictEqual, so Node's rules where they can arise there: Object.is
// for primitives, the same prototype, own enumerable keys, arrays by index,
// Date and RegExp by value, Map and Set by content.

export function isDeepStrictEqual(a, b) {
	return deepEqual(a, b, new Map());
}

function deepEqual(a, b, seen) {
	if (Object.is(a, b)) return true;
	if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
	if (Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
	if (seen.get(a) === b) return true;
	seen.set(a, b);
	if (a instanceof Date) return Object.is(a.getTime(), b.getTime());
	if (a instanceof RegExp) return a.source === b.source && a.flags === b.flags && a.lastIndex === b.lastIndex;
	if (a instanceof Map) {
		if (a.size !== b.size) return false;
		for (const [k, v] of a) if (!b.has(k) || !deepEqual(v, b.get(k), seen)) return false;
		return true;
	}
	if (a instanceof Set) {
		if (a.size !== b.size) return false;
		for (const v of a) if (!b.has(v)) return false;
		return true;
	}
	if (Array.isArray(a) && a.length !== b.length) return false;
	const keys = Object.keys(a);
	if (keys.length !== Object.keys(b).length) return false;
	for (const k of keys) {
		if (!Object.prototype.hasOwnProperty.call(b, k) || !deepEqual(a[k], b[k], seen)) return false;
	}
	return true;
}

export function promisify(fn) {
	return (...args) => new Promise((resolve, reject) => {
		fn(...args, (err, value) => (err ? reject(err) : resolve(value)));
	});
}

export default { isDeepStrictEqual, promisify };
