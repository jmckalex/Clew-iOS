export function debounce(fn, wait) {
	let timer = null;
	let lastArgs = [];
	const debounced = (...args) => {
		lastArgs = args;
		clearTimeout(timer);
		timer = setTimeout(() => { timer = null; fn(...lastArgs); }, wait);
	};
	/** Run a pending call immediately (no-op when nothing is pending). */
	debounced.flush = () => {
		if (timer !== null) { clearTimeout(timer); timer = null; fn(...lastArgs); }
	};
	debounced.cancel = () => { clearTimeout(timer); timer = null; };
	debounced.pending = () => timer !== null;
	return debounced;
}
