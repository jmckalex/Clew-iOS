// Writing Progress — a word count in a note (Features/App Gallery) that
// follows you as you write. It counts the words of the note it sits in
// (`note.read`) and counts again each time the note is saved (the
// `note-changed` event), keeping the history and your daily goal in its own
// corner of clewdata.json (`app.kv`): the line is the count over time, the
// dashed one where today's goal would take it.
const $ = (id) => document.getElementById(id);
const MAX_SAMPLES = 500;

let history = [];   // [{ t, w }], oldest first
let goal = 250;
let events = 0;

/** Words of prose: no header, no code, no embeds. */
function countWords(text) {
	const body = text
		.replace(/^---\n[\s\S]*?\n---\n/, '')
		.replace(/^```[\s\S]*?^```/gm, '')
		.replace(/^@\w+\+?\[.*$/gm, '')
		.replace(/!\[\[[^\]]*\]\]/g, '');
	return body.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu)?.length ?? 0;
}

const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); };

/** Where today started: the last count from before midnight, else today's first. */
function todayBase() {
	const m = midnight();
	const before = history.filter((s) => s.t < m);
	return (before.at(-1) ?? history.find((s) => s.t >= m))?.w ?? 0;
}

function draw() {
	const now = history.at(-1)?.w ?? 0;
	const added = now - todayBase();
	$('words').textContent = now.toLocaleString();
	$('today').textContent = `today ${added >= 0 ? '+' : '−'}${Math.abs(added).toLocaleString()} of ${goal.toLocaleString()}`;
	$('goal').textContent = goal.toLocaleString();
	$('fill').style.width = `${Math.max(0, Math.min(100, (added / goal) * 100))}%`;
	document.body.classList.toggle('met', added >= goal);
	const shown = history.slice(-60);
	const target = todayBase() + goal;
	const lo = Math.min(...shown.map((s) => s.w), target) * 0.98;
	const hi = Math.max(...shown.map((s) => s.w), target) * 1.02 || 1;
	const y = (w) => 38 - ((w - lo) / (hi - lo || 1)) * 36;
	const pts = shown.length === 1 ? [[0, shown[0].w], [100, shown[0].w]] : shown.map((s, i) => [(i / (shown.length - 1)) * 100, s.w]);
	$('spark').setAttribute('points', pts.map(([x, w]) => `${x.toFixed(2)},${y(w).toFixed(2)}`).join(' '));
	$('target').setAttribute('y1', y(target).toFixed(2));
	$('target').setAttribute('y2', y(target).toFixed(2));
	document.body.dataset.words = String(now);
	document.body.dataset.events = String(events);
}

async function count() {
	const w = countWords(await clew.notes.read());
	if (history.at(-1)?.w !== w) {
		history.push({ t: Date.now(), w });
		history = history.slice(-MAX_SAMPLES);
		if (clew.can('app.kv')) await clew.kv.set('history', history);
	}
	draw();
}

async function setGoal(next) {
	goal = Math.max(50, Math.min(5000, next));
	if (clew.can('app.kv')) await clew.kv.set('goal', goal);
	draw();
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	if (!clew.can('note.read')) { $('status').textContent = 'Allow “read this note” to count its words.'; return; }
	if (clew.can('app.kv')) {
		history = (await clew.kv.get('history')) ?? [];
		goal = (await clew.kv.get('goal')) ?? goal;
	}
	await count();
	$('status').textContent = '';
	// Saved — by you, an app, or another device: count again.
	clew.on('note-changed', () => { events++; count().catch(() => {}); });
	$('less').addEventListener('click', () => setGoal(goal - 50));
	$('more').addEventListener('click', () => setGoal(goal + 50));
}

main().catch((err) => { $('status').textContent = `Writing Progress: ${err.message}`; });
