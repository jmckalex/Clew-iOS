// The iPad's answer when a note was changed in two places (conflicts.js):
// Keep Mine, Keep Theirs, Keep Both, and Compare. Both versions are already
// in .clew/history when this opens, so whatever is chosen, nothing is lost.
//
// A refused save (another device's version under the editor) opens it at
// once, and so does the shared editor's own case: unsaved edits when a
// different version arrives. That banner's "Load disk version" would drop
// the unsaved text, so it is kept in history first and offered here.
// iCloud's conflict versions and Dropbox's conflicted copies found in the
// vault are reviewed after a moment; git markers get a notice (they live in
// the note's own text). The palette's "Review conflicting versions…"
// reopens anything outstanding.
import { registerCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { lineDiff, conflictSiblingPath } from '../../vendor/clew/shared/conflict-text.js';

const shim = () => window.__clewShim;
const app = () => window.__clew;
const tell = (text, ms = 8000) => import('../../vendor/clew/renderer/plugins.js').then(({ notice }) => notice(text, ms));
const nameOf = (rel) => rel.split('/').pop().replace(/\.(md|jmd)$/i, '');

const queue = [];
let showing = false;

/** A modal sheet fitted to the visual viewport (the keyboard may be up). */
function sheet(label) {
	const backdrop = document.createElement('div');
	backdrop.className = 'clew-conflict-backdrop';
	const box = document.createElement('div');
	box.className = 'clew-conflict-sheet';
	box.setAttribute('role', 'dialog');
	box.setAttribute('aria-modal', 'true');
	box.setAttribute('aria-label', label);
	backdrop.append(box);
	const fit = () => {
		const vv = window.visualViewport;
		backdrop.style.top = `${Math.round(vv ? vv.offsetTop : 0)}px`;
		backdrop.style.height = `${Math.round(vv ? vv.height : innerHeight)}px`;
		box.style.maxHeight = `${Math.max(200, Math.round((vv ? vv.height : innerHeight) - 32))}px`;
	};
	window.visualViewport?.addEventListener('resize', fit);
	document.body.append(backdrop);
	fit();
	const close = () => { window.visualViewport?.removeEventListener('resize', fit); backdrop.remove(); };
	return { box, close };
}

const button = (text, cls, onClick) => {
	const b = document.createElement('button');
	b.type = 'button';
	b.className = `clew-conflict-button ${cls}`.trim();
	b.textContent = text;
	b.addEventListener('click', onClick);
	return b;
};

/** The compare view: this iPad's lines (−) against the other's (+). */
function compareView(mine, theirs) {
	const wrap = document.createElement('div');
	wrap.className = 'clew-conflict-compare';
	const legend = document.createElement('div');
	legend.className = 'clew-conflict-legend';
	legend.innerHTML = '<span class="is-mine">− only in mine</span> <span class="is-theirs">+ only in theirs</span>';
	const pre = document.createElement('pre');
	const diff = lineDiff(mine, theirs);
	if (!diff) {
		pre.textContent = `MINE\n${mine}\n\nTHEIRS\n${theirs}`;
	} else {
		// Long runs of unchanged lines fold to their edges.
		const keep = new Set();
		diff.forEach((d, i) => { if (d.op !== ' ') for (let k = i - 2; k <= i + 2; k++) keep.add(k); });
		let skipped = 0;
		diff.forEach((d, i) => {
			if (d.op === ' ' && !keep.has(i)) { skipped++; return; }
			if (skipped) { const s = document.createElement('div'); s.className = 'is-skip'; s.textContent = `⋯ ${skipped} unchanged line${skipped === 1 ? '' : 's'}`; pre.append(s); skipped = 0; }
			const line = document.createElement('div');
			line.className = d.op === '-' ? 'is-mine' : d.op === '+' ? 'is-theirs' : 'is-same';
			line.textContent = `${d.op} ${d.text}`;
			pre.append(line);
		});
		if (skipped) { const s = document.createElement('div'); s.className = 'is-skip'; s.textContent = `⋯ ${skipped} unchanged`; pre.append(s); }
		if (!diff.some((d) => d.op !== ' ')) pre.textContent = 'The two versions are identical.';
	}
	wrap.append(legend, pre);
	return wrap;
}

/**
 * Show one conflict: { rel, kind, intro, mine, theirs, resolve(choice) }.
 * resolve returns a sibling path for 'both', true otherwise, or throws.
 */
function present(item) {
	showing = true;
	const { box, close } = sheet(`Conflicting versions of ${nameOf(item.rel)}`);
	const title = document.createElement('h2');
	title.className = 'clew-conflict-title';
	title.textContent = `“${nameOf(item.rel)}” was changed in two places`;
	const intro = document.createElement('p');
	intro.className = 'clew-conflict-intro';
	intro.textContent = `${item.intro} Both versions are saved in the note’s history, whatever you choose.`;
	const status = document.createElement('p');
	status.className = 'clew-conflict-status';
	status.setAttribute('aria-live', 'polite');
	const area = document.createElement('div');
	const choose = (choice) => async () => {
		for (const b of box.querySelectorAll('button')) b.disabled = true;
		status.textContent = 'Saving…';
		try {
			const result = await item.resolve(choice);
			close();
			showing = false;
			tell(choice === 'both' && typeof result === 'string'
				? `Kept both: the other version is now “${result.split('/').pop()}”.`
				: choice === 'theirs' ? `Kept the other version of “${nameOf(item.rel)}”.` : `Kept your version of “${nameOf(item.rel)}”.`);
			next();
		} catch (err) {
			status.textContent = `Couldn’t resolve it: ${String(err?.message ?? err)}`;
			for (const b of box.querySelectorAll('button')) b.disabled = false;
		}
	};
	const compare = button('Compare', 'is-plain', () => {
		area.replaceChildren(area.childElementCount ? '' : compareView(item.mine ?? '', item.theirs ?? ''));
		compare.textContent = area.childElementCount ? 'Hide Comparison' : 'Compare';
	});
	const row = document.createElement('div');
	row.className = 'clew-conflict-actions';
	row.append(
		button('Keep Mine', 'is-default', choose('mine')),
		button('Keep Theirs', '', choose('theirs')),
		button('Keep Both', '', choose('both')),
		compare,
	);
	if (item.later) row.append(button('Later', 'is-plain', () => { close(); showing = false; item.deferred = true; queue.push(item); setTimeout(next, 0); }));
	box.append(title, intro, row, area, status);
}

function next() {
	if (showing) return;
	const item = queue.findIndex((q) => !q.deferred);
	if (item < 0) return;
	present(queue.splice(item, 1)[0]);
}

function enqueue(item, { now = false } = {}) {
	if (queue.some((q) => q.key === item.key)) return;
	if (now) queue.unshift(item); else queue.push(item);
	next();
}

// ---- the sources ------------------------------------------------------------

const center = shim()?.conflicts;
center?.on((event) => {
	const { rel } = event;
	if (event.kind === 'save') {
		enqueue({
			key: `save:${rel}`, rel,
			intro: 'Another device changed it after this iPad last saw it, and you edited it here too: your edit was not written over theirs.',
			mine: event.mine, theirs: event.theirs,
			resolve: (choice) => center.resolve(rel, choice),
		}, { now: true });
	} else if (event.kind === 'cloud') {
		center.cloudVersions(rel).then(({ current, versions }) => {
			const other = versions[0];
			if (!other) return;
			const when = other.modifiedMs ? new Date(other.modifiedMs).toLocaleString() : 'earlier';
			enqueue({
				key: `cloud:${rel}`, rel, later: true,
				intro: `iCloud kept a version from ${other.from} (${when}) alongside the one here.`,
				mine: current, theirs: other.text,
				resolve: (choice) => center.resolveCloud(rel, choice, 0),
			});
		}).catch((err) => console.warn('[clew-ios] iCloud versions:', err));
	} else if (event.kind === 'dropbox') {
		const read = (p) => app()?.ipc.invoke('clew:note-read', { path: p }).then((t) => String(t?.content ?? t));
		Promise.all([read(event.base), read(event.copy)]).then(([mine, theirs]) => enqueue({
			key: `dropbox:${event.copy}`, rel: event.base, later: true,
			intro: `Dropbox kept ${event.who}’s version beside it as “${event.copy.split('/').pop()}”.`,
			mine, theirs,
			resolve: (choice) => center.resolveDropbox(event, choice),
		})).catch((err) => console.warn('[clew-ios] Dropbox copy:', err));
	} else if (event.kind === 'git') {
		tell(`“${nameOf(rel)}” contains git conflict markers (<<<<<<< ======= >>>>>>>): edit it to keep the lines you want.`, 12000);
	}
});

// The shared editor's own case: unsaved edits when a different version
// arrives. Its banner stays; this keeps the unsaved text safe first and
// offers the same choices.
app()?.editorPool?.on?.('conflict-changed', ({ tabId, active }) => {
	if (!active) return;
	const entry = app().editorPool.get(tabId);
	if (!entry?.view || entry.conflict == null) return;
	const rel = entry.path;
	const mine = entry.view.state.doc.toString();
	const theirs = entry.conflict;
	center?.keepVersion(rel, theirs);
	center?.keepVersion(rel, mine);
	enqueue({
		key: `editor:${tabId}`, rel,
		intro: 'It changed on disk while you had unsaved edits here.',
		mine, theirs,
		resolve: async (choice) => {
			const pool = app().editorPool;
			let sibling = true;
			if (choice === 'both') {
				const tree = new Set(await app().ipc.invoke('clew:vault-tree').then(function flat(nodes, acc = []) {
					for (const n of nodes ?? []) { acc.push(n.path); if (n.children) flat(n.children, acc); }
					return acc;
				}));
				sibling = conflictSiblingPath(rel, (p) => tree.has(p));
				await app().ipc.invoke('clew:note-write', { path: sibling, content: theirs });
			}
			await pool.resolveConflict(tabId, choice === 'theirs' ? 'reload' : 'keep');
			return sibling;
		},
	}, { now: true });
});

registerCommand({
	id: 'vault:review-conflicts',
	name: 'Review conflicting versions…',
	run: () => {
		for (const q of queue) q.deferred = false;
		if (!queue.length) tell('No conflicting versions to review.', 3000);
		next();
	},
});
