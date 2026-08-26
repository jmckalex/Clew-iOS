// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The Charts plugin (demo-vault/.clew/plugins/charts): the ```chart fence's
// YAML subset, the modifier → Chart.js mapping, the refusals-by-name, and the
// dataviewjs renderChart bridge.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseChartYaml, buildChart, chartFence, ChartError }
	from '../seed-vault/.clew/plugins/charts/engine.js';
import { renderDataviewJs } from '../vendor/clew/engine/dataview-js.js';
import { resetCache } from '../vendor/clew/engine/vault-model.js';

let root;

before(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-charts-'));
	fs.writeFileSync(path.join(root, 'Index.md'), 'The index.\n');
	process.env.CLEW_VAULT_ROOT = root;
	global.current_file = path.join(root, 'Index.md');
	resetCache();
});

after(() => {
	fs.rmSync(root, { recursive: true, force: true });
});

const FENCE = `type: bar
labels: [Monday, Tuesday, Wednesday]
series:
  - title: Grades
    data: [83, 95, 62]
  - title: Effort
    data: [30, 197, 12]
`;

// ---- YAML ------------------------------------------------------------------

test('parses the documented block shape', () => {
	const doc = parseChartYaml(FENCE);
	assert.equal(doc.type, 'bar');
	assert.deepEqual(doc.labels, ['Monday', 'Tuesday', 'Wednesday']);
	assert.equal(doc.series.length, 2);
	assert.deepEqual(doc.series[0], { title: 'Grades', data: [83, 95, 62] });
});

test('parses scalars, quotes, comments, and block sequences', () => {
	const doc = parseChartYaml(`type: "line"
# a full-line comment
width: 80%   # a trailing one
legend: false
tension: 0.4
labels:
  - One
  - 'Two, quoted'
series:
  - title: A
    data:
      - 1
      - -2.5
`);
	assert.equal(doc.type, 'line');
	assert.equal(doc.width, '80%');
	assert.equal(doc.legend, false);
	assert.equal(doc.tension, 0.4);
	assert.deepEqual(doc.labels, ['One', 'Two, quoted']);
	assert.deepEqual(doc.series[0].data, [1, -2.5]);
});

test('accepts sequences whose dashes sit at the key\'s indent', () => {
	const doc = parseChartYaml('type: pie\nlabels: [a, b]\nseries:\n- title: X\n  data: [1, 2]\n');
	assert.deepEqual(doc.series, [{ title: 'X', data: [1, 2] }]);
});

test('names the line it cannot parse', () => {
	assert.throws(() => parseChartYaml('type: bar\n!!weird\n'), /!!weird/);
});

// ---- the mapping -----------------------------------------------------------

test('maps a bar chart: series colors, transparency default', () => {
	const { config, width } = buildChart(parseChartYaml(FENCE));
	assert.equal(width, undefined);
	assert.equal(config.type, 'bar');
	assert.deepEqual(config.data.labels, ['Monday', 'Tuesday', 'Wednesday']);
	assert.equal(config.data.datasets.length, 2);
	assert.equal(config.data.datasets[0].label, 'Grades');
	assert.equal(config.data.datasets[0].backgroundColor, 'rgba(255, 99, 132, 0.25)');
	assert.equal(config.data.datasets[0].borderColor, '#ff6384');
	assert.equal(config.data.datasets[1].borderColor, '#36a2eb');
	assert.equal(config.options.plugins.legend.display, true);
});

test('stacked horizontal bar puts beginAtZero on the value axis', () => {
	const { config } = buildChart(parseChartYaml(
		'type: bar\nindexAxis: y\nstacked: true\nbeginAtZero: true\n'
		+ 'labels: [a]\nseries:\n  - title: A\n    data: [1]\n'));
	assert.equal(config.options.indexAxis, 'y');
	assert.equal(config.options.scales.x.stacked, true);
	assert.equal(config.options.scales.y.stacked, true);
	assert.equal(config.options.scales.x.beginAtZero, true);
	assert.equal(config.options.scales.y.beginAtZero, undefined);
});

test('circular charts color per slice; labelColors does it for bars', () => {
	const pie = buildChart(parseChartYaml(
		'type: pie\nlabels: [a, b, c]\nseries:\n  - title: A\n    data: [1, 2, 3]\n')).config;
	assert.equal(pie.data.datasets[0].backgroundColor.length, 3);
	assert.deepEqual(pie.data.datasets[0].borderColor.slice(0, 2), ['#ff6384', '#36a2eb']);
	const bar = buildChart(parseChartYaml(
		'type: bar\nlabelColors: true\nlabels: [a, b]\nseries:\n  - title: A\n    data: [1, 2]\n')).config;
	assert.equal(bar.data.datasets[0].backgroundColor.length, 2);
});

test('transparency, axis titles, bounds, and width pass through', () => {
	const { config, width } = buildChart(parseChartYaml(
		'type: line\ntransparency: 0.6\nxTitle: Day\nyMin: 0\nyMax: 10\nwidth: 400px\n'
		+ 'labels: [a]\nseries:\n  - title: A\n    data: [1]\n'));
	assert.equal(width, '400px');
	assert.equal(config.data.datasets[0].backgroundColor, 'rgba(255, 99, 132, 0.6)');
	assert.deepEqual(config.options.scales.x.title, { display: true, text: 'Day' });
	assert.equal(config.options.scales.y.min, 0);
	assert.equal(config.options.scales.y.max, 10);
});

test('bestFit appends the regression line', () => {
	const { config } = buildChart(parseChartYaml(
		'type: line\nbestFit: true\nbestFitTitle: Trend\n'
		+ 'labels: [a, b, c]\nseries:\n  - title: A\n    data: [1, 3, 5]\n'));
	assert.equal(config.data.datasets.length, 2);
	const fit = config.data.datasets[1];
	assert.equal(fit.label, 'Trend');
	assert.deepEqual(fit.data.map((v) => Math.round(v * 1000) / 1000), [1, 3, 5]);
});

test('refusals are by name, and they accumulate', () => {
	const boom = (yaml) => {
		try { buildChart(parseChartYaml(yaml)); }
		catch (err) { assert.ok(err instanceof ChartError); return err.reasons.join('\n'); }
		assert.fail('should have refused');
	};
	assert.match(boom('type: sankey\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n'),
		/“sankey” is not supported/);
	assert.match(boom('type: line\ntime: month\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n'),
		/`time:` — time axes need a date adapter/);
	assert.match(boom('type: bar\nbanana: true\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n'),
		/`banana:` is not a chart option/);
	assert.match(boom('type: bar\nlabels: [a]\nseries:\n  - title: A\n    color: red\n    data: [1]\n'),
		/`color:` in series 1/);
	assert.match(boom('type: bar\nwidth: 80%;url(x)\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n'),
		/`width:` must be a CSS length/);
	assert.match(boom('type: bar\nbestFit: true\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n'),
		/`bestFit:` only applies to line charts/);
	const many = boom('type: nope\nbanana: 1\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n');
	assert.match(many, /“nope” is not supported/);
	assert.match(many, /`banana:`/);
});

// ---- the fence -------------------------------------------------------------

test('tokenizer claims ```chart and nothing else', () => {
	const src = '```chart\n' + FENCE + '```\n';
	assert.equal(chartFence.start(src), 0);
	const token = chartFence.tokenizer(src);
	assert.equal(token.type, 'chartFence');
	assert.equal(token.raw, src);
	assert.match(token.text, /^type: bar/);
	assert.equal(chartFence.start('```charts\nnope\n```\n'), undefined);
	assert.equal(chartFence.tokenizer('```charts\nnope\n```\n'), undefined);
});

test('renderer emits the placeholder div, escaped', () => {
	const html = chartFence.renderer({ text: FENCE });
	assert.match(html, /^<div class="clew-chart" data-chart="/);
	assert.match(html, /&quot;type&quot;:&quot;bar&quot;/);
	assert.doesNotMatch(html, /data-chart="[^"]*"[^>]*data-chart/);
	const sized = chartFence.renderer({ text: FENCE + 'width: 50%\n' });
	assert.match(sized, /style="width:50%;margin:0 auto"/);
});

test('renderer refuses by name and yields nothing for LaTeX', () => {
	const html = chartFence.renderer({ text: 'type: bar\ntime: day\nlabels: [a]\nseries:\n  - title: A\n    data: [1]\n' });
	assert.match(html, /This chart was not rendered/);
	assert.match(html, /date adapter/);
	global.isLatex = true;
	try { assert.equal(chartFence.renderer({ text: FENCE }), ''); }
	finally { delete global.isLatex; }
});

// ---- the dataviewjs bridge -------------------------------------------------

const CONFIG = `{ type: 'bar', data: { labels: ['a'], datasets: [{ label: 'X', data: [1] }] } }`;

test('renderChart lands the same placeholder, however it is reached', () => {
	for (const call of ['renderChart', 'window.renderChart', 'dv.renderChart']) {
		const html = renderDataviewJs(`${call}(${CONFIG}, this.container);`);
		assert.match(html, /<div class="clew-chart" data-chart="/, call);
		assert.match(html, /&quot;type&quot;:&quot;bar&quot;/, call);
	}
});

test('a config that cannot leave the worker is refused by name', () => {
	const html = renderDataviewJs(
		`renderChart({ type: 'bar', data: {}, options: { animation: () => {} } }, this.container);`);
	assert.match(html, /did not finish/);
	assert.match(html, /config\.options\.animation is a function/);
	assert.match(renderDataviewJs(`renderChart('bar', this.container);`),
		/expects a Chart\.js configuration/);
});

test('without the plugin, renderChart fails by name', () => {
	const hook = globalThis.clewCharts;
	delete globalThis.clewCharts;
	try {
		const html = renderDataviewJs(`renderChart(${CONFIG}, this.container);`);
		assert.match(html, /renderChart is not available in Clew — the Charts plugin is not enabled/);
	} finally {
		globalThis.clewCharts = hook;
	}
});

test('the container is passable but not usable; window names its gaps', () => {
	assert.match(renderDataviewJs('dv.container.appendChild(1);'),
		/container\.appendChild is not available/);
	assert.match(renderDataviewJs('window.moment();'),
		/window\.moment is not available/);
});
