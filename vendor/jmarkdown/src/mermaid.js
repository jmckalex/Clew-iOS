// Mermaid diagrams. In HTML they render client-side (mermaid.js in the browser).
// For print there is no LaTeX-native mermaid, so we rasterise each diagram to a
// cached PDF with the mermaid CLI (mmdc) and \includegraphics it. mmdc is an
// optional, heavy tool (it drives a headless browser); when it isn't available
// the diagram is skipped with a one-line hint rather than breaking the build.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync, execSync } from 'child_process';
import { configManager } from './config-manager.js';
import { requirePackage } from './preamble.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { addWarning } from './warnings.js';
import { texCachePath, escapeLatexPath } from './latex-graphics.js';

// Run mmdc without a shell where a shell is the danger: the paths are under the
// document's own folder, whose name is the document's to choose, and a POSIX
// shell expands `$(…)` or a backtick even inside double quotes. On Windows mmdc
// is an npm .cmd shim that only a shell can start, and there cmd.exe's double
// quotes make & | < > literal and no file name can hold a `"` — so a quoted
// string, as before.
// stderr is kept (on the error) so a failure can say why.
function runMmdc(file, args) {
	const stdio = ['ignore', 'ignore', 'pipe'];
	if (process.platform === 'win32') {
		execSync([file, ...args].map(a => `"${a}"`).join(' '), { stdio });
	}
	else {
		execFileSync(file, args, { stdio });
	}
}

// A diagram named in a warning by its first line, so it can be found in a
// single file, where warnings carry no line (a book's carry chapter:line).
function diagramName(source) {
	const first = source.split('\n').map(s => s.trim()).find(Boolean) || '';
	return `"${first.length > 40 ? first.slice(0, 39) + '…' : first}"`;
}

// Why mmdc failed: the first line of its own complaint, else the error's, cut
// back to its last whole sentence when it breaks off mid-sentence (puppeteer's
// "Could not find Chrome" does).
function mmdcReason(error) {
	const lines = `${error.stderr || ''}\n${error.message || error}`.split('\n').map(s => s.trim());
	let line = (lines.find(l => l && !/^Command failed/.test(l)) || 'unknown error').replace(/^Error:\s*/, '');
	const cut = line.lastIndexOf('. ');
	if (!/[.!?)]$/.test(line) && cut > 0) line = line.slice(0, cut + 1);
	return line;
}

// Locate mmdc once: a locally-installed mermaid-cli first, then one on PATH.
// null means "not available" (skip mermaid in LaTeX).
let mmdcResolved = false;
let mmdcPath = null;
function getMmdc() {
	if (mmdcResolved) return mmdcPath;
	mmdcResolved = true;
	const appDir = configManager.get('Jmarkdown app directory') || '';
	const candidates = [path.join(appDir, '..', 'node_modules', '.bin', 'mmdc'), 'mmdc'];
	for (const candidate of candidates) {
		try {
			runMmdc(candidate, ['--version']);
			mmdcPath = candidate;
			break;
		} catch { /* try the next candidate */ }
	}
	return mmdcPath;
}

// Render a mermaid diagram for LaTeX: a cached PDF via mmdc, embedded with
// \includegraphics. Returns '' when mmdc is unavailable or fails, with a build
// warning naming the diagram (it was a console line, easily missed, and the
// diagram simply vanished from the PDF).
function renderMermaidLatex(source) {
	const mmdc = getMmdc();
	if (!mmdc) {
		addWarning(`mermaid: ${diagramName(source)} left out of the LaTeX — mermaid-cli (mmdc) was not found; install @mermaid-js/mermaid-cli to render mermaid for print`);
		return '';
	}
	const dir = path.join(configManager.get('Markdown file directory'), 'mermaid');
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const hash = crypto.createHash('sha1').update(source).digest('hex').slice(0, 16);
	const pdf = path.join(dir, `${hash}.pdf`);
	if (!fs.existsSync(pdf)) {
		const mmd = path.join(dir, `${hash}.mmd`);
		try {
			fs.writeFileSync(mmd, source);
			runMmdc(mmdc, ['-i', mmd, '-o', pdf]);
		} catch (e) {
			// Don't cache a partial figure from a failed run.
			try { fs.unlinkSync(pdf); } catch { /* none was written */ }
			addWarning(`mermaid: ${diagramName(source)} left out of the LaTeX — mmdc failed: ${mmdcReason(e)}`);
			return '';
		} finally {
			try { fs.unlinkSync(mmd); } catch { /* ignore */ }
		}
	}
	// `export` makes adjustbox's keys (max width) \includegraphics keys; without
	// it the key is undefined and the document stops ("`max width' undefined in
	// families `Gin'").
	requirePackage('adjustbox', 'export'); // also loads graphicx
	return `\\begin{center}\n\\includegraphics[max width=\\linewidth]{${escapeLatexPath(texCachePath(pdf))}}\n\\end{center}\n\n`;
}

/*
	Mirror :::mermaid as @begin(mermaid), reusing the directive's own renderer
	verbatim (same no-drift pattern as @begin(game) / @begin(TiKZ)). One subtlety is
	specific to mermaid: the :::mermaid path never actually invokes this tokenizer —
	createToken (extended-directives.js) files a container body as a 'text' token that
	only sets `header text`, so :::mermaid's token.text keeps its leading '\n'
	(unstripped) with no trailing newline, and js-beautify then indents that leading
	newline inside the <div class="mermaid">. The @begin path DOES call the tokenizer
	(which strips exactly one leading '\n'), so we pre-pad with '\n\n' and strip
	trailing newlines: after the single strip, token.text is '\n'+body — byte-identical
	to :::mermaid (verified against the mermaid/diagram golden on the HTML path).

	The renderer keys off token.meta.name and branches on global.isLatex, so one
	format-independent `render` covers both outputs. mode 'custom' hands the body raw
	to the mermaid tokenizer (which, for LaTeX, rasterises via mmdc) rather than
	re-lexing it as markdown.
*/
const mermaidEnvInstance = createMermaid();   // marker arg unused by tokenizer/renderer
registerBlockEnvironment('mermaid', {
	mode: 'custom',
	tokenize(body, token) {
		token.meta = { name: 'mermaid' };
		mermaidEnvInstance.tokenizer.call(this, '\n\n' + body.replace(/\n+$/, ''), token);
	},
	render: (ctx) => mermaidEnvInstance.renderer.call({ parser: ctx.parser }, ctx.token)
});

export function createMermaid(marker) {
	return {
		level: 'container',
		marker: marker,
		label: "mermaid",
		tokenizer: function(text, token) {
			// Strip the leading newline between `:::mermaid` and the first
			// diagram line; preserve all internal newlines (mermaid is
			// line-based). Anchored regex makes the intent explicit — the
			// previous `text.replace("\n", '')` happened to do the same
			// thing only because string-arg `replace` is first-match-only.
			token.text = text.replace(/^\n/, '');
			return token;
		},
		renderer(token) {
			if (token.meta.name === "mermaid") {
				// LaTeX: rasterise to a cached PDF (mmdc) and \includegraphics it.
				if (global.isLatex) return renderMermaidLatex(token.text);
				return `<div class="mermaid">${token.text}</div>`;
			}
			return false;
		}
	}
}
