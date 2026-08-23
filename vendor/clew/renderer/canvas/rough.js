// Hand-drawn ("sketchy") path generation for canvas shapes — the Excalidraw
// look: every stroke drawn as two slightly-bowed, jittered passes. All
// randomness is seeded from the shape's id, so a shape keeps its exact
// wobble across re-renders, saves, and app restarts.

/** mulberry32 over a string hash: a tiny deterministic PRNG. */
export function seededRand(seed) {
	let h = 1779033703;
	for (let i = 0; i < seed.length; i++) {
		h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
		h = (h << 13) | (h >>> 19);
	}
	return function () {
		h = Math.imul(h ^ (h >>> 16), 2246822507);
		h = Math.imul(h ^ (h >>> 13), 3266489909);
		h ^= h >>> 16;
		return (h >>> 0) / 4294967296;
	};
}

const jitter = (rand, amp) => (rand() - 0.5) * 2 * amp;

/** One hand-drawn line segment (two passes). */
export function roughLine(x1, y1, x2, y2, rand, amp = 2.2) {
	const parts = [];
	for (let pass = 0; pass < 2; pass++) {
		const mx = (x1 + x2) / 2 + jitter(rand, amp * 2.2);
		const my = (y1 + y2) / 2 + jitter(rand, amp * 2.2);
		parts.push(`M ${r2(x1 + jitter(rand, amp))} ${r2(y1 + jitter(rand, amp))}`
			+ ` Q ${r2(mx)} ${r2(my)}, ${r2(x2 + jitter(rand, amp))} ${r2(y2 + jitter(rand, amp))}`);
	}
	return parts.join(' ');
}

export function roughRect(x, y, w, h, rand, amp = 2.2) {
	return [
		roughLine(x, y, x + w, y, rand, amp),
		roughLine(x + w, y, x + w, y + h, rand, amp),
		roughLine(x + w, y + h, x, y + h, rand, amp),
		roughLine(x, y + h, x, y, rand, amp),
	].join(' ');
}

export function roughDiamond(x, y, w, h, rand, amp = 2.2) {
	const cx = x + w / 2, cy = y + h / 2;
	return [
		roughLine(cx, y, x + w, cy, rand, amp),
		roughLine(x + w, cy, cx, y + h, rand, amp),
		roughLine(cx, y + h, x, cy, rand, amp),
		roughLine(x, cy, cx, y, rand, amp),
	].join(' ');
}

export function roughEllipse(cx, cy, rx, ry, rand, amp = 2.2) {
	const wobble = amp / 2.2; // scale the default jitter proportionally
	const parts = [];
	for (let pass = 0; pass < 2; pass++) {
		const steps = 16;
		const start = rand() * Math.PI * 2;
		const pts = [];
		for (let i = 0; i <= steps; i++) {
			const t = start + (i / steps) * Math.PI * 2;
			pts.push([
				cx + Math.cos(t) * (rx + jitter(rand, Math.max(1.5, rx * 0.035) * wobble)),
				cy + Math.sin(t) * (ry + jitter(rand, Math.max(1.5, ry * 0.035) * wobble)),
			]);
		}
		let d = `M ${r2(pts[0][0])} ${r2(pts[0][1])}`;
		for (let i = 1; i < pts.length; i++) {
			const [px, py] = pts[i - 1];
			const [qx, qy] = pts[i];
			d += ` Q ${r2(px)} ${r2(py)}, ${r2((px + qx) / 2)} ${r2((py + qy) / 2)}`;
		}
		parts.push(d);
	}
	return parts.join(' ');
}

const r2 = (n) => Math.round(n * 100) / 100;
