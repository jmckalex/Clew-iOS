// M1: the jmarkdown engine, bundled for a Web Worker with the Node shims,
// renders real demo-vault notes. Each case spawns tools/render-note.mjs in
// a child process (the bundle installs its own `process` global, which must
// not clobber the test runner's) and asserts on the emitted HTML.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const renderIn = (vault, note, ...flags) => execFileSync(
	process.execPath, [path.join(root, 'tools', 'render-note.mjs'), vault, note, ...flags],
	{ encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const render = (note, ...flags) => renderIn(path.join(root, 'seed-vault'), note, ...flags);

/** Collapse the pretty-printed HTML so assertions can span its line breaks. */
const flat = (html) => html.replace(/\s+/g, ' ');

test('worker bundle exists (run scripts/build.js first)', () => {
	assert.ok(fs.existsSync(path.join(root, 'dist', 'engine-worker.js')));
});

test('Welcome.md: full document with resolved wikilinks and source lines', () => {
	const html = render('Welcome.md');
	assert.match(html, /<!DOCTYPE html>/i);
	assert.match(html, /class="internal-link" href="#" data-href="Editing"/);
	assert.match(html, /data-source-line="\d+"/);
	assert.ok(!html.includes('internal-link unresolved'), 'no unresolved links in the demo vault hub');
});

test('dialect: /italics/, *strong*, **intense**, ==highlight== render', () => {
	const html = render('Projects/Dialect Demo.md');
	assert.match(html, /<em[^>]*>italics<\/em>/);
	assert.match(html, /<strong[^>]*>strong<\/strong>/);
	assert.match(html, /class="intense">intense/);
	assert.match(html, /class="highlight">highlighted/);
	// Math survives marked untouched, for browser-side MathJax.
	assert.ok(html.includes('e^{i\\pi}+1=0'));
});

test('citations: citation-js resolves \\cite forms and the bibliography (chicago, from the note header)', () => {
	// Before citation-js was in the worker's require registry, every cite
	// rendered as an empty <span> and the bibliography as an empty <div>.
	const html = flat(render('Features/Citations.md'));
	assert.match(html, /A plain citation <span[^>]*>Lewis \(1969\)<\/span>/);
	assert.match(html, /<span[^>]*>\(Skyrms 1996\)<\/span>/);
	assert.match(html, /<span[^>]*>\(Maynard Smith and Price 1973, p\. ?17\)<\/span>/);
	// chicago is one of the engine's five bundled CSL files (/engine/csl/).
	assert.match(html, /class="csl-bib-body biblify-chicago-template"/);
	assert.match(html, /class="csl-entry">Lewis, David\. 1969\. <i>Convention: A Philosophical Study<\/i>/);
	assert.ok(!html.includes('<span class="biblify-cite" data-cite-cmd="\\cite{lewis1969}"></span>'), 'no unresolved placeholder');
});

test('citations: a vault-wide bibliography in a bundled CSL style (ajp)', () => {
	const html = flat(render('Projects/Dialect Demo.md',
		'--vault-options', JSON.stringify({ bibliography: 'Features/refs.bib', bibliographyStyle: 'ajp' })));
	assert.match(html, /<span[^>]*data-bibtex="alexander2023"[^>]*>Alexander \(2023\)<\/span>/);
	assert.match(html, /class="csl-bib-body biblify-ajp-template"/);
	assert.match(html, /class="csl-entry">Alexander, J McKenzie \(2023\) <i>The Open Society as an Enemy<\/i>/);
});

test('query fences scan the vault at render time', () => {
	const html = render('Features/Queries.md');
	assert.match(html, /clew-query/);
	assert.match(html, /<table/);
});

test('embeds: media embeds and block transclusion markup', () => {
	assert.match(render('Guide/Links and Embeds.md'), /internal-media/);
	assert.match(render('Welcome.md'), /internal-embed|internal-media/);
});

test('fragment mode: body-only render (canvas cards)', () => {
	const html = render('Welcome.md', '--fragment');
	assert.ok(!/<!DOCTYPE html>/i.test(html), 'fragment has no document shell');
	assert.match(html, /internal-link/);
});

// ---- upstream 0.8 arcs, through the real worker bundle + registry ----------
// The upstream suites cover these modules directly; what only this repo can
// check is that the four new extensions are actually REACHED — that the
// generated config names them and the worker's __jmdExtensionRegistry answers.
// Every one of these rendered as plain markdown before the registry entries
// landed, silently and with no error anywhere.

test('callouts: > [!type] becomes a typed box, foldables become <details>', () => {
	const html = render('Guide/Callouts.md');
	const types = [...html.matchAll(/data-callout="([a-z]+)"/g)].map((m) => m[1]);
	assert.ok(types.length >= 10, `expected the whole callout family, saw ${types.length}`);
	assert.ok(types.includes('note') && types.includes('warning') && types.includes('quote'));
	// `-` starts collapsed, `+` starts expanded; both are native <details>, so
	// folding survives a re-render and an exported site with no JavaScript.
	assert.match(html, /<details class="callout[^"]*is-collapsible"[^>]*data-callout="question"/);
	assert.match(html, /<details[^>]*data-callout="example"[^>]*open=""/);
	// No leftover blockquote carrying the raw marker.
	assert.ok(!/<p[^>]*>\s*\[!note\]/.test(html), 'the [!note] marker was consumed');
});

test('block refs: anchors emit ids and ![[Note#^id]] transcludes the block', () => {
	const html = flat(render('Guide/Links and Embeds.md'));
	assert.match(html, /<span class="block-anchor" id="\^what-a-block-ref-is" data-block-id="what-a-block-ref-is">/);
	// The transclusion is resolved by the ENGINE, not the preview client: the
	// referenced paragraph's own text has to be inside the embed.
	assert.match(html, /class="internal-embed" data-href="Links and Embeds#\^what-a-block-ref-is"/);
	assert.match(html, /<div class="embed-content">\s*<p[^>]*>A heading link points at a section/);
});

test('dataview: a TABLE query scans the vault and resolves links', () => {
	const html = flat(render('Features/Queries.md'));
	assert.match(html, /class="clew-query clew-dataview">\s*<thead>/);
	// Real rows from real notes — an empty table would also match a <table>.
	assert.match(html, /clew-dataview">.*?<a class="internal-link" href="#" data-href="Projects\/Clew Design"/);
	assert.match(html, /data-edit-path="Projects\/Clew Design\.md" data-edit-field="status"/);
});

test('bases: a ```base fence renders the view with its display names', () => {
	const html = flat(render('Features/Queries.md'));
	assert.match(html, /class="clew-query clew-base">\s*<thead>/);
	// `displayName: Project` from the fence's YAML, not the raw property name.
	assert.match(html, /clew-base">.*?<th>Project<\/th>/);
});

test('dataviewjs is gated per vault, and executes when the vault opts in', (t) => {
	// `new Function` inside the worker bundle — the one portability question
	// the audit could not settle from reading. (The worker already runs
	// vm.runInThisContext as indirect eval, gated by the same CSP class.)
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-dvjs-'));
	t.after(() => fs.rmSync(vault, { recursive: true, force: true }));
	fs.writeFileSync(path.join(vault, 'Run.md'),
		'# Run\n\n```dataviewjs\ndv.paragraph("DVJS-RAN:" + (2 + 3));\n```\n');

	const off = renderIn(vault, 'Run.md');
	assert.ok(!off.includes('DVJS-RAN:5'), 'must not run without the vault opt-in');
	assert.match(off, /dataviewjs is not run in this vault/);

	const on = renderIn(vault, 'Run.md', '--vault-options', '{"dataviewJs":true}');
	assert.match(on, /DVJS-RAN:5/);
});

test('a plugin ENGINE surface loads from the vault snapshot (charts)', () => {
	// The one render path unit tests cannot reach: the config names the
	// plugin by absolute vault path, the snapshot carries its source, and
	// the worker imports it at runtime (__jmdImportSource → blob/data URL).
	// The harness reads seed-vault's own vault-settings, so this render runs
	// exactly the config the app ships with — charts enabled.
	const html = flat(render('Guide/Charts.md'));
	assert.match(html, /<div class="clew-chart" data-chart="/);
	// Six charts: five ```chart fences plus the dataviewjs renderChart one —
	// the bridge through global.clewCharts only exists because the plugin
	// module actually executed in the worker.
	assert.ok((html.match(/<div class="clew-chart"/g) ?? []).length >= 6,
		'expected all six charts, fences and renderChart alike');
	// Disabled ⇒ the fence must fall back to a plain code block, not crash.
	const off = render('Guide/Charts.md', '--vault-options', '{}');
	assert.ok(!off.includes('clew-chart'), 'no placeholders without the plugin');
	assert.match(off, /language-chart/);
});

test('a kanban-plugin board note renders as a board', () => {
	const html = flat(render('Features/Project Board.md'));
	assert.match(html, /clew-kanban clew-kanban-note/);
	// Cards keep their true source lines — the checkbox write path.
	assert.match(html, /data-source-line="\d+"[^>]*data-source-path="Features\/Project Board\.md"|data-task-path|type="checkbox"/);
});

// ---- the live-edit sync: @reveal and TeX fragments through the worker -----

test('@reveal[…]: the Environments registry entry serves a vault deck as an iframe', () => {
	const html = flat(render('Guide/Links and Embeds.md'));
	// The seed vault's demo deck (Attachments/demo-deck/index.html): a
	// folder target resolves to its index, session-scoped like every vault
	// URL, with the author's height.
	assert.match(html, /<iframe class="reveal-embed"[^>]*src="[^"]*Attachments\/demo-deck\/index\.html"/);
	assert.match(html, /height:\s*260px/);
	// Not in the vault → refused BY NAME, never a blank frame.
	const vault = fs.mkdtempSync(path.join(os.tmpdir(), 'clew-reveal-'));
	fs.writeFileSync(path.join(vault, 'Deck.md'), '# Deck\n\n@reveal[Talks/nowhere]\n');
	const missing = renderIn(vault, 'Deck.md');
	assert.ok(!missing.includes('<iframe'), 'no frame for a target that is not there');
	assert.match(missing, /nowhere/);
	fs.rmSync(vault, { recursive: true, force: true });
});

test('TeX fragments: CLEW_TEX_FRAGMENTS reaches figures.js — the vault list, the global list, and the refusal', () => {
	// The seed vault's Diagrams note asks for `math macros` (a ```latex
	// snippet) and `math macros, diagram colours` (a ```tikz); its
	// vault-settings.json defines both, so with the harness's default
	// options the fragments' text lands in the figures' preambles.
	const html = flat(render('Features/Diagrams.md'));
	assert.match(html, /newcommand\{\\R\}\{\\mathbb\{R\}\}/, 'the vault fragment reached a figure');
	assert.match(html, /definecolor\{clewink\}/, 'and the second one');
	assert.ok(!html.includes('clew-figure-refused'), 'nothing refused when every name is defined');
	// No fragments anywhere: refused by name, in place, everything else renders.
	const bare = flat(render('Features/Diagrams.md', '--vault-options', '{}'));
	assert.match(bare, /clew-figure-refused[^<]*TeX fragment not defined here: “math macros”/);
	assert.match(bare, /TeX fragments not defined here: “math macros”, “diagram colours”/);
	assert.ok(!bare.includes('definecolor{clewink}'));
	// The global scope alone satisfies both — the env carries both lists and
	// tex-fragments.js resolves them (a vault fragment would shadow it).
	const globals = JSON.stringify([
		{ name: 'Math Macros', text: '\\newcommand{\\R}{\\mathbb{R}}\\newcommand{\\E}{\\mathbb{E}}\\DeclareMathOperator*{\\argmax}{arg\\,max}' },
		{ name: 'diagram colours', text: '\\definecolor{clewink}{HTML}{6C5CE7}' },
	]);
	const viaGlobal = flat(render('Features/Diagrams.md', '--vault-options', '{}', '--global-fragments', globals));
	assert.ok(!viaGlobal.includes('clew-figure-refused'), 'the global list is consulted (case-insensitive names)');
	assert.match(viaGlobal, /definecolor\{clewink\}/);
});
