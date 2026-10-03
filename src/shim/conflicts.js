// Edit-conflict safety for synced vaults, the iOS-only part (FEATURE-IDEAS
// #1; CONFLICT-SAFETY.md). Since the 2f5d80d sync the renderer's own
// conflicts.js is the shared half: an editor's guarded save refused natively
// (VaultStore.write, vault-manager.js#writeNoteGuarded), a change arriving
// under unsaved edits, Dropbox's conflicted copies and git's markers all
// reach ITS banner and sheet, exactly as on the desktop.
//
// What only iOS has is iCloud Drive's own conflict: NSFileVersion keeps the
// losing versions as unresolved conflict versions of the file (VaultStore
// reads ubiquitousItemHasUnresolvedConflicts in its walk). This module keeps
// those, offered through the renderer's sheet (conflict-sheet.js): both texts
// go to .clew/history FIRST, and the versions are marked resolved only after
// the user's choice.
import { vfs } from '../worker/shims/vfs.js';
import { VAULT_ROOT } from './vault-manager.js';
import { bridgeCall } from './native-bridge.js';
import { keepVersion } from '../../vendor/clew/main/history.js';
import { conflictSiblingPath } from '../../vendor/clew/shared/conflict-text.js';

export class ConflictCenter {
	#vaults;
	#fileChanged;
	#structureChanged;
	#listeners = new Set();
	/** iCloud conflicts already announced (rescans repeat the list). */
	#cloudSeen = new Set();

	constructor({ vaults, fileChanged, structureChanged }) {
		this.#vaults = vaults;
		this.#fileChanged = fileChanged;
		this.#structureChanged = structureChanged;
	}

	/** listener({kind: 'cloud', rel}) */
	on(listener) {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	#emit(event) {
		for (const fn of [...this.#listeners]) {
			try { fn(event); } catch (err) { console.error('[clew-ios] conflict listener:', err); }
		}
	}

	/** A vault (re)opened: nothing announced yet. */
	reset() {
		this.#cloudSeen.clear();
	}

	/** A version into the note's history (history.js#keepVersion: the
	 *  note-history browser lists it). Never throws. */
	keepVersion(rel, text) {
		return keepVersion(VAULT_ROOT, rel, String(text ?? ''));
	}

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
}
