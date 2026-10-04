// Replicator Dynamics Lab — evolutionary game theory in a note (Features/App
// Gallery). Pick a game or set the payoffs; the replicator equation
//
//     dx_i/dt = x_i ((A x)_i − x·A x)
//
// is integrated (RK4) from the start you choose, and drawn over time and as a
// phase portrait: a phase line for two strategies, the simplex for three.
// Every rest point is found — the vertices, the edges' mixed points, the
// interior one — and classified by the eigenvalues of the dynamics' Jacobian
// on the simplex. "Insert result" puts a summary at your cursor in the note
// (`editor.insert`, the one thing it asks for): it reads nothing of yours.
const $ = (id) => document.getElementById(id);

const GAMES = {
	stag: { name: 'Stag Hunt', strategies: ['Stag', 'Hare'], A: [[4, 0], [3, 3]] },
	hawk: { name: 'Hawk–Dove', strategies: ['Hawk', 'Dove'], A: [[-1, 2], [0, 1]] },
	pd: { name: 'Prisoner’s Dilemma', strategies: ['Cooperate', 'Defect'], A: [[3, 0], [5, 1]] },
	rps: { name: 'Rock–Paper–Scissors', strategies: ['Rock', 'Paper', 'Scissors'], A: [[0, -1, 1], [1, 0, -1], [-1, 1, 0]] },
	custom2: { name: 'Custom, two strategies', strategies: ['A', 'B'], A: [[2, 0], [0, 1]] },
	custom3: { name: 'Custom, three strategies', strategies: ['A', 'B', 'C'], A: [[1, 0, 0], [0, 1, 0], [0, 0, 1]] },
};
const EPS = 1e-7;

let key = 'stag';
let A = GAMES.stag.A.map((r) => [...r]);
let start3 = [0.5, 0.3, 0.2];

const game = () => GAMES[key];
const n = () => A.length;
const fmt = (v) => {
	const r = Math.round(v * 1000) / 1000;
	return (Object.is(r, -0) ? 0 : r).toString().replace('-', '−');
};

// ---- the dynamics -----------------------------------------------------------

function field(M, x) {
	const f = M.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
	const mean = f.reduce((s, fi, i) => s + fi * x[i], 0);
	return x.map((xi, i) => xi * (f[i] - mean));
}

function onSimplex(x) {
	const c = x.map((v) => Math.max(0, v));
	const s = c.reduce((a, b) => a + b, 0) || 1;
	return c.map((v) => v / s);
}

/** The path from `x0` over [0, T], RK4, ~400 samples. */
function trajectory(M, x0, T) {
	const dt = 0.01;
	const steps = Math.ceil(T / dt);
	const every = Math.max(1, Math.floor(steps / 400));
	let x = [...x0];
	const out = [{ t: 0, x }];
	const add = (p, k, h) => p.map((v, i) => v + h * k[i]);
	for (let s = 1; s <= steps; s++) {
		const k1 = field(M, x);
		const k2 = field(M, add(x, k1, dt / 2));
		const k3 = field(M, add(x, k2, dt / 2));
		const k4 = field(M, add(x, k3, dt));
		x = onSimplex(x.map((v, i) => v + (dt / 6) * (k1[i] + 2 * k2[i] + 2 * k3[i] + k4[i])));
		if (s % every === 0 || s === steps) out.push({ t: s * dt, x });
	}
	return out;
}

// ---- rest points --------------------------------------------------------------

/** Two strategies: x is the share of the first. */
function restPoints2(M) {
	const [[a, b], [c, d]] = M;
	const g = (x) => (a - c) * x + (b - d) * (1 - x);
	const xdot = (x) => x * (1 - x) * g(x);
	if (Math.abs(a - c) < EPS && Math.abs(b - d) < EPS) return { everywhere: true, points: [] };
	const xs = [0, 1];
	const den = (a - c) - (b - d);
	if (Math.abs(den) > EPS) {
		const inner = (d - b) / den;
		if (inner > EPS && inner < 1 - EPS) xs.push(inner);
	}
	xs.sort((p, q) => p - q);
	const h = 1e-4;
	return {
		everywhere: false,
		points: xs.map((x) => {
			// Each side there is (an endpoint has one): does the flow come in?
			const sides = [];
			if (x > 0) { const v = xdot(x - h); sides.push(v > EPS ? 'in' : v < -EPS ? 'out' : 'flat'); }
			if (x < 1) { const v = xdot(x + h); sides.push(v < -EPS ? 'in' : v > EPS ? 'out' : 'flat'); }
			const kind = sides.includes('flat') ? 'neutral'
				: sides.every((s) => s === 'in') ? 'stable'
					: sides.every((s) => s === 'out') ? 'unstable' : 'semi-stable';
			return { x: [x, 1 - x], kind };
		}),
	};
}

/** Solve M y = r (small dense systems), or null when singular. */
function solve(M, r) {
	const m = M.map((row, i) => [...row, r[i]]);
	const size = m.length;
	for (let col = 0; col < size; col++) {
		let pivot = col;
		for (let i = col + 1; i < size; i++) if (Math.abs(m[i][col]) > Math.abs(m[pivot][col])) pivot = i;
		if (Math.abs(m[pivot][col]) < 1e-12) return null;
		[m[col], m[pivot]] = [m[pivot], m[col]];
		for (let i = 0; i < size; i++) {
			if (i === col) continue;
			const f = m[i][col] / m[col][col];
			for (let j = col; j <= size; j++) m[i][j] -= f * m[col][j];
		}
	}
	return m.map((row, i) => row[size] / row[i]);
}

/** The Jacobian's eigenvalues on the simplex, at x — classified. */
function classify3(M, x) {
	const h = 1e-5;
	const F = (u, v) => { const d = field(M, [u, v, 1 - u - v]); return [d[0], d[1]]; };
	const [u, v] = x;
	const du = [F(u + h, v), F(u - h, v)];
	const dv = [F(u, v + h), F(u, v - h)];
	const J = [
		[(du[0][0] - du[1][0]) / (2 * h), (dv[0][0] - dv[1][0]) / (2 * h)],
		[(du[0][1] - du[1][1]) / (2 * h), (dv[0][1] - dv[1][1]) / (2 * h)],
	];
	const tr = J[0][0] + J[1][1];
	const det = J[0][0] * J[1][1] - J[0][1] * J[1][0];
	const disc = tr * tr - 4 * det;
	const tol = 1e-6;
	if (disc < -tol) {
		const re = tr / 2;
		return re < -tol ? 'stable (a spiral)' : re > tol ? 'unstable (a spiral)' : 'neutral (a centre)';
	}
	const root = Math.sqrt(Math.max(0, disc));
	const l1 = (tr + root) / 2;
	const l2 = (tr - root) / 2;
	if (l1 < -tol && l2 < -tol) return 'stable';
	if (l1 > tol && l2 > tol) return 'unstable';
	if ((l1 > tol && l2 < -tol) || (l2 > tol && l1 < -tol)) return 'a saddle';
	return 'neutral';
}

function restPoints3(M) {
	const pts = [];
	const add = (x) => {
		if (pts.some((p) => p.x.every((v, i) => Math.abs(v - x[i]) < 1e-6))) return;
		pts.push({ x, kind: classify3(M, x) });
	};
	for (let i = 0; i < 3; i++) add([0, 1, 2].map((j) => (j === i ? 1 : 0)));
	for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
		const a = M[i][i]; const b = M[i][j]; const c = M[j][i]; const d = M[j][j];
		const den = (a - c) - (b - d);
		if (Math.abs(den) < EPS) continue;
		const y = (d - b) / den;
		if (y > EPS && y < 1 - EPS) {
			const x = [0, 0, 0];
			x[i] = y;
			x[j] = 1 - y;
			add(x);
		}
	}
	const sol = solve([[...M[0], -1], [...M[1], -1], [...M[2], -1], [1, 1, 1, 0]], [0, 0, 0, 1]);
	if (sol && sol.slice(0, 3).every((v) => v > EPS)) add(sol.slice(0, 3));
	return { everywhere: false, points: pts };
}

const restPoints = () => (n() === 2 ? restPoints2(A) : restPoints3(A));

// ---- the summary ------------------------------------------------------------

function pointLabel(p) {
	const s = game().strategies;
	if (n() === 2) {
		const x = p.x[0];
		if (x === 1) return `x = 1 (all ${s[0]})`;
		if (x === 0) return `x = 0 (all ${s[1]})`;
		return `x = ${fmt(x)}`;
	}
	const pure = p.x.findIndex((v) => v === 1);
	if (pure >= 0) return `all ${s[pure]}`;
	return `(${p.x.map(fmt).join(', ')})`;
}

function summary() {
	const g = game();
	const s = g.strategies;
	const rp = restPoints();
	const payoffs = A.map((row, i) => `${s[i]} [${row.map(fmt).join(', ')}]`).join(', ');
	const who = n() === 2 ? `x = the share playing ${s[0]}` : `shares of ${s.join(', ')}`;
	const lines = [`*Replicator dynamics — ${g.name}.* Payoffs (row against column): ${payoffs}. Rest points (${who}):`];
	if (rp.everywhere) lines.push('- every share is a rest point: the strategies do equally well');
	for (const p of rp.points) lines.push(`- ${pointLabel(p)}: ${p.kind}`);
	return lines.join('\n');
}

// ---- drawing ----------------------------------------------------------------

const css = (name) => getComputedStyle(document.body).getPropertyValue(name).trim();
const colours = () => [css('--s1'), css('--s2'), css('--s3')];

function context2d(canvas) {
	const dpr = window.devicePixelRatio || 1;
	const w = canvas.clientWidth;
	const h = canvas.clientHeight;
	if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
		canvas.width = Math.round(w * dpr);
		canvas.height = Math.round(h * dpr);
	}
	const ctx = canvas.getContext('2d');
	ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	ctx.clearRect(0, 0, w, h);
	ctx.font = '12px -apple-system, system-ui, sans-serif';
	return { ctx, w, h };
}

function marker(ctx, x, y, kind) {
	ctx.beginPath();
	ctx.arc(x, y, 6, 0, 2 * Math.PI);
	ctx.lineWidth = 2;
	if (kind.startsWith('stable')) { ctx.fillStyle = css('--stable'); ctx.fill(); }
	else if (kind.startsWith('unstable')) { ctx.fillStyle = css('--bg'); ctx.fill(); ctx.strokeStyle = css('--unstable'); ctx.stroke(); }
	else { ctx.fillStyle = css('--bg'); ctx.fill(); ctx.strokeStyle = css('--muted'); ctx.stroke(); }
}

function arrow(ctx, x0, y0, x1, y1, size = 6) {
	const a = Math.atan2(y1 - y0, x1 - x0);
	ctx.beginPath();
	ctx.moveTo(x0, y0);
	ctx.lineTo(x1, y1);
	ctx.moveTo(x1, y1);
	ctx.lineTo(x1 - size * Math.cos(a - 0.5), y1 - size * Math.sin(a - 0.5));
	ctx.moveTo(x1, y1);
	ctx.lineTo(x1 - size * Math.cos(a + 0.5), y1 - size * Math.sin(a + 0.5));
	ctx.stroke();
}

function drawTime(path) {
	const { ctx, w, h } = context2d($('time'));
	const pad = { l: 28, r: 8, t: 8, b: 20 };
	const T = path.at(-1).t || 1;
	const X = (t) => pad.l + (t / T) * (w - pad.l - pad.r);
	const Y = (v) => pad.t + (1 - v) * (h - pad.t - pad.b);
	ctx.strokeStyle = css('--line');
	ctx.fillStyle = css('--muted');
	ctx.lineWidth = 1;
	for (const v of [0, 0.5, 1]) {
		ctx.beginPath(); ctx.moveTo(pad.l, Y(v)); ctx.lineTo(w - pad.r, Y(v)); ctx.stroke();
		ctx.fillText(String(v), 4, Y(v) + 4);
	}
	ctx.fillText(`t = ${Math.round(T)}`, w - pad.r - 44, h - 4);
	const cols = colours();
	for (let i = 0; i < n(); i++) {
		ctx.strokeStyle = cols[i];
		ctx.lineWidth = 2;
		ctx.beginPath();
		path.forEach((p, k) => (k ? ctx.lineTo(X(p.t), Y(p.x[i])) : ctx.moveTo(X(p.t), Y(p.x[i]))));
		ctx.stroke();
	}
	ctx.fillStyle = css('--fg');
	game().strategies.forEach((s, i) => { ctx.fillStyle = cols[i]; ctx.fillText(s, pad.l + 6 + i * 80, pad.t + 12); });
}

function drawPhaseLine(path, rp) {
	const { ctx, w, h } = context2d($('phase'));
	const s = game().strategies;
	const pad = 28;
	const X = (x) => pad + x * (w - 2 * pad);
	const y = h / 2;
	ctx.strokeStyle = css('--muted');
	ctx.fillStyle = css('--muted');
	ctx.lineWidth = 2;
	ctx.beginPath(); ctx.moveTo(X(0), y); ctx.lineTo(X(1), y); ctx.stroke();
	ctx.fillText(`all ${s[1]}`, X(0) - 18, y + 26);
	ctx.fillText(`all ${s[0]}`, X(1) - 30, y + 26);
	ctx.fillText(`x = share playing ${s[0]}`, pad, 16);
	const xs = rp.points.map((p) => p.x[0]);
	const [[a, b], [c, d]] = A;
	const xdot = (x) => x * (1 - x) * ((a - c) * x + (b - d) * (1 - x));
	ctx.strokeStyle = css('--fg');
	ctx.lineWidth = 1.5;
	if (!rp.everywhere) {
		for (let k = 0; k + 1 < xs.length; k++) {
			const mid = (xs[k] + xs[k + 1]) / 2;
			const dir = Math.sign(xdot(mid));
			if (!dir) continue;
			arrow(ctx, X(mid) - dir * 14, y - 12, X(mid) + dir * 14, y - 12);
		}
	}
	const x0 = path[0].x[0];
	const x1 = path.at(-1).x[0];
	ctx.fillStyle = css('--accent');
	ctx.beginPath(); ctx.moveTo(X(x0), y + 8); ctx.lineTo(X(x0) - 5, y + 16); ctx.lineTo(X(x0) + 5, y + 16); ctx.fill();
	ctx.strokeStyle = css('--accent');
	ctx.beginPath(); ctx.moveTo(X(x0), y + 4); ctx.lineTo(X(x1), y + 4); ctx.stroke();
	for (const p of rp.points) marker(ctx, X(p.x[0]), y, p.kind);
}

let simplexGeom = null;
function drawSimplex(path, rp) {
	const { ctx, w, h } = context2d($('phase'));
	const s = game().strategies;
	const size = Math.min(w - 40, (h - 36) / 0.866);
	const cx = w / 2;
	const top = 18;
	const V = [[cx, top], [cx - size / 2, top + size * 0.866], [cx + size / 2, top + size * 0.866]];
	const P = (x) => [x[0] * V[0][0] + x[1] * V[1][0] + x[2] * V[2][0], x[0] * V[0][1] + x[1] * V[1][1] + x[2] * V[2][1]];
	simplexGeom = { V, size };
	ctx.strokeStyle = css('--muted');
	ctx.lineWidth = 1.5;
	ctx.beginPath(); ctx.moveTo(...V[0]); ctx.lineTo(...V[1]); ctx.lineTo(...V[2]); ctx.closePath(); ctx.stroke();
	const cols = colours();
	ctx.fillStyle = cols[0]; ctx.fillText(s[0], V[0][0] + 8, V[0][1] + 4);
	ctx.fillStyle = cols[1]; ctx.fillText(s[1], V[1][0] - 8, V[1][1] + 16);
	ctx.fillStyle = cols[2]; ctx.fillText(s[2], V[2][0] - 30, V[2][1] + 16);
	// The flow: a faint arrow at each point of a grid.
	const N = 10;
	let max = 0;
	const arrows = [];
	for (let i = 1; i < N; i++) for (let j = 1; i + j < N; j++) {
		const x = [i / N, j / N, 1 - (i + j) / N];
		const dx = field(A, x);
		const speed = Math.hypot(...dx);
		max = Math.max(max, speed);
		arrows.push({ x, dx, speed });
	}
	ctx.strokeStyle = css('--line');
	ctx.lineWidth = 1;
	for (const a of arrows) {
		if (a.speed < 1e-9) continue;
		const from = P(a.x);
		const to = P(a.x.map((v, k) => v + a.dx[k] / a.speed * 0.001));
		const len = 6 + 8 * Math.sqrt(a.speed / (max || 1));
		const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
		arrow(ctx, from[0], from[1], from[0] + len * Math.cos(ang), from[1] + len * Math.sin(ang), 4);
	}
	ctx.strokeStyle = css('--accent');
	ctx.lineWidth = 2;
	ctx.beginPath();
	path.forEach((p, k) => (k ? ctx.lineTo(...P(p.x)) : ctx.moveTo(...P(p.x))));
	ctx.stroke();
	const st = P(path[0].x);
	ctx.fillStyle = css('--accent');
	ctx.beginPath(); ctx.arc(st[0], st[1], 4, 0, 2 * Math.PI); ctx.fill();
	for (const p of rp.points) marker(ctx, ...P(p.x), p.kind);
}

function redraw() {
	const T = Number($('horizon').value);
	$('horizonv').textContent = String(T);
	const x0 = n() === 2 ? [Number($('x0').value), 1 - Number($('x0').value)] : start3;
	$('x0v').textContent = fmt(Number($('x0').value));
	const path = trajectory(A, x0, T);
	const rp = restPoints();
	drawTime(path);
	if (n() === 2) drawPhaseLine(path, rp); else drawSimplex(path, rp);
	$('summary').textContent = summary().replace(/^\*(.*?)\*/, '$1');
	document.body.dataset.restPoints = String(rp.points.length);
}

// ---- controls -------------------------------------------------------------------

function buildMatrix() {
	const box = $('matrix');
	box.replaceChildren();
	const s = game().strategies;
	box.style.gridTemplateColumns = `auto repeat(${n()}, minmax(0, 1fr))`;
	box.append(document.createElement('span'));
	for (const name of s) {
		const head = document.createElement('span');
		head.className = 'head';
		head.textContent = `vs ${name}`;
		box.append(head);
	}
	A.forEach((row, i) => {
		const label = document.createElement('span');
		label.className = 'row';
		label.textContent = s[i];
		box.append(label);
		row.forEach((v, j) => {
			const cell = document.createElement('div');
			cell.className = 'cell';
			const input = document.createElement('input');
			input.type = 'range';
			input.min = '-5';
			input.max = '10';
			input.step = '0.5';
			input.value = String(v);
			input.setAttribute('aria-label', `${s[i]} against ${s[j]}`);
			const out = document.createElement('output');
			out.textContent = fmt(v);
			input.addEventListener('input', () => {
				A[i][j] = Number(input.value);
				out.textContent = fmt(A[i][j]);
				redraw();
			});
			cell.append(input, out);
			box.append(cell);
		});
	});
	const three = n() === 3;
	$('startRow').style.display = three ? 'none' : '';
	$('phaseTitle').textContent = three ? 'The simplex' : 'Phase line';
	$('hint').textContent = three ? 'Tap the triangle to choose where it starts.' : `Start: the share playing ${s[0]}.`;
}

function chooseGame(k) {
	key = k;
	A = GAMES[k].A.map((r) => [...r]);
	buildMatrix();
	redraw();
}

$('phase').addEventListener('pointerdown', (event) => {
	if (n() !== 3 || !simplexGeom) return;
	const r = $('phase').getBoundingClientRect();
	const px = event.clientX - r.left;
	const py = event.clientY - r.top;
	const [[x1, y1], [x2, y2], [x3, y3]] = simplexGeom.V;
	const det = (y2 - y3) * (x1 - x3) + (x3 - x2) * (y1 - y3);
	const l1 = ((y2 - y3) * (px - x3) + (x3 - x2) * (py - y3)) / det;
	const l2 = ((y3 - y1) * (px - x3) + (x1 - x3) * (py - y3)) / det;
	start3 = onSimplex([l1, l2, 1 - l1 - l2].map((v) => Math.max(0.005, v)));
	redraw();
});

async function insert() {
	try {
		await clew.editor.insert(`\n${summary()}\n`);
		$('status').textContent = 'Inserted at your cursor in the note.';
		document.body.dataset.inserted = String(Number(document.body.dataset.inserted ?? 0) + 1);
	} catch (err) {
		$('status').textContent = err.code === 'unavailable'
			? 'Open this note in Live edit or Source and put the cursor where the result should go.'
			: `Could not insert: ${err.message}`;
	}
}

async function main() {
	for (const [k, g] of Object.entries(GAMES)) {
		const o = document.createElement('option');
		o.value = k;
		o.textContent = g.name;
		$('game').append(o);
	}
	$('game').addEventListener('change', () => chooseGame($('game').value));
	$('x0').addEventListener('input', redraw);
	$('horizon').addEventListener('input', redraw);
	new ResizeObserver(() => redraw()).observe(document.body);
	chooseGame('stag');
	await clew.ready;
	const { theme } = await clew.context();
	document.body.dataset.theme = theme;
	clew.on('theme', ({ theme: t }) => { document.body.dataset.theme = t; redraw(); });
	redraw();
	if (clew.can('editor.insert')) {
		$('status').textContent = '';
		$('insert').addEventListener('click', insert);
	} else {
		$('insert').disabled = true;
		$('status').textContent = 'Allow “insert text where you are typing” to insert results.';
	}
}

main().catch((err) => { $('status').textContent = `Replicator Dynamics Lab: ${err.message}`; });
