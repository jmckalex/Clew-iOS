// Charts — the preview surface. The engine surface already did the thinking:
// every <div class="clew-chart"> carries a finished Chart.js configuration in
// data-chart. This file draws them with the chart.umd.js beside it, and keeps
// them alive across live re-renders:
//
//   - the <canvas> carries data-clew-keep, so a morph leaves it in place;
//   - an unchanged data-chart is left alone — no flicker, no restarted
//     animation while the note is edited around it;
//   - a changed one is destroyed and redrawn;
//   - label and grid colors come from the document's computed styles, so
//     charts follow the app theme and recolor when it changes.
(() => {
	'use strict';
	const scriptUrl = document.currentScript && document.currentScript.src;
	const live = new Map(); // canvas → { src, chart }
	let loading = false;

	// Chart.js loads on demand, from this plugin's own folder — a document
	// with no charts never pays for it.
	const ensureChartJs = () => {
		if (window.Chart) return true;
		if (!loading && scriptUrl) {
			loading = true;
			const tag = document.createElement('script');
			tag.src = new URL('chart.umd.js', scriptUrl).href;
			tag.onload = renderAll;
			document.head.append(tag);
		}
		return false;
	};

	const applyTheme = () => {
		const fg = getComputedStyle(document.body).color || 'rgb(200, 200, 200)';
		const rgb = fg.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)/);
		window.Chart.defaults.color = fg;
		window.Chart.defaults.borderColor =
			rgb ? `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, 0.15)` : fg;
	};

	const renderAll = () => {
		// Charts whose placeholder a morph removed die with it; tidy up.
		for (const [canvas, entry] of [...live]) {
			if (!canvas.isConnected) {
				try { entry.chart.destroy(); } catch (e) { /* already gone */ }
				live.delete(canvas);
			}
		}
		const divs = document.querySelectorAll('.clew-chart');
		if (!divs.length || !ensureChartJs()) return;
		applyTheme();
		for (const div of divs) renderOne(div);
	};

	const renderOne = (div) => {
		const src = div.getAttribute('data-chart') || '';
		const canvas = div.querySelector('canvas');
		const entry = canvas && live.get(canvas);
		if (entry && entry.src === src) return; // survived the morph unchanged
		if (entry) {
			try { entry.chart.destroy(); } catch (e) { /* already gone */ }
			live.delete(canvas);
		}
		let config;
		try { config = JSON.parse(src); } catch (e) { return; }
		const next = document.createElement('canvas');
		next.setAttribute('data-clew-keep', '');
		div.replaceChildren(next);
		try {
			live.set(next, { src, chart: new window.Chart(next, config) });
		} catch (e) {
			next.remove();
			const note = document.createElement('div');
			note.className = 'clew-query is-unsupported';
			note.setAttribute('data-clew-keep', '');
			note.textContent = 'Chart.js refused this chart: ' + e.message;
			div.replaceChildren(note);
		}
	};

	// The theme arrives as data-theme on <html>; recolor without re-animating.
	new MutationObserver(() => {
		if (!window.Chart) return;
		applyTheme();
		for (const [canvas, entry] of live) {
			if (canvas.isConnected) entry.chart.update('none');
		}
	}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

	document.addEventListener('clew:render', renderAll);
	renderAll();
})();
