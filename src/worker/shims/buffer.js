// A small Node `Buffer` over Uint8Array — enough for the engine's and the
// vendored services' uses (utf8/base64/hex round-trips, concat, alloc, and
// byte-equality). Shared by the worker's injected globals and the fs shim,
// which returns one from encoding-less reads exactly as Node does.
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export class BufferShim extends Uint8Array {
	toString(encoding = 'utf8') {
		if (encoding === 'base64') {
			let binary = '';
			for (const b of this) binary += String.fromCharCode(b);
			return btoa(binary);
		}
		if (encoding === 'hex') return [...this].map((b) => b.toString(16).padStart(2, '0')).join('');
		return textDecoder.decode(this);
	}

	/** Byte-for-byte equality (history.js compares snapshots with it). */
	equals(other) {
		if (!(other instanceof Uint8Array) || other.length !== this.length) return false;
		for (let i = 0; i < this.length; i++) {
			if (this[i] !== other[i]) return false;
		}
		return true;
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

	/** A zero-copy Buffer view over existing bytes (or a fresh encode). */
	static view(data) {
		const bytes = typeof data === 'string' ? textEncoder.encode(data) : data;
		return new BufferShim(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	}
}
