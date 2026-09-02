---
target: 2
tags:
  - guide
---
# Dashboards

The pieces documented elsewhere — [[Queries|queries]], [[Charts|charts]],
[[Widgets|widgets]], and dataviewjs — are good alone, but the point of
keeping data *in your notes* is what happens when you combine them: a
**dashboard** is just a note whose blocks compute views of the vault.
And because notes holding queries re-render whenever any file changes,
a dashboard is live: edit a note anywhere and every number, table, and
chart follows.

This page builds one from the demo vault's own data, then walks through
a real-world recipe — tracking a folder of essays through marking.

## The pattern: notes as rows

Give each thing you track its own note, and put the trackable facts in
frontmatter. The `Projects/` folder here does exactly that — each
project note carries `status`, `priority`, and `due`. That is the whole
data model. No database, no export: the notes *are* the rows, and
everything below is a view of them.

## Reading: two query languages

Clew's own ` ```query ` fence, with **editable cells** — click a value,
type, press Enter, and it lands in that note's frontmatter:

```query
table: status, priority, due
from: Projects
sort: priority asc
```

And Dataview DQL, for grouping and expressions (see
[[Obsidian Compatibility]] for how much of Dataview Clew runs):

```dataview
TABLE WITHOUT ID rows.file.link AS Notes
FROM "Projects"
WHERE status
GROUP BY status
```

## Writing: widgets and drags

Reading a dashboard is half the job; the other half is pushing values
*back*. Three write paths, all landing in frontmatter, all documented
on their own pages:

- **Widgets** ([[Widgets]]): this page's own target —
  INPUT[number:target] — is bound to this note's `target` property.
  Widgets inside an item's note edit that item where you read it.
- **Editable query cells** ([[Queries]]): the tables above.
- **Kanban drags** ([[Queries]]): a ` ```kanban ` grouped by a field
  rewrites it when you drag a card to another column.

## Computing: dataviewjs and charts

When a view needs actual logic — counting, binning, arithmetic — a
` ```dataviewjs ` block runs JavaScript against the vault index:
`dv.pages()` for the rows, `dv.table`, `dv.list` and `dv.paragraph`
for output, and `renderChart(config)` for a live
[Chart.js](https://www.chartjs.org/docs/latest/) chart. This one reads
the same `Projects/` notes and, together with the widget above, closes
the loop — it reads this page's own `target` property, so change the
widget and the chart's title line follows:

```dataviewjs
const projects = dv.pages().values.filter(p => String(p.file.folder).startsWith('Projects'));
const active = projects.filter(p => p.status === 'active').length;
const target = dv.current().target ?? 1;
dv.paragraph(active >= target
	? `${active} active projects — at or over the target of ${target}.`
	: `${active} active projects of a target of ${target}.`);
const byStatus = {};
for (const p of projects) {
	if (p.status) byStatus[p.status] = (byStatus[p.status] ?? 0) + 1;
}
renderChart({
	type: 'doughnut',
	data: {
		labels: Object.keys(byStatus),
		datasets: [{
			data: Object.values(byStatus),
			backgroundColor: ['rgba(96,130,220,0.6)', 'rgba(75,192,130,0.6)', 'rgba(200,120,90,0.6)'],
			borderWidth: 0,
		}],
	},
	options: { aspectRatio: 2.5 },
}, this.container);
```

Two per-vault switches make this block work: **dataviewjs** must be
enabled (Settings → This vault) because it runs arbitrary code, and
the **Charts plugin** must be in the vault's `.clew/plugins/` and
enabled — both are, here. Configurations cross to the preview as JSON,
so pass plain arrays and objects; a config carrying a function is
refused by name.

## A worked recipe: marking essays

The pattern scales to real work. Suppose a folder of essays to mark —
one note per essay, the PDF embedded in it, and frontmatter tracking
the marking state:

````
---
assessment: AT
participant: "6872779"
question: Q3
marked: false
grade:
marked-on:
tags:
  - essay
---
Question: INPUT[inlineSelect(option(Q1), option(Q2), option(Q3), option(Q4)):question] ·
Marked: INPUT[toggle:marked] · Grade: INPUT[number:grade]

![[Attachments/6872779.pdf]]
````

Marking an essay is then: read the embedded PDF, write feedback in the
note, set the widgets. The dashboard beside it:

**The queue** — unmarked essays, cells editable for sweeping fixes:

````
```query
table: question, marked, grade
tag: #essay
where: marked = false
sort: name asc
```
````

**Batching by question** — mark all the Q2 essays in one sitting; a
kanban grouped on `question` lets you (re)assign by drag:

````
```dataview
TABLE WITHOUT ID rows.file.link AS Essays, rows.grade AS Grades
FROM #essay
WHERE marked AND question
GROUP BY question
```
````

**Progress against a daily target** — a widget holds the target on the
dashboard itself (`INPUT[number:target]`), each essay's `marked-on`
records the day it was done, and dataviewjs counts today's:

````
```dataviewjs
const essays = dv.pages('#essay').values;
const today = new Date().toLocaleDateString('en-CA');
const done = essays.filter(p => String(p['marked-on']).slice(0, 10) === today).length;
const target = dv.current().target ?? 5;
dv.paragraph(`Marked today: ${done} of ${target}.`);
```
````

**The mark distribution** — bin the grades and hand them to
`renderChart` as a bar chart; add one dataset per cohort to compare
them. The same shape draws a pace chart (essays per `marked-on` day)
and a doughnut of which questions the cohort chose.

Every one of those views updates the moment a toggle flips in any
essay note — the queue shrinks, the bars move, the day's count ticks
up. The full working version of this recipe (built from a real
cohort's Moodle folder) has notes shaped exactly like the template
above; ask Claude to generate the notes from a grades CSV, or write
them by hand from [[Daily Notes and Templates|a template]].

## The habits that keep a dashboard honest

- **One fact, one place.** A value lives in one note's frontmatter;
  every view computes from it. If a number on the dashboard is wrong,
  fix the note, not the dashboard.
- **Refusals are visible by design.** A query or chart that cannot run
  says so by name rather than showing half an answer.
- **Dashboards are plain notes.** They travel with the vault, work
  offline, diff cleanly in git, and open in Obsidian (which will show
  the fences it lacks plugins for as code blocks — nothing breaks).
