// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// "Convert this vault" — the colon directives' retirement, phase 2, the
// window's half: the sheet. Never automatic: the command runs a dry run
// (main/colon-conversion.js), the sheet shows it, and nothing is written until
// the user says Convert.
//
// The sheet's groups: what converts with the SAME output (counted, listed per
// note); the OUTPUT CHANGES (the theorem family, figure, a generic block's
// label …), each unticked with its why and the @ form it would get; what NEEDS
// YOU — in a note that loads directives, everything, each with "Convert
// anyway" where the converter could; elsewhere what the converter leaves, with
// its reason. The default, Convert with nothing ticked, is "all but the output
// changes". A note the user has open in an editor is changed there, as a
// transaction (undo, the dirty dot, a guarded save); main writes the rest. The
// result offers Undo, and "Review them" for notes that changed since the dry
// run — written by nobody, planned again.
import { ipc, CH } from './ipc.js';
import { editorPool } from './editor/pool.js';
import { editorFor } from './editor/note-edit.js';
import { minimalChange } from './editor/minimal-change.js';
import { vaultStore } from './state/vault-store.js';
import { notice } from './plugins.js';

const h = (tag, cls, text) => {
	const e = document.createElement(tag);
	if (cls) e.className = cls;
	if (text != null) e.textContent = text;
	return e;
};
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const errorText = (err) => String(err?.message ?? err).replace(/^Error invoking remote method '[^']*': (Error: )?/, '');

let running = false;
// A group listing more notes than this starts folded (see noteList).
const OPEN_LIMIT = 200;

/** The modal: a title, a scrolling body, buttons. */
function openSheet(title) {
	document.querySelector('.clew-colon-sheet')?.remove();
	const sheet = h('div', 'clew-colon-sheet');
	const card = h('div', 'clew-colon-card');
	card.setAttribute('role', 'dialog');
	card.setAttribute('aria-label', title);
	card.tabIndex = -1;
	const heading = h('h2', null, title);
	const body = h('div', 'clew-colon-body');
	const buttons = h('div', 'clew-colon-buttons');
	card.append(heading, body, buttons);
	sheet.append(card);
	document.body.append(sheet);
	// The question has the focus, never a button: Convert must not be what a
	// stray Space or Enter answers.
	card.focus();
	let escape = null;
	const onKey = (e) => { if (e.key === 'Escape' && escape) { e.stopPropagation(); e.preventDefault(); escape(); } };
	window.addEventListener('keydown', onKey, true);
	return {
		card,
		state(s) { sheet.dataset.state = s; },
		body(...nodes) { body.replaceChildren(...nodes); body.scrollTop = 0; },
		progress(text, fraction = null) {
			const bar = h('div', 'clew-colon-progress');
			const fill = h('div', 'clew-colon-progress-fill');
			if (fraction != null) fill.style.width = `${Math.round(fraction * 100)}%`;
			else bar.classList.add('is-indeterminate');
			bar.append(fill);
			body.replaceChildren(h('p', null, text), bar);
			buttons.replaceChildren();
			escape = null;
		},
		/** Show the buttons and resolve with the id of the one pressed; Esc is
		 *  `cancel` (when there is a cancel). */
		choose(choices) {
			return new Promise((resolve) => {
				buttons.replaceChildren();
				for (const c of choices) {
					const b = h('button', c.primary ? 'is-primary' : null, c.label);
					b.dataset.colonAction = c.id;
					if (c.disabled) b.disabled = true;
					c.bind?.(b);
					b.addEventListener('click', () => { escape = null; resolve(c.id); });
					buttons.append(b);
				}
				const cancel = choices.find((c) => c.id === 'cancel' || c.id === 'done');
				escape = cancel ? () => { escape = null; resolve(cancel.id); } : null;
			});
		},
		close() {
			window.removeEventListener('keydown', onKey, true);
			sheet.remove();
		},
	};
}

/** A note's rows, built only when its fold is opened (a vault can have
 *  thousands). */
function noteFold(path, count, build) {
	const fold = h('details', 'clew-colon-note');
	fold.dataset.path = path;
	const summary = h('summary');
	summary.append(h('span', 'clew-colon-path', path), h('span', 'clew-colon-count', count));
	fold.append(summary);
	let built = false;
	fold.addEventListener('toggle', () => {
		if (!fold.open || built) return;
		built = true;
		fold.append(...build());
	});
	return fold;
}

/** One directive: `from` → `to`, or `from` alone. */
function itemLine(item) {
	const line = h('div', 'clew-colon-item');
	line.append(h('code', null, item.from));
	if (item.to !== undefined) line.append(h('span', 'clew-colon-arrow', ' → '), h('code', null, item.to));
	return line;
}

/**
 * The dry run, shown. Resolves with { picks } on Convert, or null.
 * @param {ReturnType<typeof openSheet>} sheet
 */
async function review(sheet, report, { again = false } = {}) {
	sheet.state('ready');
	const { totals, notes } = report;
	if (!notes.length) {
		sheet.body(
			h('p', null, `No colon directives in ${report.vault}: ${plural(report.scanned, 'note')} looked at, nothing to convert.`),
		);
		await sheet.choose([{ id: 'done', label: 'Done', primary: true }]);
		return null;
	}
	// Ticks by note and line: a row is a line, because the converter's `keep`
	// works by line.
	const picks = new Map();
	const isPicked = (path, line) => picks.get(path)?.has(line) ?? false;
	const setPicked = (path, line, on) => {
		if (!picks.has(path)) picks.set(path, new Set());
		picks.get(path)[on ? 'add' : 'delete'](line);
	};
	const rowItems = (row) => row.items.filter((i) => i.to !== undefined).length;
	const usable = notes.filter((n) => !n.refuse);
	let update = () => {};
	// A group's notes are added a few milliseconds' worth per frame: 5,000
	// notes' folds at once held the window for a quarter of a second
	// (measured, smoke/colon-convert-scenario.js).
	// A group of more than OPEN_LIMIT notes starts folded, and is built when
	// opened: every frame lays out the whole list, so thousands of folds made
	// each frame ~40 ms however few were added.
	const queue = [];
	let draining = false;
	const drain = () => {
		const t0 = performance.now();
		while (queue.length && performance.now() - t0 < 6) queue.shift()();
		draining = queue.length > 0;
		if (draining) requestAnimationFrame(drain);
	};
	const noteList = (count, folds) => {
		const list = h('details', 'clew-colon-list');
		list.append(h('summary', null, plural(count, 'note')));
		let filled = false;
		const fill = () => {
			if (filled) return;
			filled = true;
			for (const fold of folds) queue.push(() => list.append(fold()));
			if (!draining) drain();
		};
		if (count <= OPEN_LIMIT) { list.open = true; fill(); }
		else list.addEventListener('toggle', () => { if (list.open) fill(); });
		return list;
	};

	const rowView = (note, row) => {
		const el = h('div', `clew-colon-row is-${row.kind}`);
		el.dataset.colonRow = '';
		el.dataset.path = note.path;
		el.dataset.line = String(row.line);
		const head = h('div', 'clew-colon-row-head');
		if (row.choice && !note.refuse) {
			const label = h('label', 'clew-colon-pick');
			const box = h('input');
			box.type = 'checkbox';
			box.dataset.colonPick = '';
			box.checked = isPicked(note.path, row.line);
			box.addEventListener('change', () => { setPicked(note.path, row.line, box.checked); update(); });
			label.append(box, document.createTextNode(row.kind === 'changes-output' ? ' Convert' : ' Convert anyway'));
			head.append(label);
		} else head.append(h('span', 'clew-colon-left', 'Left as written'));
		head.append(h('span', 'clew-colon-line', `line ${row.line}`));
		el.append(head, ...row.items.map(itemLine), h('div', 'clew-colon-why', row.why));
		return el;
	};

	/** A group of rows, by note, with a box that ticks every row in it. */
	/** `explain(count)`: the group's line, agreeing with its count of rows. */
	const rowGroup = (key, title, explain, pick) => {
		const members = usable.map((n) => ({ note: n, rows: n.rows.filter((r) => pick(r, n)) })).filter((m) => m.rows.length);
		if (!members.length) return null;
		const section = h('section', 'clew-colon-group');
		section.dataset.group = key;
		const count = members.reduce((s, m) => s + m.rows.length, 0);
		const head = h('div', 'clew-colon-group-head');
		head.append(h('h3', null, `${title} (${count.toLocaleString()})`));
		const choosable = members.flatMap((m) => m.rows.filter((r) => r.choice).map((r) => [m.note.path, r.line]));
		if (choosable.length) {
			const label = h('label', 'clew-colon-pick-all');
			const all = h('input');
			all.type = 'checkbox';
			all.dataset.colonPickAll = key;
			all.addEventListener('change', () => {
				for (const [path, line] of choosable) setPicked(path, line, all.checked);
				for (const box of section.querySelectorAll('input[data-colon-pick]')) box.checked = all.checked;
				update();
			});
			label.append(all, document.createTextNode(choosable.length === 1 ? ' this one' : ' all of these'));
			head.append(label);
		}
		section.append(head, h('p', 'clew-colon-explain', explain(count)),
			noteList(members.length, members.map(({ note, rows }) => () => noteFold(note.path, plural(rows.length, 'item'), () => rows.map((r) => rowView(note, r))))));
		return section;
	};

	const summary = h('p', 'clew-colon-summary');
	summary.textContent = again
		? `${plural(totals.notes, 'note')} changed after the dry run, planned again from what ${totals.notes === 1 ? 'it holds' : 'they hold'} now. Nothing in ${totals.notes === 1 ? 'it' : 'them'} has been changed.`
		: `${plural(report.scanned, 'note')} looked at; ${plural(totals.notes, 'note')} ${totals.notes === 1 ? 'uses' : 'use'} colon directives. Nothing has been changed yet.`;
	const intro = h('p', 'clew-colon-explain', 'jmarkdown is retiring the colon directives (:::name … :::, ::name[…], :name[…]) for the @ forms. This converts them. Every note changed is copied first, and kept in its history; Undo puts back every note still as it was converted.');

	const same = usable.filter((n) => n.autoItems);
	const sameGroup = same.length ? (() => {
		const section = h('section', 'clew-colon-group');
		section.dataset.group = 'same';
		section.append(h('h3', null, `Same output (${totals.auto.toLocaleString()})`),
			h('p', 'clew-colon-explain', `${plural(totals.auto, 'directive')} in ${plural(same.length, 'note')} ${totals.auto === 1 ? 'renders' : 'render'} exactly as before once converted. ${totals.auto === 1 ? 'It is' : 'These are'} converted.`));
		section.append(noteList(same.length, same.map((n) => () => noteFold(n.path, plural(n.autoItems, 'directive'), () => n.auto.map((i) => {
			const row = itemLine(i);
			row.prepend(h('span', 'clew-colon-line', `line ${i.line} `));
			return row;
		})))));
		return section;
	})() : null;

	const loading = usable.filter((n) => n.loads).length;
	const groups = [
		sameGroup,
		rowGroup('output', 'Output changes',
			(n) => `Converted, ${n === 1 ? 'this renders' : 'these render'} differently — a theorem or a figure numbered, a block's label kept. Left unticked, ${n === 1 ? 'it stays as it is' : 'they stay as they are'} written.`,
			(r) => r.kind === 'changes-output'),
		rowGroup('loads', 'Notes that load directives',
			() => `${plural(loading, 'note')} ${loading === 1 ? 'loads' : 'load'} directives of ${loading === 1 ? 'its' : 'their'} own (a header, a folder's or your global .jmarkdown/config.json), which may define any name ${loading === 1 ? 'it uses' : 'they use'}. Nothing in ${loading === 1 ? 'it' : 'them'} is converted unless you tick it.`,
			(r, n) => !!n.loads),
		rowGroup('left', 'Left as written',
			(n) => `The converter cannot write ${n === 1 ? 'this' : 'these'} faithfully. Change ${n === 1 ? 'it' : 'them'} by hand if you want the @ form.`,
			(r, n) => r.kind === 'needs-you' && !n.loads),
	].filter(Boolean);
	const refused = notes.filter((n) => n.refuse);
	if (refused.length) {
		const section = h('section', 'clew-colon-group');
		section.dataset.group = 'refused';
		section.append(h('h3', null, `Notes not converted (${refused.length})`));
		for (const n of refused) section.append(h('div', 'clew-colon-why', `${n.path} — ${n.refuse}`));
		groups.push(section);
	}
	sheet.body(intro, summary, ...groups);

	const rowAt = new Map(usable.flatMap((n) => n.rows.map((r) => [`${n.path}\n${r.line}`, r])));
	const picked = () => [...picks].reduce((s, [path, lines]) =>
		s + [...lines].reduce((t, line) => t + rowItems(rowAt.get(`${path}\n${line}`)), 0), 0);
	let convertButton = null;
	update = () => {
		if (!convertButton) return;
		const chosen = picked();
		const n = totals.auto + chosen;
		convertButton.disabled = n === 0;
		convertButton.textContent = n === 0 ? 'Nothing to convert'
			: chosen === 0 ? `Convert all but the output changes (${n.toLocaleString()})`
			: `Convert ${plural(n, 'directive')}`;
	};
	const choice = await sheet.choose([
		{ id: 'cancel', label: 'Cancel' },
		{ id: 'convert', label: 'Convert', primary: true, bind: (b) => { convertButton = b; update(); } },
	]);
	if (choice !== 'convert') return null;
	const out = {};
	for (const [path, lines] of picks) if (lines.size) out[path] = [...lines];
	return { picks: out };
}

/** The notes main handed back because an editor has them open: changed
 *  there, as the user's own edit, and saved. Returns those it changed. */
async function applyInEditors(plans) {
	const applied = [];
	for (const { path, before, after } of plans) {
		const entry = editorFor(path);
		if (!entry || entry.conflict || entry.view.state.doc.toString() !== before) continue;
		const tabId = editorPool.tabsFor(path).find((id) => editorPool.get(id) === entry);
		const change = minimalChange(before, after);
		if (change) entry.view.dispatch({ changes: change, userEvent: 'input.convert' });
		await editorPool.saveNow(tabId);
		if (!entry.dirty && !entry.conflict) applied.push(path);
	}
	return applied;
}

/** A note main wrote that a tab still shows (a reading tab's pooled editor):
 *  read it again now, whatever the watcher manages. */
function reloadShown(paths) {
	for (const path of paths) if (editorPool.tabsFor(path).length) editorPool.externalChange(path);
}

async function runUndo(sheet, id) {
	sheet.state('undoing');
	sheet.progress('Putting the notes back…');
	await editorPool.saveAll();
	const off = ipc.on(CH.EV_COLON_PROGRESS, ({ done, total }) => sheet.progress(`Putting the notes back… ${done.toLocaleString()} of ${total.toLocaleString()}`, total ? done / total : null));
	let result;
	try { result = await ipc.invoke(CH.COLON_UNDO, { id }); } finally { off(); }
	reloadShown(result.restored);
	sheet.state('undone');
	const nodes = [h('p', 'clew-colon-summary', `Put back ${plural(result.restored.length, 'note')} as ${result.restored.length === 1 ? 'it was' : 'they were'} before the conversion.`)];
	if (result.changed.length) {
		nodes.push(h('p', null, `${plural(result.changed.length, 'note')} changed since the conversion and ${result.changed.length === 1 ? 'was' : 'were'} left as ${result.changed.length === 1 ? 'it is' : 'they are'} (the copy from before is in ${result.backup}):`));
		for (const p of result.changed) nodes.push(h('div', 'clew-colon-why', p));
	}
	sheet.body(...nodes);
	await sheet.choose([{ id: 'done', label: 'Done', primary: true }]);
}

/** Review, convert, and say what happened — again for notes that changed
 *  under the dry run. */
async function reviewAndConvert(sheet, report) {
	for (let again = false; ; again = true) {
		const chosen = await review(sheet, report, { again });
		if (!chosen) return;
		sheet.state('converting');
		sheet.progress('Converting…');
		const editing = report.notes.map((n) => n.path).filter((p) => editorFor(p));
		const off = ipc.on(CH.EV_COLON_PROGRESS, ({ done, total, phase }) => sheet.progress(`${phase === 'write' ? 'Writing the notes' : 'Backing up the notes'}… ${done.toLocaleString()} of ${total.toLocaleString()}`, total ? done / total : null));
		let result;
		try { result = await ipc.invoke(CH.COLON_APPLY, { scanId: report.scanId, picks: chosen.picks, editing }); } finally { off(); }
		const applied = result.editorPlans.length ? await applyInEditors(result.editorPlans) : [];
		const finished = result.id && result.editorPlans.length ? await ipc.invoke(CH.COLON_FINISH, { id: result.id, applied }) : null;
		reloadShown(result.written ?? []);
		const notesDone = finished ? finished.notes : result.notes;
		const itemsDone = finished ? finished.items : result.items;
		const skippedInEditor = result.editorPlans.length - applied.length;
		sheet.state('done');
		const nodes = [h('p', 'clew-colon-summary', notesDone
			? `Converted ${plural(itemsDone, 'directive')} in ${plural(notesDone, 'note')}.`
			: 'Nothing was converted.')];
		if (result.backup) nodes.push(h('p', 'clew-colon-explain', `Each note was copied first, into ${result.backup}, and kept in its history.`));
		if (skippedInEditor) nodes.push(h('p', null, `${plural(skippedInEditor, 'note')} open in an editor changed after the dry run and ${skippedInEditor === 1 ? 'was' : 'were'} left alone. Convert again to see ${skippedInEditor === 1 ? 'it' : 'them'}.`));
		if (result.changed.length) nodes.push(h('p', null, `${plural(result.changed.length, 'note')} changed after the dry run, so ${result.changed.length === 1 ? 'it was' : 'they were'} not touched.`));
		for (const f of result.failed) nodes.push(h('div', 'clew-colon-why', `${f.path} — not converted: ${f.why}`));
		sheet.body(...nodes);
		const choices = [];
		if (result.again?.notes.length) choices.push({ id: 'again', label: `Review ${result.again.notes.length === 1 ? 'it' : 'them'}` });
		if (result.id && notesDone) choices.push({ id: 'undo', label: 'Undo' });
		choices.push({ id: 'done', label: 'Done', primary: true });
		const next = await sheet.choose(choices);
		if (next === 'undo') return runUndo(sheet, result.id);
		if (next !== 'again') return;
		report = result.again;
	}
}

/** The command: a dry run of the whole vault, then the sheet. */
export async function convertVault() {
	if (running || !vaultStore.vault) return;
	running = true;
	let sheet = null;
	try {
		await editorPool.saveAll();
		sheet = openSheet('Convert colon directives');
		sheet.state('scanning');
		sheet.progress('Looking through the vault…');
		const off = ipc.on(CH.EV_COLON_PROGRESS, ({ done, total }) => sheet.progress(`Looking through the vault… ${done.toLocaleString()} of ${total.toLocaleString()} notes`, total ? done / total : null));
		let report;
		try { report = await ipc.invoke(CH.COLON_SCAN); } finally { off(); }
		await reviewAndConvert(sheet, report);
	} catch (err) {
		console.error('Colon conversion failed:', err);
		notice(`Converting colon directives failed: ${errorText(err)}`, 8000);
	} finally {
		sheet?.close();
		running = false;
	}
}

/** The command: undo the newest conversion of this vault. */
export async function undoConversion() {
	if (running || !vaultStore.vault) return;
	running = true;
	let sheet = null;
	try {
		const last = await ipc.invoke(CH.COLON_LAST);
		if (!last) { notice('This vault has no colon conversion to undo'); return; }
		sheet = openSheet('Undo the colon conversion');
		sheet.state('confirm');
		sheet.body(h('p', null, `Put back the ${plural(last.notes, 'note')} converted on ${new Date(last.time).toLocaleString()}? A note changed since then is left as it is.`));
		const choice = await sheet.choose([{ id: 'cancel', label: 'Cancel' }, { id: 'undo', label: 'Undo', primary: true }]);
		if (choice === 'undo') await runUndo(sheet, last.id);
	} catch (err) {
		console.error('Undoing the colon conversion failed:', err);
		notice(`Undoing the colon conversion failed: ${errorText(err)}`, 8000);
	} finally {
		sheet?.close();
		running = false;
	}
}
