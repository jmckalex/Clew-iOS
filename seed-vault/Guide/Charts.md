---
tags: [guide]
---
# Charts

A ` ```chart ` fence turns a small block of YAML into a live chart —
the format of Obsidian's Charts plugin, reimplemented for Clew and drawn
with Chart.js. It comes from the **Charts** plugin this vault ships and
enables (Settings → This vault); in a vault without it, the fence is
just a code block.

````
```chart
type: bar
labels: [Monday, Tuesday, Wednesday]
series:
  - title: Grades
    data: [83, 95, 62]
```
````

`type` is one of **bar, line, pie, doughnut, radar, polarArea**;
`labels` names the points; each series is a title and its data. Charts
follow the app theme, and live re-renders leave an unchanged chart
alone — edit the prose around one and it does not even blink.

## Bar

```chart
type: bar
labels: [Monday, Tuesday, Wednesday, Thursday, Friday]
series:
  - title: Grades
    data: [83, 95, 62, 88, 74]
  - title: Effort
    data: [30, 97, 12, 60, 44]
```

Turn it sideways and pile the series up with `indexAxis: y` and
`stacked: true`:

```chart
type: bar
indexAxis: y
stacked: true
beginAtZero: true
width: 80%
labels: [Reading, Writing, Errands]
series:
  - title: Morning
    data: [2, 1, 0.5]
  - title: Afternoon
    data: [1, 3, 1]
```

## Line

Lines take `tension` (0 is straight, towards 1 is curved), `fill` for
the area beneath, and `bestFit: true` for a least-squares trend line:

```chart
type: line
tension: 0.3
fill: true
bestFit: true
bestFitTitle: Trend
beginAtZero: true
xTitle: Week
yTitle: Pages read
labels: [1, 2, 3, 4, 5, 6]
series:
  - title: Pages
    data: [12, 20, 15, 32, 28, 40]
```

## Pie and friends

Circular charts — `pie`, `doughnut`, `polarArea` — color each slice;
`radar` fills each series. On a bar or line chart, `labelColors: true`
switches to per-point colors too.

```chart
type: doughnut
width: 60%
labels: [Notes, Attachments, Canvases, Drawings]
series:
  - title: Files
    data: [44, 21, 3, 2]
```

```chart
type: radar
width: 70%
rMax: 10
labels: [Speed, Range, Charm, Stealth, Appetite]
series:
  - title: Heron
    data: [7, 9, 4, 6, 8]
  - title: Cat
    data: [6, 2, 9, 9, 10]
```

## The modifiers

| Modifier | Does |
|---|---|
| `width` | CSS width for the chart (`80%`, `400px`); it centers itself |
| `transparency` | opacity of the fill colors, 0–1 (default 0.25) |
| `legend`, `legendPosition` | show the legend; `top`, `left`, `bottom`, `right` |
| `indexAxis` | `y` for horizontal bars |
| `stacked` | stack bar/line series |
| `beginAtZero` | force the value axis to start at 0 |
| `fill`, `tension`, `spanGaps` | line charts: area fill, curve, bridge missing points |
| `bestFit`, `bestFitTitle`, `bestFitNumber` | line charts: a least-squares trend line |
| `xTitle`/`yTitle` | axis titles |
| `xMin`/`xMax`/`yMin`/`yMax`, `rMax` | axis bounds (`rMax` for radar/polar) |
| `xReverse`/`yReverse` | flip an axis |
| `xDisplay`/`yDisplay`, `xTickDisplay`/`yTickDisplay` | hide an axis or its ticks |
| `labelColors` | per-point colors on bar/line charts |

What the plugin does not support it refuses **by name** rather than
half-drawing — a chart that silently dropped its `stacked:` would be a
wrong chart, which is worse than no chart. This one asks for a `time:`
axis, which needs a date adapter the plugin does not ship:

```chart
type: line
time: month
labels: [Jan, Feb]
series:
  - title: A
    data: [1, 2]
```

## Charts from dataviewjs

With dataviewjs enabled (it is in this vault — see the per-vault
settings), scripts get the Charts plugin's `renderChart(config,
element)`: a raw [Chart.js configuration](https://www.chartjs.org/docs/latest/)
in, a chart in the output. This one counts the vault's notes by top
folder:

```dataviewjs
const folders = {};
for (const p of dv.pages()) {
	const top = p.file.folder ? p.file.folder.split('/')[0] : '(vault root)';
	folders[top] = (folders[top] ?? 0) + 1;
}
renderChart({
	type: 'bar',
	data: {
		labels: Object.keys(folders),
		datasets: [{
			label: 'Notes',
			data: Object.values(folders),
			backgroundColor: 'rgba(75, 192, 192, 0.4)',
			borderColor: '#4bc0c0',
			borderWidth: 2,
		}],
	},
}, this.container);
```

The configuration crosses from the render worker to the preview as
JSON, so it must be plain data — a config carrying a function is
refused, naming the part that cannot make the trip.
