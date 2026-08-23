// Wikilink propagation on rename: when a note (or folder of notes) is
// renamed/moved, rewrite [[links]] across the vault so they keep resolving.
// Runs after the filesystem rename, using the pre-rename index state.
import fs from 'node:fs';
import path from 'node:path';
import { direntKind, shouldRecurse, walkGuard } from './fs-utils.js';

const stripExt = (p) => p.replace(/\.(md|jmd)$/i, '');
const baseName = (relPath) => stripExt(relPath.split('/').pop());
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * @param {object} args
 * @param {string} args.oldRel   pre-rename vault-relative path (note or folder)
 * @param {string} args.newRel   post-rename vault-relative path
 * @param {import('./indexer.js').Indexer} args.indexer  (pre-rename state)
 * @param {import('./vault.js').VaultManager} args.vaults
 * @returns {{rewrittenFiles: number, rewrittenLinks: number}}
 */
export function propagateRename({ oldRel, newRel, indexer, vaults }) {
	// Map of renamed note paths: old → new. A folder rename moves every note
	// under it; a note rename moves just itself.
	const renamed = new Map();
	for (const notePath of indexer.notes.keys()) {
		if (notePath === oldRel) renamed.set(notePath, newRel);
		else if (notePath.startsWith(oldRel + '/')) {
			renamed.set(notePath, newRel + notePath.slice(oldRel.length));
		}
	}
	if (renamed.size === 0) return { rewrittenFiles: 0, rewrittenLinks: 0 };

	let rewrittenFiles = 0;
	let rewrittenLinks = 0;

	for (const [notePath, meta] of indexer.notes) {
		const links = meta.links.filter((l) => l.resolved && renamed.has(l.resolved));
		if (links.length === 0) continue;

		// The linking file may itself have moved.
		const currentPath = renamed.get(notePath) ?? notePath;
		const abs = vaults.resolve(currentPath);
		let text;
		try { text = fs.readFileSync(abs, 'utf8'); } catch { continue; }
		let changed = false;

		for (const link of links) {
			const newTarget = renamed.get(link.resolved);
			// How was the link written? Path form gets the new path (sans
			// extension); bare-name form gets the new basename — but only when
			// the basename actually changed (a pure move keeps bare names valid).
			const replacement = link.target.includes('/')
				? stripExt(newTarget)
				: baseName(newTarget);
			if (link.target === replacement) continue;
			const pattern = new RegExp(
				`(\\[\\[\\s*)${escapeRe(link.target)}(\\s*[#|\\]])`, 'g');
			const next = text.replace(pattern, (_, open, close) => `${open}${replacement}${close}`);
			if (next !== text) {
				text = next;
				changed = true;
				rewrittenLinks++;
			}
		}

		if (changed) {
			fs.writeFileSync(abs, text);
			rewrittenFiles++;
		}
	}

	rewrittenFiles += rewriteCanvasRefs({ oldRel, newRel, vaults });
	return { rewrittenFiles, rewrittenLinks };
}

/**
 * Canvas file nodes reference vault paths verbatim (any file type, not just
 * notes) — rewrite them across every .canvas in the vault after a rename.
 */
function rewriteCanvasRefs({ oldRel, newRel, vaults }) {
	const remap = (p) => {
		if (p === oldRel) return newRel;
		if (p.startsWith(oldRel + '/')) return newRel + p.slice(oldRel.length);
		return p;
	};
	let rewritten = 0;
	const seen = walkGuard(vaults.root);
	const walk = (dir) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || ['node_modules', '.trash'].includes(entry.name)) continue;
			const abs = path.join(dir, entry.name);
			if (direntKind(dir, entry) === 'dir') {
				if (shouldRecurse(abs, seen)) walk(abs);
				continue;
			}
			if (!entry.name.toLowerCase().endsWith('.canvas')) continue;
			let json;
			try { json = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch { continue; }
			let changed = false;
			for (const node of Array.isArray(json?.nodes) ? json.nodes : []) {
				if (node?.type === 'file' && typeof node.file === 'string') {
					const next = remap(node.file);
					if (next !== node.file) {
						node.file = next;
						changed = true;
					}
				}
			}
			if (changed) {
				fs.writeFileSync(abs, JSON.stringify(json, null, '\t'));
				rewritten++;
			}
		}
	};
	walk(vaults.root);
	return rewritten;
}
