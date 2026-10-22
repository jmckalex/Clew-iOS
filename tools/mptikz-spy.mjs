// The staged mp-tikz-wasm with every latex() run recorded, for
// tools/export-note.mjs --spy (tests/export-host.test.js): the files TeX was
// handed, by name, its status and its log, on globalThis.__clewTexRuns. The
// library itself comes from the `real` query parameter.
const real = await import(new URL(import.meta.url).searchParams.get('real'));
const runs = (globalThis.__clewTexRuns ??= []);

export const DEFAULT_BUNDLES = real.DEFAULT_BUNDLES;
export const MetaPost = {
	async create(options) {
		const mp = await real.MetaPost.create(options);
		return new Proxy(mp, {
			get(target, key) {
				if (key === 'latex') {
					return async (tex, o = {}) => {
						const r = await target.latex(tex, o);
						runs.push({ engine: o.engine, files: Object.keys(o.files ?? {}).sort(), status: r.status, log: r.texLog ?? '' });
						return r;
					};
				}
				const value = Reflect.get(target, key);
				return typeof value === 'function' ? value.bind(target) : value;
			},
		});
	},
};
