// Seminar Picker — a wheel of names in a note (Features/App Gallery). The
// names are the list under a heading with "Seminar" in it, in the note it
// sits in (`note.read`); who has had a turn is kept in its own corner of
// clewdata.json (`app.kv`), so the wheel only lands on someone who has not —
// until everyone has, and Reset starts a new round. "Copy name" puts the
// name on the clipboard through Clew (`clipboard`).
const $ = (id) => document.getElementById(id);
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const COLOURS = ['#6c5ce7', '#2f6fdb', '#d9480f', '#2b8a3e', '#c2255c', '#0c8599', '#e67700', '#5f3dc4'];

let names = [];
let picked = [];
let angle = 0;          // the wheel's rotation, radians
let spinning = false;
let current = null;

/** The bullet list under the first heading that mentions "seminar". */
function namesIn(text) {
	const lines = text.split('\n');
	const at = lines.findIndex((l) => /^#{1,6}\s.*seminar/i.test(l));
	if (at < 0) return [];
	const level = /^#+/.exec(lines[at])[0].length;
	const out = [];
	for (let i = at + 1; i < lines.length; i++) {
		const heading = /^(#{1,6})\s/.exec(lines[i]);
		if (heading && heading[1].length <= level) break;
		const item = /^\s*[-*+]\s+(.+?)\s*$/.exec(lines[i]);
		if (item && !/^\[[ xX]\]/.test(item[1])) out.push(item[1].replace(/[*_`]/g, ''));
	}
	return [...new Set(out)];
}

const remaining = () => names.filter((n) => !picked.includes(n));

function draw() {
	const canvas = $('wheel');
	const ctx = canvas.getContext('2d');
	const css = getComputedStyle(document.body);
	const W = canvas.width;
	const r = W / 2 - 6;
	ctx.clearRect(0, 0, W, W);
	ctx.save();
	ctx.translate(W / 2, W / 2);
	if (!names.length) {
		ctx.beginPath(); ctx.arc(0, 0, r, 0, 2 * Math.PI);
		ctx.strokeStyle = css.getPropertyValue('--line'); ctx.lineWidth = 4; ctx.stroke();
		ctx.restore();
		return;
	}
	const slice = (2 * Math.PI) / names.length;
	names.forEach((name, i) => {
		// Slice i spans [i·slice, (i+1)·slice) from the top, turned by `angle`.
		const a0 = angle + i * slice - Math.PI / 2;
		const done = picked.includes(name);
		ctx.beginPath();
		ctx.moveTo(0, 0);
		ctx.arc(0, 0, r, a0, a0 + slice);
		ctx.closePath();
		ctx.fillStyle = COLOURS[i % COLOURS.length];
		ctx.globalAlpha = done ? 0.25 : 1;
		ctx.fill();
		ctx.globalAlpha = 1;
		ctx.save();
		const mid = a0 + slice / 2;
		ctx.rotate(mid);
		// On the left half the text would read upside down: turn it round.
		const left = Math.cos(mid) < 0;
		if (left) ctx.rotate(Math.PI);
		ctx.fillStyle = done ? css.getPropertyValue('--muted') : '#fff';
		ctx.font = `600 ${names.length > 12 ? 22 : 28}px -apple-system, system-ui, sans-serif`;
		ctx.textAlign = left ? 'left' : 'right';
		ctx.textBaseline = 'middle';
		ctx.fillText(name.length > 14 ? `${name.slice(0, 13)}…` : name, left ? -(r - 18) : r - 18, 0);
		ctx.restore();
	});
	ctx.beginPath(); ctx.arc(0, 0, 22, 0, 2 * Math.PI);
	ctx.fillStyle = css.getPropertyValue('--card'); ctx.fill();
	ctx.restore();
}

/** The angle that puts slice i's middle under the pointer at the top. */
function angleFor(i) {
	const slice = (2 * Math.PI) / names.length;
	const jitter = (Math.random() - 0.5) * slice * 0.6;
	return -(i * slice + slice / 2) + jitter;
}

function settle() {
	spinning = false;
	$('name').textContent = current;
	document.body.dataset.picked = current;
	controls();
	status(remaining().length ? `${remaining().length} still to have a turn.` : 'Everyone has had a turn — Reset turns for a new round.');
}

async function spin() {
	const left = remaining();
	if (!left.length || spinning) return;
	current = left[Math.floor(Math.random() * left.length)];
	picked.push(current);
	if (clew.can('app.kv')) await clew.kv.set('picked', picked);
	const target = angleFor(names.indexOf(current));
	const from = angle;
	// Whole turns forward, then the slice: always clockwise, never a jump back.
	const base = from - (from % (2 * Math.PI));
	const to = base + 5 * 2 * Math.PI + ((target % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
	spinning = true;
	controls();
	$('name').textContent = '';
	if (reduceMotion.matches) { angle = to; draw(); settle(); return; }
	const t0 = performance.now();
	const T = 3600;
	const step = (now) => {
		const p = Math.min(1, (now - t0) / T);
		angle = from + (to - from) * (1 - (1 - p) ** 3);
		draw();
		if (p < 1) requestAnimationFrame(step); else settle();
	};
	requestAnimationFrame(step);
}

function controls() {
	$('spin').disabled = spinning || !remaining().length;
	$('copy').disabled = spinning || !current || !clew.can('clipboard');
	$('reset').disabled = spinning || !picked.length;
}

function status(text) { $('status').textContent = text; }

async function readNames() {
	names = namesIn(await clew.notes.read());
	picked = picked.filter((n) => names.includes(n));
	draw();
	controls();
	if (!names.length) status('Write the names as a list under a heading with “Seminar” in it.');
	else if (!spinning) status(`${remaining().length} of ${names.length} still to have a turn.`);
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; draw(); });
	if (!clew.can('note.read')) { status('Allow “read this note” to see the names.'); return; }
	if (clew.can('app.kv')) picked = (await clew.kv.get('picked')) ?? [];
	await readNames();
	clew.on('note-changed', () => readNames().catch(() => {}));
	$('spin').addEventListener('click', spin);
	$('reset').addEventListener('click', async () => {
		picked = [];
		current = null;
		$('name').textContent = '';
		if (clew.can('app.kv')) await clew.kv.set('picked', picked);
		draw();
		controls();
		status(`A new round: all ${names.length} to have a turn.`);
	});
	$('copy').addEventListener('click', async () => {
		if (!current) return;
		try {
			await clew.clipboard.copy(current);
			document.body.dataset.copied = current;
			status(`Copied “${current}”.`);
		} catch (err) {
			status(`Could not copy: ${err.message}`);
		}
	});
}

main().catch((err) => status(`Seminar Picker: ${err.message}`));
