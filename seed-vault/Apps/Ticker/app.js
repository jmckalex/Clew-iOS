// Stock Ticker — a ticker-tape band in a note (Features/App Gallery). The
// symbols and opening prices are a table in the note it sits in
// (`note.read`); prices then drift by a SEEDED random walk, so it runs with
// no network at all. Which symbols show is kept in its own corner of
// clewdata.json (`app.kv`). "Live ECB rates" swaps in the euro's real
// reference rates from api.frankfurter.dev — the one host its manifest names
// under `network`, so its CSP lets it reach that host and no other, and it
// asks nothing of it until the switch is on.
const $ = (id) => document.getElementById(id);
const LIVE_URL = 'https://api.frankfurter.dev/v1';
const CURRENCIES = ['USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'SEK'];
const SPEED = 70;            // px per second, right to left
const STEP_MS = 1500;        // a price tick
const LIVE_EVERY_MS = 30 * 60 * 1000;   // the ECB fixes once a working day

let tableRows = [];          // [{ symbol, open }] from the note
let hidden = new Set();      // symbols switched off in the watchlist
let quotes = [];             // [{ symbol, open, price }] being shown
let mode = 'simulated';
let paused = false;
let liveTimer = null;
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');

// ---- the note's table -----------------------------------------------------

/** The first markdown table with a Symbol and a Price column. */
function tableIn(text) {
	const lines = text.split('\n');
	for (let i = 0; i < lines.length - 1; i++) {
		if (!/^\s*\|/.test(lines[i])) continue;
		const head = cells(lines[i]).map((c) => c.toLowerCase());
		const s = head.findIndex((c) => c === 'symbol');
		const p = head.findIndex((c) => c === 'price');
		if (s < 0 || p < 0 || !/^\s*\|?\s*:?-+/.test(lines[i + 1])) continue;
		const rows = [];
		for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
			const row = cells(lines[j]);
			const open = Number(String(row[p] ?? '').replace(/[^0-9.\-]/g, ''));
			const symbol = String(row[s] ?? '').replace(/[`*_]/g, '').trim().toUpperCase();
			if (symbol && Number.isFinite(open) && open > 0) rows.push({ symbol, open });
		}
		return rows;
	}
	return [];
}
const cells = (line) => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

// ---- a seeded random walk -------------------------------------------------

function seedOf(text) {
	let h = 2166136261;
	for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
	return h >>> 0;
}
function mulberry32(seed) {
	return () => {
		seed = (seed + 0x6d2b79f5) | 0;
		let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
let random = mulberry32(1);
const gaussian = () => Math.sqrt(-2 * Math.log(1 - random())) * Math.cos(2 * Math.PI * random());

function simulate() {
	random = mulberry32(seedOf(tableRows.map((r) => r.symbol).join(',')));
	quotes = tableRows.map((r) => ({ symbol: r.symbol, open: r.open, price: r.open }));
}
function tick() {
	if (mode !== 'simulated' || paused || document.hidden) return;
	for (const q of quotes) q.price = Math.max(0.01, q.price * Math.exp(0.004 * gaussian()));
	update();
}

// ---- live rates -----------------------------------------------------------

async function fetchLive() {
	const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
	const res = await fetch(`${LIVE_URL}/${start}..?from=EUR&to=${CURRENCIES.join(',')}`);
	if (!res.ok) throw new Error(`the rates service answered ${res.status}`);
	const data = await res.json();
	const dates = Object.keys(data.rates ?? {}).sort();
	if (!dates.length) throw new Error('no rates came back');
	const last = data.rates[dates.at(-1)];
	const prev = data.rates[dates.at(-2) ?? dates.at(-1)];
	return {
		date: dates.at(-1),
		quotes: CURRENCIES.filter((c) => last[c] != null).map((c) => ({ symbol: `EUR/${c}`, open: prev[c] ?? last[c], price: last[c] })),
	};
}

async function goLive() {
	clearInterval(liveTimer);
	status('Fetching the ECB reference rates…');
	try {
		const live = await fetchLive();
		mode = 'live';
		quotes = live.quotes;
		build();
		status(`ECB reference rates of ${live.date}, against the previous fixing — from api.frankfurter.dev`);
		liveTimer = setInterval(() => fetchLive().then((l) => { quotes = l.quotes; build(); }).catch(() => {}), LIVE_EVERY_MS);
	} catch (err) {
		$('live').checked = false;
		goSimulated(`Live rates unavailable (${err.message}) — showing the simulated prices.`);
	}
	document.body.dataset.mode = mode;
}

function goSimulated(message) {
	clearInterval(liveTimer);
	mode = 'simulated';
	simulate();
	build();
	status(message ?? `${quotes.length} symbols from this note, drifting by a seeded random walk — no network.`);
	document.body.dataset.mode = mode;
}

// ---- drawing --------------------------------------------------------------

const decimals = (q) => (q.price >= 1000 ? 0 : q.price >= 10 ? 2 : 4);
let rows = new Map();        // symbol → [{ price, chg } elements], one per copy

function itemFor(q) {
	const el = document.createElement('span');
	el.className = 'item';
	const sym = document.createElement('span');
	sym.className = 'sym';
	sym.textContent = q.symbol;
	const price = document.createElement('span');
	const chg = document.createElement('span');
	chg.className = 'chg';
	el.append(sym, price, chg);
	if (!rows.has(q.symbol)) rows.set(q.symbol, []);
	rows.get(q.symbol).push({ price, chg });
	return el;
}

/** The track: the visible quotes twice over, so the loop has no seam. */
function build() {
	rows = new Map();
	const shown = quotes.filter((q) => mode === 'live' || !hidden.has(q.symbol));
	const track = $('track');
	track.replaceChildren();
	const copies = reduceMotion.matches ? 1 : 2;
	for (let c = 0; c < copies; c++) for (const q of shown) track.append(itemFor(q));
	if (!shown.length) track.textContent = mode === 'live' ? '' : '  Every symbol is switched off in the watchlist.';
	document.body.dataset.items = String(shown.length);
	offset = 0;
	update();
}

function update() {
	for (const q of quotes) {
		const delta = q.price - q.open;
		const pct = q.open ? (delta / q.open) * 100 : 0;
		const dir = Math.abs(pct) < 0.005 ? 'flat' : delta > 0 ? 'up' : 'down';
		for (const { price, chg } of rows.get(q.symbol) ?? []) {
			price.textContent = q.price.toFixed(decimals(q));
			chg.className = `chg ${dir}`;
			chg.textContent = `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}${Math.abs(delta).toFixed(decimals(q))} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)`;
		}
	}
}

let offset = 0;
let last = 0;
function frame(now) {
	const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
	last = now;
	const track = $('track');
	if (!paused && !document.hidden && !reduceMotion.matches && track.children.length) {
		const half = track.scrollWidth / 2;
		offset -= SPEED * dt;
		if (half > 0 && -offset >= half) offset += half;
		track.style.transform = `translateX(${offset}px)`;
	}
	requestAnimationFrame(frame);
}

function applyMotion() {
	$('tape').classList.toggle('static', reduceMotion.matches);
	build();
}

function status(text) { $('status').textContent = text; }

// ---- the watchlist (app.kv) -------------------------------------------------

function drawWatchlist() {
	const box = $('watch');
	box.replaceChildren();
	for (const r of tableRows) {
		const label = document.createElement('label');
		const input = document.createElement('input');
		input.type = 'checkbox';
		input.checked = !hidden.has(r.symbol);
		input.addEventListener('change', async () => {
			if (input.checked) hidden.delete(r.symbol); else hidden.add(r.symbol);
			if (clew.can('app.kv')) await clew.kv.set('hidden', [...hidden]);
			build();
		});
		label.append(input, document.createTextNode(r.symbol));
		box.append(label);
	}
}

// ---- start ------------------------------------------------------------------

async function readTable() {
	tableRows = tableIn(await clew.notes.read());
	drawWatchlist();
	if (mode === 'simulated') goSimulated(tableRows.length ? null : 'Add a table with Symbol and Price columns to this note.');
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	if (!clew.can('note.read')) { status('Allow “read this note” to see the ticker.'); return; }
	if (clew.can('app.kv')) {
		hidden = new Set((await clew.kv.get('hidden')) ?? []);
		$('live').checked = Boolean(await clew.kv.get('live'));
	}
	if (!clew.can('network')) {
		$('live').disabled = true;
		$('live').parentElement.title = 'Needs “send data to the internet”, for api.frankfurter.dev only';
	}
	await readTable();
	clew.on('note-changed', () => readTable().catch(() => {}));
	if ($('live').checked && clew.can('network')) await goLive();
	$('live').addEventListener('change', async () => {
		if (clew.can('app.kv')) await clew.kv.set('live', $('live').checked);
		if ($('live').checked) await goLive(); else goSimulated();
	});
	$('pause').addEventListener('click', () => {
		paused = !paused;
		$('pause').textContent = paused ? 'Play' : 'Pause';
		$('pause').setAttribute('aria-pressed', String(paused));
	});
	$('watchBtn').addEventListener('click', () => {
		const open = $('watch').classList.toggle('open');
		$('watchBtn').setAttribute('aria-expanded', String(open));
	});
	reduceMotion.addEventListener('change', applyMotion);
	document.addEventListener('visibilitychange', () => { last = 0; });
	applyMotion();
	setInterval(tick, STEP_MS);
	requestAnimationFrame(frame);
}

main().catch((err) => status(`Stock Ticker: ${err.message}`));
