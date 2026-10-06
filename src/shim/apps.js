// Apps in notes, the shim's half (Clew-app main/app-registry.js and the
// APP_* handlers of main/ipc.js at f3a7d5b; docs/dev/frame-bridge.md §7–§10,
// R1–R3). An app is a vault FOLDER holding clew-app.json; `@app[Apps/Timer]`
// embeds it. It runs on an origin of its own, clew-frame://<key>, where <key>
// = hash(the DEVICE's identity for the vault, the manifest id) — on iOS that
// identity is VaultTrust.swift's (`documents:<rel>`; no absolute paths, the
// container moves on every install), never the folder path.
//
// Everything that decides is upstream's own code, run over the mirror:
// app-frames.js (manifests, keys, the CSP, the realpath clamp), app-grants.js
// (the grant record and what to ask), app-calls.js (every capability),
// app-embeds-rewrite.js (the embed, resolved as a document is SERVED). Native
// holds what must be native: the grant FILE in Application Support (a vault
// sent to someone arrives with no grants), and the clew-frame scheme
// (SchemeHandler.swift), which asks `serve()` here which vault file to send
// and with which CSP — and serves only that.
//
// A `network` grant is bound to its ORIGINS (Clew-app 917303b): the CSP is
// built from the hosts the grant covers that the manifest still names
// (grantState's `network`), never from the manifest alone, and a manifest
// edited to name a new host asks again, for that host only.
import { vfs } from '../worker/shims/vfs.js';
import { VAULT_ROOT } from './vault-manager.js';
import { bridgeCall } from './native-bridge.js';
import { appKey, appsById, resolveApp, appFile, appCsp, codeHash, describeCapabilities, parseManifest, MANIFEST } from '../../vendor/clew/main/app-frames.js';
import { createGrantStore, grantState, mergeOrigins } from '../../vendor/clew/main/app-grants.js';
import { callApp } from '../../vendor/clew/main/app-calls.js';
import { rewriteAppEmbeds } from '../../vendor/clew/main/app-embeds-rewrite.js';

/** The grant store's file, in the vfs but OUTSIDE the vault mirror: it is
 *  read from native at start and written back to native after each change
 *  (`appGrantsRead` / `appGrantsWrite`, Application Support). */
const GRANTS_FILE = '/device/app-grants.json';

export function createApps({ vaults, indexer, searchService, kvStore, refreshTree }) {
	const store = createGrantStore({ file: GRANTS_FILE });
	let loaded = null;
	/** The device's file into the vfs, once. */
	const load = () => (loaded ??= bridgeCall('appGrantsRead')
		.then((text) => {
			vfs.mkdir('/device');
			if (typeof text === 'string' && text) vfs.write(GRANTS_FILE, text);
		})
		.catch((err) => console.warn('[clew-ios] app grants unreadable:', err)));
	/** After a change: the vfs file back to the device. */
	const persist = () => {
		let text = null;
		try { text = String(vfs.read(GRANTS_FILE)); } catch { return; }
		bridgeCall('appGrantsWrite', { text }).catch((err) => console.warn('[clew-ios] app grants not saved:', err));
	};
	const grants = {
		get: (vault, id) => store.get(vault, id),
		list: (vault) => store.list(vault),
		answer(vault, id, answer) { const out = store.answer(vault, id, answer); persist(); return out; },
		revoke(vault, id) { const out = store.revoke(vault, id); persist(); return out; },
	};

	/** key → { vault, folder, abs, manifest, manifestMtime, served } — the
	 *  apps this page's notes embed (app-registry.js). */
	const byKey = new Map();
	const mtimeOf = (abs) => { try { return vfs.stat(`${abs}/${MANIFEST}`).mtimeMs; } catch { return null; } };
	/** Re-read an app's manifest when its file changed: what it asks for —
	 *  above all which hosts — is the file's NOW, not the note's last render. */
	const freshManifest = (app) => {
		const mtime = mtimeOf(app.abs);
		if (mtime === null || mtime === app.manifestMtime) return;
		app.manifestMtime = mtime;
		try {
			const { manifest } = parseManifest(String(vfs.read(`${app.abs}/${MANIFEST}`)));
			if (manifest && manifest.id === app.manifest.id) app.manifest = manifest;
		} catch { /* mid-write: read again next time */ }
	};
	// An app's clipboard (the `clipboard` capability): app-calls.js answers
	// synchronously. A copy goes to the system pasteboard too (the bridge,
	// fire and forget), so it pastes in any app; a paste reads Clew's own
	// copy of the last one — reading the system pasteboard would show iOS's
	// "pasted from" notice for something the user did not ask to paste.
	const clipboard = (() => {
		let text = '';
		return {
			writeText: (t) => {
				text = String(t);
				bridgeCall('clipboardWrite', { text }).catch(() => {});
			},
			readText: () => text,
		};
	})();

	const identity = () => vaults.identity ?? '';
	const restricted = () => vaults.trusted !== true;

	/** `@app[target]`: its folder and manifest, registered under its key, or
	 *  the refusal by name (app-registry.js#resolveFor). */
	const resolveFor = (target) => {
		if (!vaults.isOpen || !identity()) return { refusal: '@app: no vault is open.' };
		const found = resolveApp(VAULT_ROOT, target, indexer.appFolders ?? []);
		if (found.refusal) return found;
		const key = appKey(identity(), found.manifest.id);
		const known = byKey.get(key);
		byKey.set(key, { vault: identity(), folder: found.folder, abs: found.abs, manifest: found.manifest,
			manifestMtime: mtimeOf(found.abs), served: known?.served ?? null });
		return { key, ...found };
	};

	const stateOf = (app) => {
		freshManifest(app);
		const record = grants.get(app.vault, app.manifest.id);
		let hash = null;
		const code = () => (hash ??= codeHash(app.abs));
		return { record, ...grantState(record, app.manifest, { restricted: restricted(), code }), code };
	};

	const status = (key, app) => {
		const st = stateOf(app);
		// The prompt's words for `network` name only the hosts it ASKS for.
		const words = describeCapabilities(app.manifest.capabilities, st.askNetwork ?? app.manifest.network);
		return {
			key, id: app.manifest.id, name: app.manifest.name, folder: app.folder,
			capabilities: app.manifest.capabilities, network: app.manifest.network,
			ask: st.ask, askRun: st.askRun, changed: st.changed, mayRun: st.mayRun, granted: st.granted,
			// The hosts it may reach NOW (granted ∩ the manifest); app-host.js
			// reloads its frames when an answer changes them.
			networkNow: st.network, askNetwork: st.askNetwork,
			restricted: restricted(),
			describe: Object.fromEntries(app.manifest.capabilities.map((c, i) => [c, words[i]])),
		};
	};

	const own = (key) => byKey.get(String(key ?? '').toLowerCase()) ?? null;

	return {
		load,
		/** A vault (re)opened: no app of the old one is servable. */
		reset() { byKey.clear(); },

		/** A note or block document as it is served: every <clew-app-embed>
		 *  resolved (app-embeds-rewrite.js). */
		rewrite(html, notePath = null) {
			if (!/<clew-app-embed\b/i.test(html)) return html;
			return rewriteAppEmbeds(html, { resolve: resolveFor, restricted: restricted(), notePath }).html;
		},

		/**
		 * What the clew-frame handler sends for `clew-frame://<key><path>`
		 * (desktop's installFrameProtocol): {status: 404|403} refused;
		 * {bridge, csp} the bridge client; {rel, html, csp} a file of the
		 * app's folder (vault-relative — native reads it through its own
		 * realpath clamp; `html` asks it to inject the bridge).
		 */
		serve(key, urlPath) {
			const app = own(key);
			if (!app || !vaults.isOpen) return { status: 404 };
			const st = stateOf(app);
			if (!st.mayRun) return { status: 403, message: 'This app has not been allowed to run here.' };
			// The hosts its GRANT covers that the manifest still names — never
			// the manifest alone, or editing it would widen what was allowed.
			const network = st.network;
			app.served = JSON.stringify(network ?? null);
			const csp = appCsp({ network });
			if (urlPath === '/__clew_bridge__.js') return { bridge: true, csp };
			const file = appFile(app.abs, urlPath);
			if (!file || !file.startsWith(`${VAULT_ROOT}/`)) return { status: 404 };
			return { rel: file.slice(VAULT_ROOT.length + 1), html: /\.html?$/i.test(file), csp };
		},

		/**
		 * A vault file changed: the keys of the apps whose manifest it is and
		 * whose running frames now differ from the grant — hosts narrowed or
		 * widened, or something new to ask (app-registry.js#manifestTouched).
		 * Their frames must reload.
		 */
		manifestTouched(rel) {
			const out = [];
			for (const [key, app] of byKey) {
				if (`${app.folder}/${MANIFEST}` !== rel) continue;
				const st = stateOf(app);
				if (st.ask.length || (app.served !== null && JSON.stringify(st.network ?? null) !== app.served)) out.push(key);
			}
			return out;
		},

		// ---- the channels (main/ipc.js) ------------------------------------
		status(key) {
			const app = own(key);
			return app ? status(key, app) : null;
		},
		/** The prompt's answer, for everything it asked (choice C pins a
		 *  restricted vault's networked app to the approved code). */
		answer(key, allow) {
			const app = own(key);
			if (!app) return null;
			const st = stateOf(app);
			const asked = st.ask;
			const pin = restricted() && allow === true && (asked.includes('network') || st.granted.includes('network'));
			// A network ask for NEW hosts of a grant that already reaches
			// others: Don't allow refuses those hosts only (app-grants.js).
			const widening = asked.includes('network') && st.granted.includes('network');
			grants.answer(app.vault, app.manifest.id, {
				granted: allow === true ? asked : [],
				denied: allow === true ? [] : asked.filter((c) => !(widening && c === 'network')),
				...(allow === true && asked.includes('network')
					? { networkOrigins: mergeOrigins(st.changed ? undefined : st.record?.networkOrigins, st.askNetwork) } : {}),
				...(allow !== true && widening ? { declineOrigins: [].concat(st.askNetwork) } : {}),
				...(st.askRun || st.changed ? { run: allow === true } : {}),
				...(pin ? { code: st.code() } : (allow === true && st.changed ? { code: null } : {})),
				folder: app.folder,
			});
			return status(key, app);
		},
		call(key, notePath, method, params) {
			const app = own(key);
			if (!app) return { ok: false, error: { code: 'denied', message: 'no such app in this window' } };
			const st = stateOf(app);
			if (!st.mayRun) return { ok: false, error: { code: 'denied', message: 'this app has not been allowed to run here' } };
			const out = callApp({
				root: VAULT_ROOT, restricted: restricted(), excludes: vaults.excludes,
				notePath: typeof notePath === 'string' ? notePath : null,
				app, granted: new Set(st.granted),
				indexer, search: searchService, kv: kvStore, clipboard,
			}, String(method), params);
			// A note an app created is a new file Clew wrote: in the tree now.
			if (out.ok && out.result?.created) refreshTree();
			return out;
		},
		list() {
			if (!vaults.isOpen) return [];
			const vault = identity();
			const records = grants.list(vault);
			const ids = appsById(VAULT_ROOT, indexer.appFolders ?? []);
			const out = [];
			const row = (id, folders, r, extra = {}) => ({
				id, key: appKey(vault, id), folders,
				granted: Object.keys(r?.granted ?? {}), denied: Object.keys(r?.denied ?? {}),
				run: Boolean(r?.run), runDenied: Boolean(r?.runDenied), pinned: Boolean(r?.code), ...extra,
			});
			for (const [id, folders] of ids) out.push(row(id, folders, records[id] ?? null, { duplicate: folders.length > 1 }));
			for (const [id, r] of Object.entries(records)) {
				if (!ids.has(id)) out.push(row(id, r.folder ? [r.folder] : [], r, { missing: true }));
			}
			return out.sort((a, b) => a.id.localeCompare(b.id));
		},
		revoke(id) {
			if (!vaults.isOpen) return { done: false, key: null };
			const vault = identity();
			return { done: grants.revoke(vault, String(id)), key: appKey(vault, String(id)) };
		},
	};
}
