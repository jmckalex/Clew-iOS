// Lecture Timer — a countdown in a note (Features/App Gallery), with a
// progress ring and the lengths a lecture uses. When one runs out it chimes
// and appends a dated line to the note it sits in — "2026-10-04: ran a
// 15-minute exercise at 10:42" — through the note's own editor
// (`note.write`, the one thing it asks for), so ⌘Z takes it back like your
// own typing. It reads nothing of the note.
const $ = (id) => document.getElementById(id);
const PRESETS = [5, 10, 15, 50];
const R = 96;
const CIRC = 2 * Math.PI * R;

let total = 15 * 60 * 1000;   // ms
let remaining = total;
let endAt = null;             // running: when it ends
let ticker = null;

const pad = (n) => String(n).padStart(2, '0');
function clock(ms) {
	const s = Math.max(0, Math.ceil(ms / 1000));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${pad(m)}:${pad(s % 60)}`;
}

/** "15-minute", "3-second", "2.5-minute". */
function lengthWords(ms) {
	const s = Math.round(ms / 1000);
	if (s < 60) return `${s}-second`;
	if (s % 60 === 0) return `${s / 60}-minute`;
	return `${(s / 60).toFixed(1)}-minute`;
}

function draw() {
	const left = endAt ? endAt - Date.now() : remaining;
	$('time').textContent = clock(left);
	// The ring drains as time runs; finished, it is whole again, in green.
	const shown = document.body.classList.contains('finished') ? 1 : Math.max(0, left) / total;
	$('arc').style.strokeDashoffset = String(CIRC * (1 - shown));
	$('start').textContent = endAt ? 'Pause' : remaining < total && remaining > 0 ? 'Resume' : 'Start';
	for (const b of $('presets').children) b.setAttribute('aria-pressed', String(Number(b.dataset.min) * 60000 === total));
}

function setLength(ms) {
	stop();
	total = remaining = ms;
	document.body.classList.remove('finished');
	status(`${lengthWords(ms).replace('-', ' ')}s, ready.`);   // "15 minutes, ready."
	draw();
}

function stop() {
	clearInterval(ticker);
	ticker = null;
	if (endAt) remaining = Math.max(0, endAt - Date.now());
	endAt = null;
}

function start() {
	if (endAt) { stop(); draw(); status('Paused.'); return; }
	if (remaining <= 0) remaining = total;
	document.body.classList.remove('finished');
	endAt = Date.now() + remaining;
	ticker = setInterval(check, 200);
	status('Running…');
	draw();
}

function check() {
	draw();
	if (endAt && Date.now() >= endAt) finish();
}

function chime() {
	try {
		const audio = new AudioContext();
		for (const [i, f] of [[0, 880], [1, 1175]]) {
			const osc = audio.createOscillator();
			const gain = audio.createGain();
			osc.frequency.value = f;
			gain.gain.setValueAtTime(0.0001, audio.currentTime + i * 0.25);
			gain.gain.exponentialRampToValueAtTime(0.2, audio.currentTime + i * 0.25 + 0.02);
			gain.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + i * 0.25 + 0.6);
			osc.connect(gain).connect(audio.destination);
			osc.start(audio.currentTime + i * 0.25);
			osc.stop(audio.currentTime + i * 0.25 + 0.65);
		}
	} catch { /* no audio here: the ring says it */ }
}

async function finish() {
	stop();
	remaining = 0;
	document.body.classList.add('finished');
	draw();
	chime();
	const now = new Date();
	const line = `- ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}: ran a ${lengthWords(total)} exercise at ${pad(now.getHours())}:${pad(now.getMinutes())}`;
	if (!clew.can('note.write')) { status('Time! (Allow “edit this note” to log it there.)'); return; }
	try {
		await clew.notes.append(null, `${line}\n`);
		document.body.dataset.logged = line;
		status(`Time! Logged in the note: “${line.slice(2)}”.`);
	} catch (err) {
		status(`Time! Could not log it: ${err.message}`);
	}
}

function status(text) { $('status').textContent = text; }

async function main() {
	$('arc').style.strokeDasharray = String(CIRC);
	for (const m of PRESETS) {
		const b = document.createElement('button');
		b.type = 'button';
		b.dataset.min = String(m);
		b.textContent = `${m} min`;
		b.addEventListener('click', () => setLength(m * 60000));
		$('presets').append(b);
	}
	$('set').addEventListener('click', () => {
		const m = Number($('minutes').value);
		if (Number.isFinite(m) && m > 0) setLength(Math.round(m * 60000));
	});
	$('minutes').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('set').click(); });
	$('start').addEventListener('click', start);
	$('reset').addEventListener('click', () => setLength(total));
	document.addEventListener('visibilitychange', draw);
	draw();
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	status(clew.can('note.write') ? 'When it runs out, a line goes into this note.' : 'It will not log runs: “edit this note” was not allowed.');
}

main().catch((err) => status(`Lecture Timer: ${err.message}`));
