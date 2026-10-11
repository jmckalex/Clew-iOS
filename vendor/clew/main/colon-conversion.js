// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Convert this vault" — the colon directives' retirement, phase 2, main's
// half: a vault's notes run through shared/colon-conversion.js (the engine's
// converter), never automatically.
//
//   scan()    a dry run over every note — nothing is written. Each note with
//             something to show is remembered with the hash of the bytes it was
//             planned from.
//   apply()   the user's choice, in two passes. First every note is read and
//             checked against its preview — one whose bytes are not the planned
//             ones any more is NOT written, but planned again and handed back
//             to be looked at again — converted, copied as it was into
//             <userData>/colon-conversion/<vault>/<time>/notes/ beside a
//             manifest, and kept in its history (history.js#keepVersion —
//             whatever the interval, even with history off). Then the writes,
//             atomic and fsynced, several in flight, each note read once more
//             just before. A note the user has open in an editor is not written
//             here: its before and after go back to the renderer, which changes
//             it as a transaction on that editor (undo, the dirty dot, a guarded
//             save) and says which it did in finish().
//   undo()    puts back each note STILL exactly as the conversion wrote it,
//             byte for byte from the backup (the converted text kept in history
//             first); a note changed since is left as it is, and named.
//
// Restricted vaults are offered too: converting is text in and text out, and
// runs nothing of the vault's. Electron-free: the vault comes in as an adapter
// (ipc.js builds it over the session's VaultManager; the unit test over a
// folder). Its own work yields every 8 ms, and no file of its own waits on
// another's fsync — the passes exist for that: on APFS a file created while
// fsyncs were in flight held main 270 ms. Measured on 5,000 notes (smoke/
// README.md): the dry run holds main ≤10 ms; while the notes are written the
// watcher's and the indexer's answer to thousands of changed files is what
// holds it longest (≤ ~100–180 ms), never the window's frames.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { planNote, planIsEmpty, applyPlan, lineEndings, headerLoadsDirectives, configLoadsDirectives } from '../shared/colon-conversion.js';

const SLICE_MS = 8;
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** A folder name for the vault's backups: its name and a hash of where it is. */
export function backupFolderName(root) {
	let real = root;
	try { real = fs.realpathSync(root); } catch { /* the plain path */ }
	const name = path.basename(root).replace(/[^\w .-]+/g, '_').slice(0, 60) || 'vault';
	return `${name}-${sha(real).slice(0, 12)}`;
}

/** Writes in flight, at most WRITES at once: each note's atomic write waits
 *  on its own fsync, off the main thread, so several overlap. `add` resolves
 *  once there is room; a failed write calls its `undo` and is named in
 *  `failed`. */
const WRITES = 8;
function writeQueue() {
	const inflight = new Set();
	return {
		async add(promise, undo, rel, failed) {
			const p = Promise.resolve(promise).catch((err) => {
				undo();
				failed.push({ path: rel, why: err?.message ?? String(err) });
			}).finally(() => inflight.delete(p));
			inflight.add(p);
			if (inflight.size >= WRITES) await Promise.race(inflight);
		},
		done: () => Promise.all(inflight),
	};
}

const costOf = (m) => `${m.ms} ms, peak RSS ${m.peakRssMB} MB, main's event loop held at most ${m.loopDelayMaxMs} ms (p99 ${m.loopDelayP99Ms})`;
const stampOf = (ms) => new Date(ms).toISOString().replace(/[:.]/g, '-');

/** Time slices with a progress report, and what the work cost: wall time,
 *  main's peak RSS, and the longest main's event loop was held (Node's own
 *  monitor, so whatever held it — this work, the watcher's events, an fs call
 *  waiting on another's fsync — is counted). */
function pacer(progress) {
	const started = performance.now();
	let slice = started;
	let peakRss = process.memoryUsage().rss;
	const loop = monitorEventLoopDelay({ resolution: 5 });
	loop.enable();
	return {
		async step(done, total, phase) {
			if (performance.now() - slice < SLICE_MS) return;
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
			progress?.({ done, total, phase });
			await tick();
			slice = performance.now();
		},
		metrics() {
			loop.disable();
			peakRss = Math.max(peakRss, process.memoryUsage().rss);
			return { ms: Math.round(performance.now() - started), peakRssMB: Math.round(peakRss / 1048576), loopDelayMaxMs: Math.round(loop.max / 1e5) / 10, loopDelayP99Ms: Math.round(loop.percentile(99) / 1e5) / 10 };
		},
	};
}

/**
 * @param {{
 *   vault: { root: string, restricted?: boolean, listNotes(): string[],
 *            read(rel): Buffer, readAsync(rel): Promise<Buffer>,
 *            write(rel, text: string|Buffer): Promise|void,
 *            keepVersion(rel, text): void },
 *   backupRoot: string,
 *   globalConfig?: string,     ~/.jmarkdown/config.json unless given
 *   now?: () => number,
 *   log?: (line: string) => void,
 *   debug?: (line: string) => void,   the prose items, which the sheet never shows
 * }} deps
 */
export function colonConverter({ vault, backupRoot, globalConfig = path.join(os.homedir(), '.jmarkdown', 'config.json'), now = Date.now, log = () => {}, debug = () => {} }) {
	let scanCount = 0;
	/** The newest dry run: { id, root, notes: Map(rel → { hash, plan, refuse }) }. */
	let latest = null;
	let busy = false;

	const readConfig = (file) => {
		try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
	};

	/** What makes a note load directives — its header, a folder's config from
	 *  its own up to the vault root (the engine reads the working folder's; an
	 *  export's is the note's, a command line's may be any above it), the
	 *  global config — or null. */
	function loadsFinder(root) {
		const global = configLoadsDirectives(readConfig(globalConfig));
		const folders = new Map();
		const folderLoads = (dirRel) => {
			if (folders.has(dirRel)) return folders.get(dirRel);
			const file = path.join(dirRel, '.jmarkdown', 'config.json');
			const key = configLoadsDirectives(readConfig(path.join(root, file)));
			const found = key ? { by: 'folder', file: file.split(path.sep).join('/'), key }
				: dirRel ? folderLoads(path.dirname(dirRel) === '.' ? '' : path.dirname(dirRel)) : null;
			folders.set(dirRel, found);
			return found;
		};
		return (rel, text) => {
			if (headerLoadsDirectives(text)) return { by: 'header' };
			const dir = path.dirname(rel);
			return folderLoads(dir === '.' ? '' : dir)
				?? (global ? { by: 'global', file: '~/.jmarkdown/config.json', key: global } : null);
		};
	}

	/** Plan one note's bytes: null when it has nothing to show. */
	function planBytes(rel, bytes, loadsFor, counts) {
		const text = bytes.toString('utf8');
		if (!text.includes(':')) return null;
		const plan = planNote(text, { loads: loadsFor(rel, text) });
		counts.prose += plan.prose.length;
		for (const p of plan.prose) debug(`colon-scan: prose ${rel}:${p.line} ${p.from}`);
		if (planIsEmpty(plan)) return null;
		let refuse = null;
		if (!Buffer.from(text, 'utf8').equals(bytes)) refuse = 'it is not UTF-8 text, and writing it back would change its bytes';
		else if (lineEndings(text) === 'mixed') refuse = 'its lines end both ways (CRLF and LF), and converting it would change every line ending';
		return { hash: sha(bytes), plan, refuse };
	}

	/** The renderer's view of a dry run: everything but the prose. */
	function report(scan, extra = {}) {
		const notes = [];
		const totals = { notes: 0, auto: 0, output: 0, needsYou: 0, choices: 0, loading: 0, refused: 0 };
		for (const [rel, { plan, refuse }] of [...scan.notes].sort((a, b) => a[0].localeCompare(b[0]))) {
			notes.push({ path: rel, autoItems: plan.autoItems, auto: plan.autoList, rows: plan.rows, loads: plan.loads, refuse });
			totals.notes++;
			totals.auto += refuse ? 0 : plan.autoItems;
			totals.output += plan.rows.filter((r) => r.kind === 'changes-output').length;
			totals.needsYou += plan.rows.filter((r) => r.kind === 'needs-you').length;
			totals.choices += refuse ? 0 : plan.rows.filter((r) => r.choice).length;
			if (plan.loads) totals.loading++;
			if (refuse) totals.refused++;
		}
		// No prose: not an item, not a count (main's log has them).
		return { scanId: scan.id, vault: path.basename(scan.root), restricted: !!vault.restricted, scanned: scan.scanned, totals, notes, ...extra };
	}

	async function scanPaths(rels, root, progress) {
		const loadsFor = loadsFinder(root);
		const pace = pacer(progress);
		const counts = { prose: 0 };
		const notes = new Map();
		for (let i = 0; i < rels.length; i++) {
			const rel = rels[i];
			let bytes;
			try { bytes = vault.read(rel); } catch { continue; /* gone, or leaves a restricted vault */ }
			const planned = planBytes(rel, bytes, loadsFor, counts);
			if (planned) notes.set(rel, planned);
			await pace.step(i + 1, rels.length);
		}
		progress?.({ done: rels.length, total: rels.length });
		const scan = { id: `scan-${++scanCount}`, root, notes, scanned: rels.length };
		const metrics = pace.metrics();
		log(`colon-scan: ${rels.length} notes, ${notes.size} with colon directives, ${counts.prose} prose (not shown) — ${costOf(metrics)}`);
		return { scan, metrics };
	}

	return {
		/** The dry run over the whole vault. */
		async scan({ progress } = {}) {
			if (busy) throw new Error('A conversion is already running in this window');
			busy = true;
			try {
				const root = vault.root;
				const { scan, metrics } = await scanPaths(vault.listNotes(), root, progress);
				latest = scan;
				return report(scan, { metrics });
			} finally { busy = false; }
		},

		/**
		 * Convert as chosen. `picks`: { [path]: [line, …] } — the rows ticked
		 * ("Convert anyway"); the default lines of every note always go.
		 * `editing`: the paths open in an editor, which the renderer changes.
		 */
		async apply({ scanId, picks = {}, editing = [], progress } = {}) {
			if (busy) throw new Error('A conversion is already running in this window');
			if (!latest || latest.id !== scanId || latest.root !== vault.root) throw new Error('This preview is out of date: run the dry run again');
			busy = true;
			try {
				const scan = latest;
				latest = null; // a preview is used once
				const time = now();
				const id = stampOf(time);
				const dir = path.join(backupRoot, backupFolderName(scan.root), id);
				const manifest = { version: 1, id, vault: scan.root, time: new Date(time).toISOString(), undone: null, notes: [] };
				const open = new Set(editing);
				const changed = [];
				const failed = [];
				const editorPlans = [];
				const pace = pacer(progress);
				const entries = [...scan.notes];
				// Pass 1, no write in flight: each note read and checked against its
				// preview, converted, copied into the backup and kept in its history.
				// Every copy exists before any note changes — and none waits on
				// another file's fsync (APFS held main 270 ms when they overlapped).
				const jobs = [];
				for (let i = 0; i < entries.length; i++) {
					const [rel, { hash, plan, refuse }] = entries[i];
					const chosen = (picks[rel] ?? []).map(Number);
					if (refuse || (!plan.auto.length && !chosen.length)) continue;
					let bytes;
					try { bytes = vault.read(rel); } catch { changed.push(rel); continue; }
					if (sha(bytes) !== hash) { changed.push(rel); continue; }
					const text = bytes.toString('utf8');
					let out;
					try { out = applyPlan(text, plan, chosen); } catch (err) { failed.push({ path: rel, why: err.message }); continue; }
					if (out.text === text) continue;
					const backup = path.join(dir, 'notes', rel);
					fs.mkdirSync(path.dirname(backup), { recursive: true });
					fs.writeFileSync(backup, bytes);
					vault.keepVersion(rel, text);
					const entry = { path: rel, before: hash, after: sha(Buffer.from(out.text, 'utf8')), status: 'written', converted: out.converted, lines: out.lines };
					if (open.has(rel) && !text.includes('\r')) {
						entry.status = 'editor';
						entry.after = null;
						editorPlans.push({ path: rel, before: text, after: out.text });
					} else jobs.push({ entry, text: out.text });
					manifest.notes.push(entry);
					await pace.step(i + 1, entries.length, 'backup');
				}
				// The manifest before any note is written: a conversion cut short is
				// undone by it all the same (a note never written is not "as written").
				if (manifest.notes.length) {
					fs.mkdirSync(dir, { recursive: true });
					fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, '\t'));
				}
				// Pass 2: the writes, atomic and fsynced, several in flight, each note
				// read once more just before — a note changed meanwhile is not written.
				const writes = writeQueue();
				for (let i = 0; i < jobs.length; i++) {
					const { entry, text } = jobs[i];
					let bytes = null;
					try { bytes = await vault.readAsync(entry.path); } catch { /* gone */ }
					if (!bytes || sha(bytes) !== entry.before) {
						entry.status = 'changed';
						entry.after = null;
						changed.push(entry.path);
					} else {
						await writes.add(vault.write(entry.path, text), () => {
							// Not written after all: nothing to undo, and said.
							entry.status = 'failed';
							entry.after = null;
						}, entry.path, failed);
					}
					await pace.step(i + 1, jobs.length, 'write');
				}
				await writes.done();
				const items = manifest.notes.filter((n) => n.status === 'written' || n.status === 'editor').reduce((t, n) => t + n.converted, 0);
				if (manifest.notes.length) fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, '\t'));
				const metrics = pace.metrics();
				// A note changed since the preview is planned again, never written:
				// the renderer shows it once more.
				let again = null;
				if (changed.length) {
					const { scan: fresh } = await scanPaths(changed, scan.root);
					latest = fresh;
					again = report(fresh);
				}
				log(`colon-apply: ${manifest.notes.length} notes, ${items} directives, ${changed.length} changed since the preview, ${failed.length} refused — ${costOf(metrics)}`);
				return {
					id: manifest.notes.length ? id : null, backup: manifest.notes.length ? dir : null,
					notes: manifest.notes.filter((n) => n.status === 'written').length, items,
					written: manifest.notes.filter((n) => n.status === 'written').map((n) => n.path),
					editorPlans, changed, again, failed, metrics,
				};
			} finally { busy = false; }
		},

		/** The renderer's account of the notes it changed in their editors:
		 *  `applied` were changed and saved, the rest were not. */
		finish({ id, applied = [] } = {}) {
			const found = findManifest(id);
			if (!found) return { ok: false };
			const done = new Set(applied);
			for (const n of found.manifest.notes) {
				if (n.status !== 'editor') continue;
				if (done.has(n.path)) {
					try { n.after = sha(vault.read(n.path)); n.status = 'written'; } catch { n.status = 'skipped'; }
				} else n.status = 'skipped';
			}
			writeManifest(found);
			const written = found.manifest.notes.filter((n) => n.status === 'written');
			return { ok: true, notes: written.length, items: written.reduce((t, n) => t + n.converted, 0) };
		},

		/** The newest conversion of this vault not yet undone, or null. */
		last() {
			const found = findManifest(null);
			if (!found) return null;
			const { manifest } = found;
			return { id: manifest.id, time: manifest.time, notes: manifest.notes.filter((n) => n.status === 'written').length };
		},

		/** Undo a conversion (the newest when `id` is null). */
		async undo({ id = null, progress } = {}) {
			if (busy) throw new Error('A conversion is already running in this window');
			const found = findManifest(id);
			if (!found) throw new Error('There is no conversion of this vault to undo');
			if (found.manifest.undone) throw new Error(`That conversion was undone on ${found.manifest.undone}`);
			busy = true;
			try {
				const { manifest, dir } = found;
				const restored = [];
				const changed = [];
				const failed = [];
				const pace = pacer(progress);
				// Pass 1: which notes are still exactly as converted; their converted
				// text kept in history. Pass 2: the backup's bytes written back, each
				// note read once more just before.
				const jobs = [];
				for (let i = 0; i < manifest.notes.length; i++) {
					const n = manifest.notes[i];
					if (n.status !== 'written') continue;
					let disk;
					try { disk = vault.read(n.path); } catch { disk = null; }
					if (!disk || sha(disk) !== n.after) { changed.push(n.path); n.undo = 'changed'; continue; }
					vault.keepVersion(n.path, disk.toString('utf8'));
					jobs.push({ n, before: fs.readFileSync(path.join(dir, 'notes', n.path)) });
					await pace.step(i + 1, manifest.notes.length, 'check');
				}
				const writes = writeQueue();
				for (let i = 0; i < jobs.length; i++) {
					const { n, before } = jobs[i];
					let disk = null;
					try { disk = await vault.readAsync(n.path); } catch { /* gone */ }
					if (!disk || sha(disk) !== n.after) { changed.push(n.path); n.undo = 'changed'; continue; }
					n.undo = 'restored';
					restored.push(n.path);
					await writes.add(vault.write(n.path, before), () => {
						n.undo = 'failed';
						restored.splice(restored.indexOf(n.path), 1);
					}, n.path, failed);
					await pace.step(i + 1, jobs.length, 'write');
				}
				await writes.done();
				manifest.undone = new Date(now()).toISOString();
				writeManifest(found);
				const metrics = pace.metrics();
				log(`colon-undo: ${restored.length} restored, ${changed.length} changed since and left as they are, ${failed.length} failed — ${costOf(metrics)}`);
				return { id: manifest.id, restored, changed, failed, backup: dir, metrics };
			} finally { busy = false; }
		},
	};

	/** A conversion's manifest (`id`), or the newest not undone. */
	function findManifest(id) {
		if (!vault.root) return null;
		const base = path.join(backupRoot, backupFolderName(vault.root));
		let ids;
		try { ids = fs.readdirSync(base).sort().reverse(); } catch { return null; }
		for (const name of ids) {
			if (id && name !== id) continue;
			const dir = path.join(base, name);
			let manifest;
			try { manifest = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8')); } catch { continue; }
			if (!id && manifest.undone) continue;
			return { manifest, dir };
		}
		return null;
	}

	function writeManifest({ manifest, dir }) {
		fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, '\t'));
	}
}
