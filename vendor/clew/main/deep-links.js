// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Deep links and the `clew` command, the pure half (FEATURE-IDEAS #8; the
// owner's pick, 2026-10-03): what a `clew://` URL or a command line ASKS for,
// and which vault it names — no electron, no fs beyond what the caller hands
// in, so tests/deep-links.test.js holds every rule. main/deep-link-host.js
// does what is asked.
//
//   clew://open?vault=<name|path>&note=<vault-relative path>[&line=N][#heading]
//   clew://new?vault=<name|path>&daily=1
//   clew://new?vault=<name|path>&note=<path>
//
// What a link from OUTSIDE may do (the owner's rule): open and navigate,
// nothing else — it never runs code, changes trust or writes, except `new`,
// which creates an empty note (or today's diary entry) and says so. A vault
// Clew does not know is opened only after the user says yes. Anything else
// is refused BY NAME.

const ACTIONS = new Set(['open', 'new']);

/**
 * A `clew://` URL as a request, or `{ error }` naming what is wrong.
 * @param {string} url
 * @returns {{ action: 'open'|'new', vault: string|null, note: string|null,
 *   heading: string|null, line: number|null, daily: boolean } | { error: string }}
 */
export function parseClewUrl(url) {
	let u;
	try { u = new URL(String(url ?? '')); } catch { return { error: 'not a URL' }; }
	if (u.protocol !== 'clew:') return { error: `not a clew:// link (${u.protocol})` };
	// clew://open?… parses with "open" as the host; clew:open?… as the path.
	const action = (u.host || u.pathname.replace(/^\/+/, '')).toLowerCase();
	if (!ACTIONS.has(action)) return { error: `clew://${action} is not something a link can do (open, new)` };
	const q = u.searchParams;
	const vault = q.get('vault')?.trim() || null;
	const note = cleanNotePath(q.get('note'));
	if (note === false) return { error: 'the note path climbs out of the vault' };
	const lineText = q.get('line');
	const line = lineText && /^\d{1,7}$/.test(lineText) ? Number(lineText) : null;
	const heading = u.hash ? decodeURIComponent(u.hash.slice(1)) || null : null;
	const daily = action === 'new' && /^(1|true|yes)$/i.test(q.get('daily') ?? '');
	if (action === 'open' && !vault && !note) return { error: 'clew://open needs a vault or a note' };
	if (action === 'new' && !daily && !note) return { error: 'clew://new needs daily=1 or a note' };
	return { action, vault, note, heading, line, daily };
}

/** A vault-relative note path, cleaned: null when absent, false when it
 *  climbs out (`..`) or is absolute. A missing extension means `.md`. */
export function cleanNotePath(raw) {
	if (raw === null || raw === undefined || String(raw).trim() === '') return null;
	const p = String(raw).trim().replace(/\\/g, '/');
	if (p.startsWith('/') || /^[a-z]:\//i.test(p)) return false;
	const parts = p.split('/').filter((s) => s && s !== '.');
	if (parts.some((s) => s === '..')) return false;
	const joined = parts.join('/');
	return /\.[a-z0-9]{1,8}$/i.test(joined) ? joined : `${joined}.md`;
}

/**
 * Which vault a link or command names: an absolute path (or `~/…`) as it
 * is, else the NAME of a vault this device knows (its folder's name,
 * matched ignoring case). `{ path, known }`, or `{ error }` — no such
 * vault, or two known vaults of that name.
 * @param {string} spec
 * @param {string[]} knownPaths - the vaults this device knows (open + recent)
 * @param {string} home
 */
export function resolveVaultSpec(spec, knownPaths, home = '') {
	const s = String(spec ?? '').trim();
	if (!s) return { error: 'no vault named' };
	const known = [...new Set(knownPaths.filter(Boolean).map((p) => p.replace(/\/+$/, '')))];
	if (s.startsWith('/') || s.startsWith('~/') || /^[a-z]:[\\/]/i.test(s)) {
		const path = (s.startsWith('~/') ? `${home.replace(/\/+$/, '')}/${s.slice(2)}` : s).replace(/\/+$/, '');
		return { path, known: known.includes(path) };
	}
	const name = s.toLowerCase();
	const matches = known.filter((p) => p.split(/[\\/]/).pop().toLowerCase() === name);
	if (matches.length === 1) return { path: matches[0], known: true };
	if (matches.length > 1) return { error: `two vaults are called "${s}" — name it by its path` };
	return { error: `no vault called "${s}" is known on this device — name it by its path` };
}

/**
 * The vault a FILE belongs to, for `clew open <file>`: the nearest folder
 * above it holding `.clew` or `.obsidian`; failing that, a known vault that
 * contains it; failing that, its own folder. `isVault(dir)` and the known
 * paths come from the caller.
 */
export function vaultForFile(file, { isVault, knownPaths = [] }) {
	const parts = String(file).replace(/\/+$/, '').split('/');
	for (let n = parts.length - 1; n > 0; n--) {
		const dir = parts.slice(0, n).join('/') || '/';
		if (isVault(dir)) return dir;
	}
	const inside = knownPaths.filter((k) => file.startsWith(`${k.replace(/\/+$/, '')}/`))
		.sort((a, b) => b.length - a.length)[0];
	return inside ?? (parts.slice(0, -1).join('/') || '/');
}

/** `clew …` arguments as a request, or `{ error, usage }`. */
export function parseCliArgs(argv) {
	const [cmd, ...rest] = argv;
	const flags = new Set(rest.filter((a) => a.startsWith('--')));
	// An option's value is taken by POSITION, so a value equal to the note's
	// own path is never mistaken for it.
	const valueOf = (name) => {
		const at = rest.indexOf(name);
		return at >= 0 && rest[at + 1] != null && !rest[at + 1].startsWith('--') ? { at: at + 1, value: rest[at + 1] } : null;
	};
	const vaultOpt = valueOf('--vault');
	const outOpt = valueOf('--out');
	const vault = vaultOpt?.value ?? null;
	const positional = rest.filter((a, i) => !a.startsWith('--') && i !== vaultOpt?.at && i !== outOpt?.at);
	if (cmd === 'open') {
		if (!positional[0]) return { error: 'open what?', usage: true };
		return { cmd: 'open', path: positional[0] };
	}
	if (cmd === 'new') {
		if (flags.has('--daily')) return { cmd: 'new', daily: true, vault };
		if (!positional[0]) return { error: 'new what? (a note path, or --daily)', usage: true };
		return { cmd: 'new', note: positional[0], vault };
	}
	if (cmd === 'export') {
		const format = ['latex', 'pdf', 'html'].find((f) => flags.has(`--${f}`));
		if (!format) return { error: 'export as what? (--latex, --pdf or --html)', usage: true };
		if (!positional[0]) return { error: 'export which note?', usage: true };
		if (flags.has('--out') && !outOpt) return { error: 'export --out where? (a file or a folder)', usage: true };
		return { cmd: 'export', format, path: positional[0], out: outOpt?.value ?? null };
	}
	return { error: cmd ? `unknown command "${cmd}"` : 'no command', usage: true };
}

export const USAGE = `usage:
  clew open <file or folder>            open a vault, or a note in its vault
  clew new --daily [--vault <v>]        today's diary entry (created if missing)
  clew new <note> [--vault <v>]         a new, empty note (never over a file)
  clew export --latex|--pdf|--html <note> [--out <file or folder>]
                                        export a note — beside it, or at --out;
                                        only the .pdf/.tex/.html is written`;
