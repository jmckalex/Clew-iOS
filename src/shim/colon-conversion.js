// "Convert this vault" — the colon directives' retirement, phase 2 — on the
// iPad. Upstream's converter (vendor/clew/main/colon-conversion.js) runs
// VERBATIM here, over the vault mirror, as history.js, the indexer and the kv
// store do; the sheet (renderer/colon-conversion.js) is the vendored one.
// What this file adds is desktop's ipc.js adapter, built over the iPad's
// VaultManager and the native bridge (ColonConversion.swift):
//
//   root          a VIRTUAL root, /colon-vaults/<hash of the device's vault
//                 identity>/<vault name>: never a device path. The app
//                 container's path changes with every app update (and a
//                 provider's can), and the converter names a vault's backups
//                 after its root — a device path would orphan every
//                 conversion. The identity (VaultTrust.swift) is the one trust
//                 keys on; the basename keeps the sheet's "in <vault>".
//   listNotes     the mirror's tree (the vault's excludes), .md/.jmd, no
//                 Excalidraw drawing — desktop's tree walk.
//   read          the mirror's text as bytes: byte-exact for every UTF-8 note
//                 (Swift keeps a BOM and CRLF). A note that is not UTF-8 is
//                 mirrored as "", so its real bytes come from native before
//                 each scan, and the converter refuses it by name as desktop
//                 does.
//   readAsync     the device's bytes NOW (readNoteBytes), never the mirror: the
//                 read just before a write must see an iCloud or Files change
//                 the mirror has not had yet.
//   write         VaultManager.writeNoteAsync: history, the device's atomic
//                 write through the vault's queue, awaited; then the mirror,
//                 and the change announced as desktop's watcher would.
//   keepVersion   history.js#keepVersion over the mirror.
//
// Folder configs: the mirror skips every dot-folder but .clew, so before each
// scan native lists each `<folder>/.jmarkdown/config.json`, and they are laid
// under the virtual root, where the converter reads them. The engine never
// sees them (it reads /vault). There is no global ~/.jmarkdown on the iPad.
//
// Backups: fs under DEVICE_BACKUP_ROOT, written through to the device by the
// VaultManager. Before LAST, FINISH or UNDO, this vault's manifests come back
// from the device (after a relaunch or an app update too); a conversion's
// notes as they were come back only for UNDO, and leave memory after.
//
// No note is changed without its backup: upstream writes every backup and the
// manifest synchronously, so a failure throws before any note changes. Here
// they reach the device through the vault's queue; once one of this
// conversion's is refused, every note write after it is refused too (asked
// inside its queued job), the converter names those notes "not written after
// all", and no note goes to an editor.
//
// No device path reaches the renderer: the backup's place is said in words,
// and any path in an error is replaced.
import nodePath from 'node:path';
import { createHash } from 'node:crypto';
import { colonConverter, backupFolderName } from '../../vendor/clew/main/colon-conversion.js';
import { isExcalidrawPath } from '../../vendor/clew/shared/file-types.js';
import { vfs } from '../worker/shims/vfs.js';
import { decodeUtf8 } from '../worker/shims/buffer.js';
import { bridgeCall } from './native-bridge.js';
import { DEVICE_BACKUP_ROOT, VAULT_ROOT } from './vault-manager.js';

export const COLON_VAULTS_ROOT = '/colon-vaults';
/** Where the sheet says each note was copied ("into …"). */
export const BACKUP_WORDS = "Clew's own storage on this iPad (outside the vault)";
const NO_GLOBAL_CONFIG = '/no-global-config/.jmarkdown/config.json';
const NOTES_PER_CALL = 200;

/** The converter's root for a vault: stable across relaunches and app
 *  updates, unique per vault on this device, no device path in it. */
export function colonRoot(identity, name) {
	const id = createHash('sha256').update(String(identity)).digest('hex').slice(0, 16);
	return `${COLON_VAULTS_ROOT}/${id}/${String(name || 'vault').replace(/\//g, '_')}`;
}

// The converter shares the page with the window: work of this file's own that
// walks the whole mirror (tens of thousands of entries in a big vault, history
// included) goes in slices, yielding so a frame can be drawn.
const SLICE_MS = 4;
const yieldToPage = () => new Promise((resolve) => setTimeout(resolve, 0));
async function sliced(items, each) {
	let slice = performance.now();
	for (let i = 0; i < items.length; i++) {
		each(items[i]);
		if ((i & 127) === 127 && performance.now() - slice > SLICE_MS) {
			await yieldToPage();
			slice = performance.now();
		}
	}
}

/** Every file (and the folders) under `prefix` out of the mirror, with no
 *  write-through: what the device holds is not touched. */
async function forget(prefix) {
	await sliced([...vfs.files.keys()], (abs) => {
		if (abs === prefix || abs.startsWith(prefix + '/')) { vfs.files.delete(abs); vfs.writes.delete(abs); }
	});
	for (const dir of [...vfs.dirs]) if (dir === prefix || dir.startsWith(prefix + '/')) vfs.dirs.delete(dir);
}

const plain = (rel) => typeof rel === 'string' && rel !== '' && rel.split('/').every((seg) => seg && seg !== '.' && seg !== '..');

/**
 * @param {{ vaults: import('./vault-manager.js').VaultManager,
 *           send: (channel: string, payload: any) => void,
 *           fileChanged: (rel: string) => void,
 *           progressChannel: string,
 *           log?: (line: string) => void }} deps
 */
export function createColonConversion({ vaults, send, fileChanged, progressChannel, log = (line) => console.log(line) }) {
	/** Notes the mirror holds as "" whose bytes are not UTF-8: rel → Buffer. */
	let rawNotes = new Map();
	/** The backup folder whose manifests the mirror holds. */
	let manifestsOf = null;

	const rootNow = () => (vaults.isOpen ? colonRoot(vaults.identity ?? vaults.realPath, vaults.name) : null);

	/** The vault's notes as desktop's tree walk lists them: a file whose
	 *  folders and itself the excludes do not hide. One pass over the mirror,
	 *  not vaults.tree(): the tree's readdir walks the whole mirror per folder
	 *  (28 ms a call on 5,006 notes, measured — a dropped frame on the page
	 *  the UI shares). With the notes the mirror holds as "" (`empty`). */
	const notesOf = () => {
		const prefix = VAULT_ROOT + '/';
		const notes = [];
		const empty = [];
		const hidden = new Map();
		const isHidden = (rel) => {
			if (!hidden.has(rel)) hidden.set(rel, vaults.excludes.isHidden(rel));
			return hidden.get(rel);
		};
		const each = (abs) => {
			if (!abs.startsWith(prefix)) return;
			const rel = abs.slice(prefix.length);
			if (!/\.(md|jmd)$/i.test(rel) || isExcalidrawPath(rel)) return;
			let shown = true;
			for (let at = rel.indexOf('/'); shown && at !== -1; at = rel.indexOf('/', at + 1)) shown = !isHidden(rel.slice(0, at));
			if (!shown || isHidden(rel)) return;
			notes.push(rel);
			const data = vfs.files.get(abs)?.data;
			if ((typeof data === 'string' ? data.length : data?.byteLength) === 0) empty.push(rel);
		};
		return { notes, empty, each };
	};
	const walkNotes = () => {
		const walk = notesOf();
		for (const abs of vfs.files.keys()) walk.each(abs);
		return walk.notes.sort();
	};
	/** prepare()'s list, which the scan that follows takes (one walk a scan). */
	let listed = null;
	const listNotes = () => {
		const notes = listed ?? walkNotes();
		listed = null;
		return notes;
	};
	/** The folder configs prepare() laid under the virtual root. */
	let configsLaid = [];
	/** An apply is running: its note writes need its backups on the device. */
	let applying = false;
	const backupRefusal = () => {
		const failed = vaults.backupFailure;
		if (!failed) return null;
		return `its backup could not be saved on this iPad (${scrub(failed.message)}), so it was left as it was`;
	};

	const converter = colonConverter({
		vault: {
			get root() { return rootNow(); },
			get restricted() { return !vaults.trusted; },
			listNotes,
			read: (rel) => rawNotes.get(rel) ?? Buffer.from(vaults.readNote(rel), 'utf8'),
			readAsync: async (rel) => {
				vaults.resolve(rel);
				const base64 = await bridgeCall('readNoteBytes', { vault: vaults.realPath, rel });
				if (typeof base64 !== 'string') throw new Error(`${rel} could not be read`);
				return Buffer.from(base64, 'base64');
			},
			write: async (rel, content) => {
				const answer = await vaults.writeNoteAsync(rel, content, { refuse: () => (applying ? backupRefusal() : null) });
				fileChanged(rel);
				return answer;
			},
			keepVersion: (rel, text) => vaults.keepVersion(rel, text),
		},
		backupRoot: DEVICE_BACKUP_ROOT,
		globalConfig: NO_GLOBAL_CONFIG,
		log,
	});

	const progress = (p) => send(progressChannel, p);

	/** Before a scan: the folder configs under the virtual root, and the
	 *  bytes of the notes the mirror could not hold as text. */
	async function prepare() {
		const root = rootNow();
		for (const abs of configsLaid) vfs.files.delete(abs);
		configsLaid = [];
		const walk = notesOf();
		await sliced([...vfs.files.keys()], walk.each);
		const answer = await bridgeCall('colonPrepare', { vault: vaults.realPath, empty: walk.empty }) ?? {};
		listed = walk.notes.sort();
		vfs.mkdir(root);
		for (const [dir, text] of Object.entries(answer.configs ?? {})) {
			if (typeof text !== 'string' || (dir !== '' && !plain(dir))) continue;
			const abs = nodePath.posix.join(root, dir, '.jmarkdown', 'config.json');
			vfs.patch(abs, text);
			configsLaid.push(abs);
		}
		rawNotes = new Map();
		for (const [rel, base64] of Object.entries(answer.raw ?? {})) {
			if (plain(rel) && typeof base64 === 'string') rawNotes.set(rel, Buffer.from(base64, 'base64'));
		}
	}

	const folderNow = () => backupFolderName(rootNow());

	/** This vault's manifests from the device, once per vault: what LAST,
	 *  FINISH and UNDO look through. Later writes keep them in step. */
	async function loadManifests() {
		const folder = folderNow();
		if (manifestsOf === folder) return folder;
		await forget(DEVICE_BACKUP_ROOT);
		const manifests = await bridgeCall('colonBackupManifests', { folder }) ?? {};
		for (const [id, text] of Object.entries(manifests)) {
			if (plain(id) && typeof text === 'string') vfs.patch(`${DEVICE_BACKUP_ROOT}/${folder}/${id}/manifest.json`, text);
		}
		manifestsOf = folder;
		return folder;
	}

	/** The conversion an undo of `id` means: that one, or the newest not
	 *  undone (the converter's own choice, findManifest). */
	function undoTarget(folder, id) {
		const base = `${DEVICE_BACKUP_ROOT}/${folder}`;
		let ids;
		try { ids = vfs.readdir(base).sort().reverse(); } catch { return null; }
		for (const name of ids) {
			if (id && name !== id) continue;
			let manifest;
			try {
				const data = vfs.read(`${base}/${name}/manifest.json`);
				manifest = JSON.parse(typeof data === 'string' ? data : decodeUtf8(data));
			} catch { continue; }
			if (!id && manifest.undone) continue;
			return name;
		}
		return null;
	}

	// ---- what reaches the renderer: no device path ------------------------
	// A path runs to the next quote, bracket, comma, semicolon or line end, not
	// the next space: a device path holds spaces ("Application Support",
	// "Mobile Documents", a vault or note name). Words after an unquoted path
	// go with it, which is the safe side.
	const PATH_TAIL = `[^'"“”‘’,;()\\n]*`;
	const DEVICE_PATH = new RegExp(`(?:file://)?(?:/private)?/(?:var/mobile|var/containers|Users/[^/\\s]+/Library/Developer)/${PATH_TAIL}`, 'g');
	const INTERNAL_PATH = new RegExp(`(?:${DEVICE_BACKUP_ROOT}|${COLON_VAULTS_ROOT})/${PATH_TAIL}`, 'g');
	const scrub = (text) => {
		let out = String(text ?? '');
		if (vaults.realPath) out = out.split(vaults.realPath).join(vaults.name ?? 'the vault');
		return out.replace(DEVICE_PATH, '(a file on this iPad)').replace(INTERNAL_PATH, BACKUP_WORDS);
	};
	const scrubFailed = (failed) => (failed ?? []).map((f) => ({ ...f, why: scrub(f.why) }));
	const guarded = (work) => async (...args) => {
		try { return await work(...args); } catch (err) { throw new Error(scrub(err?.message ?? err)); }
	};

	return {
		scan: guarded(async () => {
			if (!vaults.isOpen) throw new Error('No vault open');
			await prepare();
			return converter.scan({ progress });
		}),

		apply: guarded(async ({ scanId, picks, editing } = {}) => {
			if (!vaults.isOpen) throw new Error('No vault open');
			const folder = await loadManifests();
			let result;
			vaults.backupFailure = null;
			applying = true;
			try {
				result = await converter.apply({ scanId, picks, editing, progress });
				// Every backup job settled (the manifest's last write too): a note
				// for an editor goes only with its backup on the device.
				await vaults.flush();
				const refusal = backupRefusal();
				if (refusal && result.editorPlans.length) {
					result = { ...result, failed: [...result.failed, ...result.editorPlans.map((p) => ({ path: p.path, why: refusal }))], editorPlans: [] };
				}
			} finally {
				applying = false;
				// The backups are on their way to the device (the queue holds
				// their bytes); the mirror need not keep them. Undo reads them back.
				const base = `${DEVICE_BACKUP_ROOT}/${folder}/`;
				await sliced([...vfs.files.keys()], (abs) => {
					if (abs.startsWith(base) && abs.includes('/notes/')) { vfs.files.delete(abs); vfs.writes.delete(abs); }
				});
			}
			// With a backup refused, nothing was changed and nothing was kept:
			// the sheet says why in each note's line, never "each note was copied".
			const kept = result.backup && !vaults.backupFailure;
			return { ...result, backup: kept ? BACKUP_WORDS : null, failed: scrubFailed(result.failed) };
		}),

		finish: guarded(async ({ id, applied } = {}) => {
			await loadManifests();
			vaults.backupFailure = null;
			const result = converter.finish({ id, applied });
			// The manifest's account of the editors' notes, on the device.
			await vaults.flush();
			if (vaults.backupFailure) {
				throw new Error(`The conversion's record could not be saved on this iPad (${scrub(vaults.backupFailure.message)}): the notes changed in their editors are kept in their history`);
			}
			return result;
		}),

		last: guarded(async () => {
			if (!vaults.isOpen) return null;
			await loadManifests();
			return converter.last();
		}),

		undo: guarded(async ({ id = null } = {}) => {
			if (!vaults.isOpen) throw new Error('No vault open');
			const folder = await loadManifests();
			const target = undoTarget(folder, id);
			const notesDir = target ? `${DEVICE_BACKUP_ROOT}/${folder}/${target}/notes` : null;
			if (target) {
				// The notes as they were — only now, only this conversion's, and
				// only those it wrote; a few hundred a call, so no one reply (or
				// its decoding) holds the page the UI shares.
				let manifest = null;
				try {
					const data = vfs.read(`${DEVICE_BACKUP_ROOT}/${folder}/${target}/manifest.json`);
					manifest = JSON.parse(typeof data === 'string' ? data : decodeUtf8(data));
				} catch { /* the converter says so */ }
				const paths = (manifest?.notes ?? []).filter((n) => n.status === 'written' && plain(n.path)).map((n) => n.path);
				for (let i = 0; i < paths.length; i += NOTES_PER_CALL) {
					const notes = await bridgeCall('colonBackupNotes', { folder, id: target, paths: paths.slice(i, i + NOTES_PER_CALL) }) ?? {};
					for (const [rel, base64] of Object.entries(notes)) {
						if (plain(rel) && typeof base64 === 'string') vfs.patch(`${notesDir}/${rel}`, Buffer.from(base64, 'base64'));
					}
				}
			}
			try {
				const result = await converter.undo({ id: target ?? id, progress });
				return { ...result, backup: result.backup ? BACKUP_WORDS : null, failed: scrubFailed(result.failed) };
			} finally {
				if (notesDir) await forget(notesDir);
			}
		}),
	};
}
