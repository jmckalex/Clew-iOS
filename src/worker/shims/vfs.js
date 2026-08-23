// The in-memory filesystem behind the engine worker's Node-API shims.
//
// On iOS the jmarkdown engine runs inside a Web Worker: no real filesystem,
// no processes. Before each build the worker installs a snapshot of every
// text file the engine may read (the note, the whole vault's .md/.jmd/.bib,
// the engine config, the template, extension sources), and the fs shim
// answers synchronously from this map. Writes are captured in `writes` so
// the worker can hand the rendered output back to the host.
//
// Paths are posix-absolute. Directories are implicit: a directory exists iff
// it is "/" or a prefix of some file (plus any explicitly mkdir'd path).

const norm = (p) => {
	const parts = [];
	for (const seg of String(p).split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') parts.pop();
		else parts.push(seg);
	}
	return '/' + parts.join('/');
};

class Vfs {
	files = new Map(); // absPath -> { data: string|Uint8Array, mtimeMs }
	dirs = new Set(['/']);
	writes = new Map(); // absPath -> string|Uint8Array (everything written this session)

	reset() {
		this.files.clear();
		this.dirs.clear();
		this.dirs.add('/');
		this.writes.clear();
	}

	/** Bulk-load { "path": text | {data, mtimeMs} } into the tree. */
	install(snapshot) {
		for (const [p, v] of Object.entries(snapshot)) {
			const abs = norm(p);
			const entry = typeof v === 'string' || v instanceof Uint8Array
				? { data: v, mtimeMs: Date.now() }
				: { data: v.data, mtimeMs: v.mtimeMs ?? Date.now() };
			this.files.set(abs, entry);
			this.#addParents(abs);
		}
	}

	#addParents(abs) {
		let dir = abs;
		while ((dir = dir.slice(0, dir.lastIndexOf('/'))) !== '') this.dirs.add(dir);
		this.dirs.add('/');
	}

	has(p) {
		const abs = norm(p);
		return this.files.has(abs) || this.dirs.has(abs);
	}

	isDir(p) { return this.dirs.has(norm(p)); }
	isFile(p) { return this.files.has(norm(p)); }

	read(p) {
		const entry = this.files.get(norm(p));
		if (!entry) {
			const err = new Error(`ENOENT: no such file or directory, open '${p}'`);
			err.code = 'ENOENT';
			throw err;
		}
		return entry.data;
	}

	write(p, data) {
		const abs = norm(p);
		this.files.set(abs, { data, mtimeMs: Date.now() });
		this.#addParents(abs);
		this.writes.set(abs, data);
	}

	append(p, data) {
		const abs = norm(p);
		const prior = this.files.get(abs)?.data ?? '';
		this.write(abs, String(prior) + String(data));
	}

	mkdir(p) {
		const abs = norm(p);
		this.dirs.add(abs);
		this.#addParents(abs + '/x');
	}

	rm(p) {
		const abs = norm(p);
		this.files.delete(abs);
		this.writes.delete(abs);
		if (this.dirs.has(abs)) {
			this.dirs.delete(abs);
			for (const f of [...this.files.keys()]) {
				if (f.startsWith(abs + '/')) this.files.delete(f);
			}
		}
	}

	stat(p) {
		const abs = norm(p);
		const file = this.files.get(abs);
		if (!file && !this.dirs.has(abs)) {
			const err = new Error(`ENOENT: no such file or directory, stat '${p}'`);
			err.code = 'ENOENT';
			throw err;
		}
		const isFile = !!file;
		const size = file ? (typeof file.data === 'string' ? file.data.length : file.data.byteLength) : 0;
		return {
			isFile: () => isFile,
			isDirectory: () => !isFile,
			isSymbolicLink: () => false,
			mtimeMs: file?.mtimeMs ?? 0,
			mtime: new Date(file?.mtimeMs ?? 0),
			size,
		};
	}

	readdir(p) {
		const abs = norm(p);
		if (!this.dirs.has(abs)) {
			const err = new Error(`ENOENT: no such file or directory, scandir '${p}'`);
			err.code = 'ENOENT';
			throw err;
		}
		const prefix = abs === '/' ? '/' : abs + '/';
		const names = new Set();
		for (const f of this.files.keys()) {
			if (f.startsWith(prefix)) names.add(f.slice(prefix.length).split('/')[0]);
		}
		for (const d of this.dirs) {
			if (d !== abs && d.startsWith(prefix)) names.add(d.slice(prefix.length).split('/')[0]);
		}
		return [...names].sort();
	}
}

export const vfs = new Vfs();
export { norm as normalizePath };
