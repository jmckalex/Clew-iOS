// Lazy MathJax for the APP window (canvas cards render engine HTML with raw
// $…$ / \(…\) math; note previews have their own MathJax via the template).
// Loaded once, on the first card that needs it, from the bundled assets the
// preview protocol already serves. tex-svg output: no webfonts to load.

let loading = null;

function load() {
	loading ??= new Promise((resolve, reject) => {
		// Config must exist before the script evaluates. Mirrors the engine's
		// default MathJax configuration (config-manager.js).
		window.MathJax = {
			tex: {
				inlineMath: [['$', '$'], ['\\(', '\\)']],
				displayMath: [['$$', '$$'], ['\\[', '\\]']],
				tags: 'ams',
			},
			startup: { typeset: false },
		};
		const script = document.createElement('script');
		script.src = 'clew-preview://vault/__clew_assets__/mathjax/tex-svg.js';
		script.onload = () => resolve();
		script.onerror = () => reject(new Error('MathJax failed to load'));
		document.head.append(script);
	});
	return loading;
}

/** Typeset math inside `el` (no-op if the element holds no math). */
export async function typesetMath(el) {
	if (!/\$|\\\(|\\\[/.test(el.textContent ?? '')) return;
	await load();
	await window.MathJax.startup.promise;
	await window.MathJax.typesetPromise([el]);
}
