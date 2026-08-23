// Mermaid diagrams. In HTML they render client-side (mermaid.js in the browser).
// For print there is no LaTeX-native mermaid, so we rasterise each diagram to a
// cached PDF with the mermaid CLI (mmdc) and \includegraphics it. mmdc is an
// optional, heavy tool (it drives a headless browser); when it isn't available
// the diagram is skipped with a one-line hint rather than breaking the build.

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execSync } from 'child_process';
import { configManager } from './config-manager.js';
import { requirePackage } from './preamble.js';
import { registerBlockEnvironment } from './begin-end-core.js';

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
			execSync(`"${candidate}" --version`, { stdio: 'ignore' });
			mmdcPath = candidate;
			break;
		} catch { /* try the next candidate */ }
	}
	return mmdcPath;
}

// Render a mermaid diagram for LaTeX: a cached PDF via mmdc, embedded with
// \includegraphics. Returns '' (with a hint) when mmdc is unavailable or fails.
function renderMermaidLatex(source) {
	const mmdc = getMmdc();
	if (!mmdc) {
		console.warn('jmarkdown: mermaid diagram skipped in LaTeX — mermaid-cli (mmdc) not found. Install @mermaid-js/mermaid-cli to render mermaid for print.');
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
			execSync(`"${mmdc}" -i "${mmd}" -o "${pdf}"`, { stdio: 'ignore' });
		} catch (e) {
			console.warn(`jmarkdown: mermaid render failed (${e.message}); skipping in LaTeX.`);
			return '';
		} finally {
			try { fs.unlinkSync(mmd); } catch { /* ignore */ }
		}
	}
	requirePackage('adjustbox'); // for max width (also loads graphicx)
	return `\\begin{center}\n\\includegraphics[max width=\\linewidth]{${pdf}}\n\\end{center}\n\n`;
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
