// Charts — a Clew engine-surface plugin: the ```chart fence of Obsidian's
// Charts plugin, reimplemented from its documented YAML format
// (https://charts.phib.ro). The upstream plugin is AGPL and none of its
// source is used here — this file implements the format, drawing with the
// MIT-licensed Chart.js that sits beside it.
//
// The fence parses a small YAML subset, maps the documented modifiers onto a
// finished Chart.js configuration, and emits a placeholder
// <div class="clew-chart" data-chart="…"> carrying that configuration as
// JSON; preview.js (this plugin's preview surface) instantiates it in the
// rendered document.
//
// The Clew rule for other people's formats applies: what is unsupported is
// refused BY NAME. A chart that silently dropped its `stacked:` would be a
// wrong chart, which is worse than no chart. The one documented modifier
// refused outright is `time:` — date axes need a date adapter this plugin
// does not ship.
//
// Importing this module also registers `global.clewCharts`, the hook the
// engine's dataviewjs shim looks up so that renderChart(config, element) —
// the Charts plugin's dataviewjs bridge — turns a raw Chart.js configuration
// into the same placeholder. No plugin enabled, no hook: the call fails by
// name, like everything else there.

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- a YAML subset ---------------------------------------------------------
// Mappings, block sequences, flow sequences, and scalars — the shapes the
// documented chart blocks use. Anything else throws, and the fence renderer
// turns the throw into a named refusal.

export function parseChartYaml(text) {
	const lines = [];
	for (const raw of String(text).split('\n')) {
		if (!raw.trim() || /^\s*#/.test(raw)) continue;
		lines.push({ indent: raw.match(/^ */)[0].length, text: raw.trim() });
	}
	if (!lines.length) return {};
	const [value, next] = parseMapping(lines, 0, lines[0].indent);
	if (next !== lines.length) throw new Error(`unexpected line “${lines[next].text}”`);
	return value;
}

function parseMapping(lines, index, indent) {
	const out = {};
	let i = index;
	while (i < lines.length && lines[i].indent === indent && !lines[i].text.startsWith('- ')) {
		const m = /^([^:]+):(?:\s+(.*))?$/.exec(lines[i].text);
		if (!m) throw new Error(`“${lines[i].text}” is not “key: value”`);
		const key = unquote(m[1].trim());
		const rest = (m[2] ?? '').trim();
		if (rest) { out[key] = parseScalar(rest); i += 1; continue; }
		// A block value: the indented lines that follow — or, as YAML also
		// allows, a sequence whose dashes sit at the key's own indent.
		const child = lines[i + 1];
		if (child && (child.indent > indent
			|| (child.indent === indent && child.text.startsWith('- ')))) {
			const [value, next] = child.text.startsWith('- ')
				? parseSequence(lines, i + 1, child.indent)
				: parseMapping(lines, i + 1, child.indent);
			out[key] = value; i = next; continue;
		}
		out[key] = null; i += 1;
	}
	return [out, i];
}

function parseSequence(lines, index, indent) {
	const out = [];
	let i = index;
	while (i < lines.length && lines[i].indent === indent && lines[i].text.startsWith('- ')) {
		const rest = lines[i].text.slice(2).trim();
		if (/^[^:\s][^:]*:(\s|$)/.test(rest)) {
			// “- key: value” opens a mapping whose remaining keys are the
			// following lines indented past the dash.
			const own = [{ indent: indent + 2, text: rest }];
			let j = i + 1;
			while (j < lines.length && lines[j].indent > indent) { own.push(lines[j]); j += 1; }
			const [value] = parseMapping(own, 0, indent + 2);
			out.push(value); i = j; continue;
		}
		out.push(rest ? parseScalar(rest) : null);
		i += 1;
	}
	return [out, i];
}

function parseScalar(s) {
	if (s.startsWith('[')) return parseFlowSeq(s);
	const q = /^(['"])([\s\S]*)\1$/.exec(s);
	if (q) return q[2];
	// A trailing “ # …” is a comment; a leading # (an unquoted hex color) is not.
	const bare = s.split(/\s+#(?=\s|$)/)[0].trim();
	if (bare === 'true') return true;
	if (bare === 'false') return false;
	if (bare === 'null' || bare === '~') return null;
	if (/^-?\d+(\.\d+)?$/.test(bare)) return Number(bare);
	return bare;
}

function parseFlowSeq(s) {
	if (!/\]$/.test(s)) throw new Error(`“${s}” is an unclosed [list]`);
	const inner = s.slice(1, -1).trim();
	if (!inner) return [];
	const items = [];
	let depth = 0;
	let quote = null;
	let start = 0;
	for (let i = 0; i <= inner.length; i++) {
		const ch = inner[i];
		if (quote) { if (ch === quote) quote = null; continue; }
		if (ch === '"' || ch === '\'') { quote = ch; continue; }
		if (ch === '[') depth += 1;
		else if (ch === ']') depth -= 1;
		else if ((ch === ',' || i === inner.length) && depth === 0) {
			items.push(parseScalar(inner.slice(start, i).trim()));
			start = i + 1;
		}
	}
	return items;
}

const unquote = (s) => {
	const q = /^(['"])([\s\S]*)\1$/.exec(s);
	return q ? q[2] : s;
};

// ---- modifiers → a Chart.js configuration ----------------------------------

const TYPES = ['bar', 'line', 'pie', 'doughnut', 'radar', 'polarArea'];
const CIRCULAR = new Set(['pie', 'doughnut', 'polarArea']);
const RADIAL = new Set(['radar', 'polarArea']);
const CARTESIAN = new Set(['bar', 'line']);

// The palette Chart.js's own documentation made canonical — the colors an
// Obsidian chart-lover already expects.
const PALETTE = ['#ff6384', '#36a2eb', '#ffce56', '#4bc0c0', '#9966ff', '#ff9f40', '#8ac249', '#c9cbcf'];

const rgba = (hex, alpha) => {
	const n = parseInt(hex.slice(1), 16);
	return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const BOOLEANS = new Set(['fill', 'beginAtZero', 'spanGaps', 'legend', 'stacked',
	'xReverse', 'yReverse', 'xDisplay', 'yDisplay', 'xTickDisplay', 'yTickDisplay',
	'labelColors', 'bestFit']);
const NUMBERS = new Set(['tension', 'xMin', 'xMax', 'yMin', 'yMax', 'rMax',
	'transparency', 'bestFitNumber']);
const STRINGS = new Set(['type', 'width', 'legendPosition', 'indexAxis',
	'xTitle', 'yTitle', 'bestFitTitle']);
const KNOWN = new Set(['labels', 'series', ...BOOLEANS, ...NUMBERS, ...STRINGS]);
const REFUSED = new Map([
	['time', 'time axes need a date adapter this plugin does not ship'],
	['id', 'sourcing data from a table by id is not supported — put the data in `series:`'],
]);

export class ChartError extends Error {
	constructor(reasons) {
		super(reasons.join('; '));
		this.reasons = reasons;
	}
}

/** The documented block shape → { config, width }. Throws ChartError. */
export function buildChart(doc) {
	const errors = [];
	for (const key of Object.keys(doc)) {
		if (REFUSED.has(key)) errors.push(`\`${key}:\` — ${REFUSED.get(key)}`);
		else if (!KNOWN.has(key)) errors.push(`\`${key}:\` is not a chart option this plugin knows`);
		else if (BOOLEANS.has(key) && typeof doc[key] !== 'boolean') errors.push(`\`${key}:\` must be true or false`);
		else if (NUMBERS.has(key) && typeof doc[key] !== 'number') errors.push(`\`${key}:\` must be a number`);
		else if (STRINGS.has(key) && typeof doc[key] !== 'string') errors.push(`\`${key}:\` must be text`);
	}

	const type = doc.type;
	if (type === undefined) errors.push('every chart needs a `type:`');
	else if (typeof type === 'string' && !TYPES.includes(type)) {
		errors.push(`chart type “${type}” is not supported (${TYPES.join(', ')})`);
	}
	const labels = doc.labels ?? [];
	if (!Array.isArray(labels)) errors.push('`labels:` must be a list');
	let series = doc.series;
	if (!Array.isArray(series) || !series.length) {
		errors.push('`series:` must be a list of `- title:` / `data:` entries');
		series = [];
	} else {
		series.forEach((s, i) => {
			if (!s || typeof s !== 'object' || Array.isArray(s)) {
				errors.push(`series ${i + 1} is not a \`- title:\` / \`data:\` entry`);
				return;
			}
			for (const key of Object.keys(s)) {
				if (!['title', 'data'].includes(key)) {
					errors.push(`\`${key}:\` in series ${i + 1} is not a series option this plugin knows`);
				}
			}
			if (!Array.isArray(s.data)) errors.push(`series ${i + 1} has no \`data:\` list`);
		});
	}
	if (doc.legendPosition !== undefined && !['top', 'left', 'bottom', 'right'].includes(doc.legendPosition)) {
		errors.push('`legendPosition:` must be top, left, bottom or right');
	}
	if (doc.indexAxis !== undefined && !['x', 'y'].includes(doc.indexAxis)) {
		errors.push('`indexAxis:` must be x or y');
	}
	let width;
	if (doc.width !== undefined) {
		if (/^\d+(\.\d+)?(%|px|em|rem|vw)$/.test(doc.width)) width = doc.width;
		else errors.push('`width:` must be a CSS length like 80% or 400px');
	}
	if ((doc.bestFit === true || doc.bestFitNumber !== undefined || doc.bestFitTitle !== undefined)
		&& type !== 'line') {
		errors.push('`bestFit:` only applies to line charts');
	}
	if (errors.length) throw new ChartError(errors);

	const alpha = doc.transparency !== undefined ? Math.min(1, Math.max(0, doc.transparency)) : 0.25;
	// Circular charts color per slice; cartesian ones per series, unless
	// labelColors asks for per-point colors there too.
	const perPoint = CIRCULAR.has(type) || doc.labelColors === true;
	const pointColors = (of) => labels.map((_, j) => of(PALETTE[j % PALETTE.length]));
	const datasets = series.map((s, i) => {
		const hue = PALETTE[i % PALETTE.length];
		const ds = {
			label: s.title !== undefined ? String(s.title) : `Series ${i + 1}`,
			data: s.data,
			backgroundColor: perPoint ? pointColors((h) => rgba(h, alpha)) : rgba(hue, alpha),
			borderColor: perPoint ? pointColors((h) => h) : hue,
			borderWidth: 2,
		};
		if (type === 'line') {
			ds.tension = doc.tension ?? 0;
			ds.fill = doc.fill === true;
			if (doc.spanGaps === true) ds.spanGaps = true;
		}
		if (type === 'radar') ds.fill = doc.fill !== false;
		return ds;
	});
	if (doc.bestFit === true) {
		const source = datasets[Math.trunc(doc.bestFitNumber ?? 0)] ?? datasets[0];
		datasets.push({
			label: doc.bestFitTitle ?? 'Line of Best Fit',
			data: bestFitData(source.data),
			borderColor: PALETTE[datasets.length % PALETTE.length],
			borderWidth: 2,
			pointRadius: 0,
			fill: false,
			tension: 0,
		});
	}

	const options = { plugins: { legend: { display: doc.legend !== false, position: doc.legendPosition ?? 'top' } } };
	if (doc.indexAxis === 'y') options.indexAxis = 'y';
	if (CARTESIAN.has(type)) {
		const x = {};
		const y = {};
		if (doc.stacked === true) { x.stacked = true; y.stacked = true; }
		if (doc.beginAtZero === true) (doc.indexAxis === 'y' ? x : y).beginAtZero = true;
		if (doc.xReverse === true) x.reverse = true;
		if (doc.yReverse === true) y.reverse = true;
		if (doc.xMin !== undefined) x.min = doc.xMin;
		if (doc.xMax !== undefined) x.max = doc.xMax;
		if (doc.yMin !== undefined) y.min = doc.yMin;
		if (doc.yMax !== undefined) y.max = doc.yMax;
		if (doc.xDisplay === false) x.display = false;
		if (doc.yDisplay === false) y.display = false;
		if (doc.xTickDisplay === false) x.ticks = { display: false };
		if (doc.yTickDisplay === false) y.ticks = { display: false };
		if (doc.xTitle !== undefined) x.title = { display: true, text: doc.xTitle };
		if (doc.yTitle !== undefined) y.title = { display: true, text: doc.yTitle };
		if (Object.keys(x).length || Object.keys(y).length) options.scales = { x, y };
	} else if (RADIAL.has(type)) {
		const r = {};
		if (doc.rMax !== undefined) r.max = doc.rMax;
		if (doc.beginAtZero === true) r.beginAtZero = true;
		if (Object.keys(r).length) options.scales = { r };
	}

	return { config: { type, data: { labels, datasets }, options }, width };
}

function bestFitData(data) {
	const pts = data.map((y, x) => [x, Number(y)]).filter(([, y]) => Number.isFinite(y));
	const n = pts.length;
	if (n < 2) return data.map(() => null);
	const sx = pts.reduce((a, [x]) => a + x, 0);
	const sy = pts.reduce((a, [, y]) => a + y, 0);
	const sxx = pts.reduce((a, [x]) => a + x * x, 0);
	const sxy = pts.reduce((a, [x, y]) => a + x * y, 0);
	const slope = (n * sxy - sx * sy) / ((n * sxx - sx * sx) || 1);
	const intercept = (sy - slope * sx) / n;
	return data.map((_, x) => slope * x + intercept);
}

// ---- HTML ------------------------------------------------------------------

const chartHtml = (config, width) =>
	`<div class="clew-chart" data-chart="${escapeHtml(JSON.stringify(config))}"`
	+ (width ? ` style="width:${width};margin:0 auto"` : '') + `></div>\n`;

const refusalHtml = (reasons) =>
	`<div class="clew-query is-unsupported"><div class="clew-query-title">This chart was not rendered</div>`
	+ reasons.map((r) => `<div class="clew-query-note">${escapeHtml(r)}</div>`).join('')
	+ `</div>\n`;

// ---- the fence -------------------------------------------------------------

export const chartFence = {
	name: 'chartFence',
	level: 'block',
	start(src) { return src.match(/^```chart[ \t]*$/m)?.index; },
	tokenizer(src) {
		const match = /^```chart[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return undefined;
		return { type: 'chartFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		let doc;
		try { doc = parseChartYaml(token.text); }
		catch (err) { return refusalHtml([`the YAML did not parse: ${err.message}`]); }
		try {
			const { config, width } = buildChart(doc);
			return chartHtml(config, width);
		} catch (err) {
			return refusalHtml(err.reasons ?? [String(err.message ?? err)]);
		}
	},
};

// ---- the dataviewjs bridge -------------------------------------------------
// renderChart(config, element) hands over a RAW Chart.js configuration, so it
// bypasses the modifier mapping entirely — but it must survive the trip from
// the render worker to the preview document as JSON, and a config that can't
// make that trip is refused by naming the part that can't.

globalThis.clewCharts = {
	emit(config) {
		if (!config || typeof config !== 'object' || typeof config.type !== 'string') {
			throw new Error('renderChart expects a Chart.js configuration object ({ type, data, options })');
		}
		const offending = findUnserializable(config, 'config', new WeakSet());
		if (offending) {
			throw new Error(`${offending}, which cannot leave the render worker — charts travel as JSON; pass plain arrays and objects (call .array() on a DataArray)`);
		}
		return chartHtml(config);
	},
};

function findUnserializable(value, path, seen) {
	if (typeof value === 'function') return `${path} is a function`;
	if (!value || typeof value !== 'object') return null;
	if (seen.has(value)) return `${path} is circular`;
	seen.add(value);
	for (const [key, child] of Object.entries(value)) {
		const found = findUnserializable(child, `${path}.${key}`, seen);
		if (found) return found;
	}
	return null;
}
