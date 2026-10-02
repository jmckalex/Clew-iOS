// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Handing a file to the operating system: the write-up for
// `[[paper.pdf|external]]` and for `file://` links in notes, which open in
// whatever app the OS says owns the type rather than in a Clew tab.
//
// Two callers, two shapes. A vault-relative path comes from the wikilink
// alias and is clamped inside the vault. An absolute path comes from a
// `file://` URL, which Obsidian allows to point anywhere — so it is NOT
// clamped, because a vault of notes about files elsewhere on the disk is
// exactly the case that syntax exists for.
//
// What IS refused, by name, is the extension list below. `shell.openPath`
// on a document is inert, but on a .app or a .exe it LAUNCHES it, and a
// note is content — a vault someone sent you must not be one click from
// running code. Documents open; programs do not.
// This module deliberately imports NO electron: every decision here is the
// security-relevant part, so it stays pure and unit-tested, and the caller
// (ipc.js, which already has electron) performs the shell.openPath.
import fs from 'node:fs';
import path from 'node:path';

// Directly executable, or executed by a default handler on some platform
// (.js runs under Windows Script Host; .sh in a terminal). Extensions, not
// contents: this is a speed bump against a careless click, not a sandbox.
const REFUSED = new Set([
	'app', 'exe', 'com', 'bat', 'cmd', 'msi', 'scr', 'pif', 'jar', 'pkg',
	'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'ps1', 'psm1',
	'sh', 'bash', 'zsh', 'command', 'tool', 'scpt', 'scptd', 'applescript',
	'workflow', 'action', 'apk', 'appimage', 'deb', 'rpm', 'run',
]);

/**
 * Decide whether a file may be handed to the OS, and which one.
 * `rel` is vault-relative (clamped inside the vault); `abs` is absolute
 * (from a file:// URL). Returns {ok:true, target} for the caller to open,
 * or {ok:false, reason} — the reason is shown as a notice, never swallowed.
 */
export function planOpen(vaults, { rel = null, abs = null }) {
	let target;
	if (rel) {
		if (!vaults?.isOpen) return { ok: false, reason: 'No vault open' };
		try {
			target = vaults.resolve(rel); // throws if the path escapes the vault
		} catch {
			return { ok: false, reason: `Path escapes the vault: ${rel}` };
		}
	} else if (abs) {
		target = path.resolve(abs);
	} else {
		return { ok: false, reason: 'Nothing to open' };
	}

	let stat;
	try { stat = fs.statSync(target); } catch { return { ok: false, reason: `Not found: ${path.basename(target)}` }; }
	if (!stat.isFile() && !stat.isDirectory()) {
		return { ok: false, reason: `Not a file: ${path.basename(target)}` };
	}
	// A directory is a Finder/Explorer reveal, never an execution risk — but
	// a macOS bundle IS a directory, so the extension check runs on both.
	const ext = path.extname(target).replace(/^\./, '').toLowerCase();
	if (REFUSED.has(ext)) {
		return { ok: false, reason: `Clew does not open .${ext} files in another app — opening one could run a program` };
	}
	return { ok: true, target };
}

/** A file:// URL → an absolute path, or null if it is not one we can use. */
export function pathFromFileUrl(url) {
	try {
		const parsed = new URL(String(url));
		if (parsed.protocol !== 'file:') return null;
		// Reject a remote UNC-style host: file://server/share is not local.
		if (parsed.hostname && parsed.hostname !== 'localhost') return null;
		return decodeURIComponent(parsed.pathname);
	} catch {
		return null;
	}
}
