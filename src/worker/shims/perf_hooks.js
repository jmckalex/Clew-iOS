// Node `perf_hooks` for the app page: what upstream's colon converter
// (main/colon-conversion.js) reads to report "main's event loop held at most
// … ms". On the iPad that loop is the page's own, the one the window draws
// on, so the figure matters more here, not less.
//
// monitorEventLoopDelay: Node samples how late a timer fires; so does this —
// an interval of `resolution` ms, each tick's lateness recorded. Values are
// in nanoseconds, as Node's histogram gives them.
export function monitorEventLoopDelay({ resolution = 10 } = {}) {
	const samples = [];
	let timer = null;
	let last = 0;
	let max = 0;
	return {
		enable() {
			if (timer) return true;
			last = performance.now();
			timer = setInterval(() => {
				const now = performance.now();
				const late = Math.max(0, now - last - resolution);
				samples.push(late);
				if (late > max) max = late;
				last = now;
			}, resolution);
			timer.unref?.(); // Node (the tests): never what keeps a process alive
			return true;
		},
		disable() {
			if (!timer) return false;
			clearInterval(timer);
			timer = null;
			return true;
		},
		get max() { return max * 1e6; },
		get count() { return samples.length; },
		percentile(p) {
			if (!samples.length) return 0;
			const sorted = [...samples].sort((a, b) => a - b);
			return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] * 1e6;
		},
		reset() { samples.length = 0; max = 0; },
	};
}

export const performance = globalThis.performance;

export default { monitorEventLoopDelay, performance };
