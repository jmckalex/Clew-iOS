// Stock Ticker — a ticker-tape band in a note (Features/App Gallery), in
// three modes, Simulated the default:
//   - Simulated: the symbols and opening prices of a table in the note it
//     sits in (`note.read`), drifting by a SEEDED random walk — no network.
//   - Live stocks: US quotes for those symbols from Finnhub's
//     /api/v1/quote (live.js has the rules: each symbol about once a minute,
//     within the free limit; a 429 backs off and says so; the market shows
//     as closed once every quote is old). It needs your own free key, kept
//     as a SECRET of this app on this device (`app.secrets`: encrypted by
//     the system — the Keychain on a Mac or an iPad) — never in app.kv,
//     which is clewdata.json in the vault and travels with it — and never
//     logged. Without that grant the key lasts this session only.
//   - ECB rates: the euro's reference rates from api.frankfurter.dev.
// Its manifest names exactly those two hosts under `network`, so its CSP
// lets it reach them and no other; it asks nothing of either until you
// choose that mode. Which symbols show, and the mode, are kept in `app.kv`.
const $ = (id) => document.getElementById(id);
const FINNHUB_API = 'https://finnhub.io/api/v1';
const ECB_API = 'https://api.frankfurter.dev/v1';
const CURRENCIES = ['USD', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'CNY', 'SEK'];
const KEY_NAME = 'finnhub-key';
const SPEED = 70;            // px per second, right to left
const STEP_MS = 1500;        // a simulated price tick
const ECB_EVERY_MS = 30 * 60 * 1000;   // the ECB fixes once a working day

let tableRows = [];          // [{ symbol, open }] from the note
let hidden = new Set();      // symbols switched off in the watchlist
let quotes = [];             // [{ symbol, open, price }] being shown
let mode = 'simulated';
let paused = false;
let ecbTimer = null;
const poll = { timer: null, i: 0, firstRound: true, backoff: 0, quotes: new Map(), lastUpdate: null, requests: 0 };
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
const { nextDelay, backoffAfter429, quoteFrom, marketState, quoteUrl } = globalThis.TickerLive;

// ---- the key: this device only --------------------------------------------
// Clew keeps it, as this app's secret on this device (`clew.secrets`), when
// "keep secrets" is allowed; otherwise it lasts this session only. A key an
// older Ticker left in this frame's localStorage moves across once (on an
// iPad that storage never outlived a launch anyway).

let key = null;
let keyKept = false;   // whether the key outlives this session

function legacyKey(remove = false) {
	try {
		const old = localStorage.getItem(KEY_NAME) || null;
		if (remove) localStorage.removeItem(KEY_NAME);
		return old;
	} catch {
		return null;
	}
}

async function loadKey() {
	keyKept = clew.can('app.secrets');
	if (!keyKept) { key = legacyKey(); return; }
	try {
		key = await clew.secrets.get(KEY_NAME);
		const old = legacyKey();
		if (!key && old) { await clew.secrets.set(KEY_NAME, old); key = old; }
		if (old) legacyKey(true);
	} catch {
		keyKept = false;
		key = legacyKey();
	}
}

function readKey() { return key; }

/** Keep `value` (or forget it, null); false when it could not be kept. */
async function writeKey(value) {
	if (keyKept) {
		try {
			if (value) await clew.secrets.set(KEY_NAME, value);
			else await clew.secrets.delete(KEY_NAME);
		} catch {
			// No secure storage on this device: this session only.
			keyKept = false;
		}
	}
	if (!value) legacyKey(true);
	key = value || null;
	return true;
}

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
const watched = () => tableRows.filter((r) => !hidden.has(r.symbol));

// ---- simulated: a seeded random walk ----------------------------------------

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

function tick() {
	if (mode !== 'simulated' || paused || document.hidden) return;
	for (const q of quotes) q.price = Math.max(0.01, q.price * Math.exp(0.004 * gaussian()));
	update();
}

// ---- live stocks: Finnhub ---------------------------------------------------

function stopPolling() {
	clearTimeout(poll.timer);
	poll.timer = null;
}
function schedule(ms) {
	clearTimeout(poll.timer);
	poll.timer = setTimeout(pump, ms);
}

function startStocks() {
	stopPolling();
	if (!readKey()) {
		quotes = [];
		build();
		badge('none', 'Live stocks');
		status('Live stocks needs a free Finnhub key (finnhub.io) — add yours under Key….');
		openPanel();
		return;
	}
	Object.assign(poll, { i: 0, firstRound: true, backoff: 0, quotes: new Map(), lastUpdate: null });
	showStocks();
	badge('none', 'Live …');
	status('Fetching US quotes from Finnhub…');
	pump();
}

async function pump() {
	poll.timer = null;
	if (mode !== 'stocks') return;
	// No requests while the app is out of sight; look again shortly.
	if (document.hidden) { schedule(2000); return; }
	const symbols = watched().map((r) => r.symbol);
	if (!symbols.length) { status('Every symbol is switched off in the watchlist.'); return; }
	const key = readKey();
	if (!key) { startStocks(); return; }
	const symbol = symbols[poll.i % symbols.length];
	let res;
	try {
		poll.requests++;
		document.body.dataset.requests = String(poll.requests);
		res = await fetch(quoteUrl(FINNHUB_API, symbol, key), { cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' });
	} catch {
		if (mode === 'stocks') { status('Cannot reach finnhub.io — trying again in 30 s.'); schedule(30000); }
		return;
	}
	if (mode !== 'stocks') return;
	if (res.status === 429) {
		poll.backoff = backoffAfter429(poll.backoff, res.headers.get('Retry-After'));
		document.body.dataset.backoff = String(poll.backoff);
		status(`Finnhub says too many requests — waiting ${Math.round(poll.backoff / 1000)} s before asking again.`);
		schedule(poll.backoff);
		return;
	}
	if (res.status === 401 || res.status === 403) {
		badge('none', 'Live stocks');
		status(`Finnhub refused the key (${res.status}) — check it under Key….`);
		document.body.dataset.refused = String(res.status);
		openPanel();
		return;
	}
	if (!res.ok) {
		status(`Finnhub answered ${res.status} — trying again in 30 s.`);
		schedule(30000);
		return;
	}
	const json = await res.json().catch(() => null);
	poll.backoff = 0;
	poll.quotes.set(symbol, quoteFrom(json));
	poll.lastUpdate = Date.now();
	poll.i++;
	if (poll.i >= symbols.length) poll.firstRound = false;
	showStocks();
	schedule(nextDelay({ symbols: symbols.length, firstRound: poll.firstRound }));
}

const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const day = (ms) => new Date(ms).toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });

function showStocks() {
	const next = watched().map((r) => {
		const q = poll.quotes.get(r.symbol);
		if (!q || q.unknown) return { symbol: r.symbol, open: NaN, price: NaN, unknown: Boolean(q?.unknown) };
		return { symbol: r.symbol, open: q.prevClose, price: q.price };
	});
	const same = next.length === quotes.length && next.every((q, i) => q.symbol === quotes[i]?.symbol);
	quotes = next;
	if (same) update(); else build();
	const market = marketState([...poll.quotes.values()], Date.now() / 1000);
	if (market.state === 'closed') badge('closed', `Closed · as of ${day(market.asOf * 1000)} ${clock(market.asOf * 1000)}`);
	else if (market.state === 'open') badge('open', `Live ${clock(poll.lastUpdate)}`);
	const unknown = quotes.filter((q) => q.unknown).map((q) => q.symbol);
	if (poll.lastUpdate) {
		status(`US quotes from Finnhub, each about once a minute; last at ${clock(poll.lastUpdate)}.`
			+ (unknown.length ? ` No quote for ${unknown.join(', ')}.` : ''));
	}
}

// ---- ECB rates: Frankfurter -------------------------------------------------

async function fetchEcb() {
	const start = new Date(Date.now() - 10 * 86400000).toISOString().slice(0, 10);
	const res = await fetch(`${ECB_API}/${start}..?from=EUR&to=${CURRENCIES.join(',')}`, { credentials: 'omit', referrerPolicy: 'no-referrer' });
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

async function startEcb() {
	status('Fetching the ECB reference rates…');
	try {
		const live = await fetchEcb();
		if (mode !== 'ecb') return;
		quotes = live.quotes;
		build();
		badge('open', `ECB ${live.date}`);
		status(`ECB reference rates of ${live.date}, against the previous fixing — from api.frankfurter.dev.`);
		ecbTimer = setInterval(() => fetchEcb().then((l) => { if (mode === 'ecb') { quotes = l.quotes; build(); } }).catch(() => {}), ECB_EVERY_MS);
	} catch (err) {
		if (mode === 'ecb') status(`ECB rates unavailable (${err.message}).`);
	}
}

// ---- simulated ----------------------------------------------------------------

function startSimulated() {
	random = mulberry32(seedOf(tableRows.map((r) => r.symbol).join(',')));
	quotes = watched().map((r) => ({ symbol: r.symbol, open: r.open, price: r.open }));
	build();
	badge('sim', 'Simulated');
	status(tableRows.length
		? `${watched().length} symbols from this note, drifting by a seeded random walk — not the market, and no network.`
		: 'Add a table with Symbol and Price columns to this note.');
}

// ---- modes ---------------------------------------------------------------------

async function setMode(next, { save = true } = {}) {
	if ((next === 'stocks' || next === 'ecb') && !clew.can('network')) next = 'simulated';
	mode = next;
	stopPolling();
	clearInterval(ecbTimer);
	for (const b of document.querySelectorAll('.modes button')) b.setAttribute('aria-checked', String(b.dataset.mode === mode));
	document.body.dataset.mode = mode;
	if (save && clew.can('app.kv')) await clew.kv.set('mode', mode);
	if (mode === 'stocks') startStocks();
	else if (mode === 'ecb') await startEcb();
	else startSimulated();
}

function badge(state, text) {
	$('badge').dataset.state = state;
	$('badge').textContent = text;
	document.body.dataset.badge = text;
	// The states shown, in order (smoke/ticker-live-scenario.js reads it).
	const shown = (document.body.dataset.badgeLog ?? '').split(',').filter(Boolean);
	if (shown.at(-1) !== state) document.body.dataset.badgeLog = [...shown, state].join(',');
}

// ---- drawing ------------------------------------------------------------------

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

/** The track: the quotes twice over, so the loop has no seam. */
function build() {
	rows = new Map();
	const track = $('track');
	track.replaceChildren();
	const copies = reduceMotion.matches ? 1 : 2;
	for (let c = 0; c < copies; c++) for (const q of quotes) track.append(itemFor(q));
	if (!quotes.length) track.textContent = mode === 'simulated' ? '  Every symbol is switched off in the watchlist.' : '';
	document.body.dataset.items = String(quotes.length);
	offset = 0;
	update();
}

function update() {
	for (const q of quotes) {
		const known = Number.isFinite(q.price);
		const delta = known ? q.price - q.open : 0;
		const pct = known && q.open ? (delta / q.open) * 100 : 0;
		const dir = !known || Math.abs(pct) < 0.005 ? 'flat' : delta > 0 ? 'up' : 'down';
		for (const { price, chg } of rows.get(q.symbol) ?? []) {
			price.textContent = known ? q.price.toFixed(decimals(q)) : '—';
			chg.className = `chg ${dir}`;
			chg.textContent = known
				? `${dir === 'up' ? '▲' : dir === 'down' ? '▼' : '■'}${Math.abs(delta).toFixed(decimals(q))} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)`
				: (q.unknown ? 'no quote' : '');
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

// ---- the key panel -------------------------------------------------------------

function openPanel() {
	const has = Boolean(readKey());
	$('keyState').textContent = !has ? 'No key saved.'
		: keyKept ? 'A key is saved on this device.'
		: 'A key is kept for this session only: allow “keep secrets” to keep it on this device.';
	$('keyForget').disabled = !has;
	document.body.dataset.hasKey = has ? '1' : '0';
	$('keyPanel').classList.add('open');
	$('keyInput').focus();
}
function closePanel() {
	$('keyInput').value = '';
	$('keyPanel').classList.remove('open');
}

// ---- the watchlist (app.kv) ----------------------------------------------------

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
			if (mode === 'simulated') startSimulated();
			else if (mode === 'stocks') showStocks();
		});
		label.append(input, document.createTextNode(r.symbol));
		box.append(label);
	}
}

// ---- start ------------------------------------------------------------------------

async function readTable() {
	tableRows = tableIn(await clew.notes.read());
	drawWatchlist();
	if (mode === 'simulated') startSimulated();
	else if (mode === 'stocks') showStocks();
}

async function main() {
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; });
	if (!clew.can('note.read')) { status('Allow “read this note” to see the ticker.'); return; }
	let saved = 'simulated';
	if (clew.can('app.kv')) {
		hidden = new Set((await clew.kv.get('hidden')) ?? []);
		saved = (await clew.kv.get('mode')) ?? ((await clew.kv.get('live')) ? 'ecb' : 'simulated');
	}
	if (!clew.can('network')) {
		for (const id of ['modeStocks', 'modeEcb', 'keyBtn']) $(id).disabled = true;
		$('modeStocks').parentElement.title = 'Needs “send data to the internet”, for finnhub.io and api.frankfurter.dev only';
	}
	await loadKey();
	// "keep secrets" allowed later, live: a session's key is kept from now on.
	clew.on('grant-changed', async () => {
		if (!keyKept && clew.can('app.secrets')) {
			const current = key;
			keyKept = true;
			if (current) await writeKey(current);
		}
	});
	tableRows = tableIn(await clew.notes.read());
	drawWatchlist();
	clew.on('note-changed', () => readTable().catch(() => {}));
	for (const b of document.querySelectorAll('.modes button')) b.addEventListener('click', () => setMode(b.dataset.mode));
	$('keyBtn').addEventListener('click', openPanel);
	$('keyClose').addEventListener('click', closePanel);
	$('keySave').addEventListener('click', async () => {
		const value = $('keyInput').value.trim();
		if (!value) return;
		await writeKey(value);
		closePanel();
		document.body.dataset.hasKey = '1';
		await setMode('stocks');
	});
	$('keyInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('keySave').click(); });
	$('keyForget').addEventListener('click', async () => {
		await writeKey(null);
		closePanel();
		document.body.dataset.hasKey = '0';
		if (mode === 'stocks') {
			stopPolling();
			status('Key forgotten: it is gone from this device. Live stocks waits for a new one (Key…).');
			badge('none', 'Live stocks');
		}
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
	$('tape').classList.toggle('static', reduceMotion.matches);
	await setMode(saved, { save: false });
	setInterval(tick, STEP_MS);
	requestAnimationFrame(frame);
}

main().catch((err) => status(`Stock Ticker: ${err.message}`));
