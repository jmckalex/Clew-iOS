// Edit-conflict safety for synced vaults (FEATURE-IDEAS #1): the same note
// edited on the Mac and the iPad must never lose a version SILENTLY.
//
// How a vault travels decides how a conflict shows itself:
// - iCloud Drive: NSFileVersion keeps the losing versions as unresolved
//   conflict versions (VaultStore reads ubiquitousItemHasUnresolvedConflicts
//   in its walk).
// - Dropbox (its File Provider): the loser lands beside the note as
//   "Note (Name's conflicted copy YYYY-MM-DD).md".
// - git through Working Copy: a merge leaves <<<<<<< ======= >>>>>>> markers.
// - Any of them, between two rescans: a newer file under an open editor.
//   That is the silent case. The editor saves, and the other device's
//   version was overwritten unseen. VaultStore.write now refuses a write
//   over a version this app did not see; the refusal comes here.
//
// The rule everywhere: both versions go to .clew/history FIRST, then the
// user chooses: keep mine, keep theirs, keep both (the other saved as
// "… (conflict YYYY-MM-DD).md"), with a compare view. NSFileVersion
// conflicts are marked resolved only after the choice.
import { vfs } from '../worker/shims/vfs.js';
import { VAULT_ROOT } from './vault-manager.js';
import { bridgeCall } from './native-bridge.js';

import { historyStamp, conflictSiblingPath, findDropboxCopies, hasGitConflictMarkers, lineDiff } from '../../vendor/clew/shared/conflict-text.js';

export { historyStamp, conflictSiblingPath, findDropboxCopies, hasGitConflictMarkers, lineDiff };

/**
 * The shim's conflicts: held notes (a refused save), iCloud's conflict
 * versions and Dropbox's conflicted copies, each resolved by the user's
 * choice after both versions are safe in .clew/history.
 */
export class ConflictCenter {
	#vaults;
	#fileChanged;
	#structureChanged;
	#listeners = new Set();
	/** rel → { source: 'save', mine, theirs } — saves held until resolved. */
	held = new Map();
	/** iCloud conflicts already announced (rescans repeat the list). */
	#cloudSeen = new Set();
	/** Dropbox copies and git-marked notes already announced. */
	#scanSeen = new Set();

	constructor({ vaults, fileChanged, structureChanged }) {
		this.#vaults = vaults;
		this.#fileChanged = fileChanged;
		this.#structureChanged = structureChanged;
	}

	/** listener({kind: 'save'|'cloud'|'dropbox'|'git', rel, ...}) */
	on(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event) {
		for (const fn of [...this.#listeners]) {
			try { fn(event); } catch (err) { console.error('[clew-ios] conflict listener:', err); }
		}
	}

	isHeld(rel) { return this.held.has(rel); }

	/** A vault (re)opened: nothing announced yet. */
	reset() {
		this.held.clear();
		this.#cloudSeen.clear();
		this.#scanSeen.clear();
	}

	/** A version into .clew/history/<rel>/ under history.js's naming, so the
	 *  note-history browser lists it. Never throws: safety must not fail the
	 *  thing it protects. Returns the snapshot's vault path, or null. */
	keepVersion(rel, text) {
		try {
			const slash = rel.lastIndexOf('/');
			const name = rel.slice(slash + 1);
			const dot = name.lastIndexOf('.');
			const ext = dot > 0 ? name.slice(dot) : '.md';
			const dir = `${VAULT_ROOT}/.clew/history/${rel}`;
			const stamp = historyStamp(Date.now());
			let file = `${dir}/${stamp}${ext}`;
			for (let n = 1; vfs.has(file); n++) file = `${dir}/${stamp}-${n}${ext}`;
			vfs.mkdir(dir);
			vfs.write(file, String(text ?? ''));
			return file.slice(VAULT_ROOT.length + 1);
		} catch (err) {
			console.warn(`[clew-ios] could not keep a version of ${rel}:`, err);
			return null;
		}
	}

	// ---- a refused save (VaultStore.write) ----------------------------------

	onWriteConflict(rel, { mine, theirs }) {
		const existing = this.held.get(rel);
		if (existing) { existing.mine = mine; existing.theirs = theirs; return; }
		this.keepVersion(rel, theirs);
		this.keepVersion(rel, mine);
		this.held.set(rel, { source: 'save', mine, theirs });
		this.#emit({ kind: 'save', rel, mine, theirs });
	}

	/** A newer disk version arrived while held: it is the new "theirs". */
	onHeldDiskChange(rel, theirs) {
		const entry = this.held.get(rel);
		if (!entry || entry.theirs === theirs) return;
		this.keepVersion(rel, theirs);
		entry.theirs = theirs;
		this.#emit({ kind: 'save', rel, mine: entry.mine, theirs, updated: true });
	}

	/** 'mine' | 'theirs' | 'both' for a held note. */
	async resolve(rel, choice) {
		const entry = this.held.get(rel);
		if (!entry) return false;
		const abs = `${VAULT_ROOT}/${rel}`;
		const mine = vfs.has(abs) ? String(vfs.read(abs)) : entry.mine; // the latest of the user's saves
		if (choice === 'both') {
			const sibling = conflictSiblingPath(rel, (p) => vfs.has(`${VAULT_ROOT}/${p}`));
			vfs.write(`${VAULT_ROOT}/${sibling}`, entry.theirs);
			this.#structureChanged();
			entry.sibling = sibling;
		}
		this.held.delete(rel);
		if (choice === 'theirs') {
			vfs.write(abs, entry.theirs); // equal to the disk now: native writes it through
			this.#fileChanged(rel);        // the editor reloads it
		} else {
			await this.#vaults.writeForce(rel, mine);
		}
		await this.#vaults.flush();
		return entry.sibling ?? true;
	}

	// ---- iCloud's conflict versions -----------------------------------------

	onCloudConflicts(rels) {
		for (const rel of rels) {
			if (this.#cloudSeen.has(rel)) continue;
			this.#cloudSeen.add(rel);
			this.#emit({ kind: 'cloud', rel });
		}
		for (const rel of [...this.#cloudSeen]) if (!rels.includes(rel)) this.#cloudSeen.delete(rel);
	}

	/** The current text and iCloud's other versions, for the sheet. */
	async cloudVersions(rel) {
		const versions = await bridgeCall('cloudConflictVersions', { rel });
		const abs = `${VAULT_ROOT}/${rel}`;
		return { current: vfs.has(abs) ? String(vfs.read(abs)) : '', versions: versions ?? [] };
	}

	/** 'mine' (the current) | 'theirs' (version `index`) | 'both'. Both
	 *  texts are kept in history first; native marks the versions resolved
	 *  only now. */
	async resolveCloud(rel, choice, index = 0) {
		const { current, versions } = await this.cloudVersions(rel);
		const other = versions[index];
		this.keepVersion(rel, current);
		if (other) this.keepVersion(rel, other.text);
		let sibling = null;
		if (choice === 'both' && other) {
			sibling = conflictSiblingPath(rel, (p) => vfs.has(`${VAULT_ROOT}/${p}`));
			vfs.write(`${VAULT_ROOT}/${sibling}`, other.text);
			this.#structureChanged();
		}
		await this.#vaults.flush();
		await bridgeCall('resolveCloudConflict', { rel, ...(choice === 'theirs' && other ? { keepOther: index } : {}) });
		if (choice === 'theirs' && other) {
			vfs.patch(`${VAULT_ROOT}/${rel}`, other.text, Date.now());
			this.#fileChanged(rel);
		}
		this.#cloudSeen.delete(rel);
		return sibling ?? true;
	}

	// ---- Dropbox's conflicted copies and git markers ------------------------

	/** Scan the mirror: Dropbox copies beside their notes (over `paths`),
	 *  and notes holding git conflict markers (over `gitPaths`: everything
	 *  at open, then each note as it changes). One event each, until it is
	 *  gone and comes back. */
	scan(paths, gitPaths = paths) {
		const copies = findDropboxCopies(paths);
		const live = new Set(copies.map((c) => `dropbox:${c.copy}`));
		for (const key of [...this.#scanSeen]) if (key.startsWith('dropbox:') && !live.has(key)) this.#scanSeen.delete(key);
		for (const c of copies) {
			if (this.#scanSeen.has(`dropbox:${c.copy}`)) continue;
			this.#scanSeen.add(`dropbox:${c.copy}`);
			this.#emit({ kind: 'dropbox', rel: c.base, ...c });
		}
		const git = [];
		for (const rel of gitPaths) {
			if (!/\.(md|jmd)$/i.test(rel)) continue;
			let marked = false;
			try {
				const text = String(vfs.read(`${VAULT_ROOT}/${rel}`));
				marked = text.includes('<<<<<<<') && hasGitConflictMarkers(text);
			} catch { /* gone */ }
			if (!marked) { this.#scanSeen.delete(`git:${rel}`); continue; }
			git.push(rel);
			if (this.#scanSeen.has(`git:${rel}`)) continue;
			this.#scanSeen.add(`git:${rel}`);
			this.#emit({ kind: 'git', rel });
		}
		return { copies, git };
	}

	/** A Dropbox copy: 'mine' keeps the note (the copy goes to history and the
	 *  trash), 'theirs' puts the copy's text in the note (the note's goes to
	 *  history), 'both' leaves both files as they are. */
	async resolveDropbox({ base, copy }, choice) {
		if (choice === 'both') return true;
		const read = (rel) => String(vfs.read(`${VAULT_ROOT}/${rel}`));
		const mine = read(base);
		const theirs = read(copy);
		this.keepVersion(base, mine);
		this.keepVersion(base, theirs);
		if (choice === 'theirs') {
			vfs.write(`${VAULT_ROOT}/${base}`, theirs);
			this.#fileChanged(base);
		}
		await this.#vaults.flush();
		await this.#vaults.trash(copy); // the tree follows
		return true;
	}
}
