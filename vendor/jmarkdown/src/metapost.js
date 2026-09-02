/*
	MetaPost diagrams as a named block environment: @begin(metapost) … @end(metapost).

	A sibling of the TiKZ container, but built directly on the @-sigil begin-end
	registry (there is no legacy :::metapost colon form). The MetaPost source is
	taken verbatim, compiled once, cached by a content hash under a `MetaPost/`
	directory next to the markdown file, and included:

	  • HTML  → `mpost` with `outputformat := "svg"` produces a vector SVG, embedded
	            as <img src='MetaPost/<hash>-N.svg'> (mirrors TiKZ's HTML output,
	            same {scale=… width=… embed} attributes).
	  • LaTeX → `mptopdf` converts the same source to a cached PDF, pulled in with
	            \includegraphics[max width=\linewidth] (mirrors the mermaid
	            container's LaTeX approach — engine-agnostic, so it works with the
	            default pdflatex, no luamplib / LuaLaTeX requirement).

	Both toolchain programs ship with TeX Live. If compilation fails the diagram is
	replaced by an inline error box (HTML) / dropped with a build warning (LaTeX)
	rather than breaking the build — matching how TiKZ / mermaid degrade.

	Attributes (HTML): scale (CSS transform), width (CSS width), embed (inline the
	SVG as a data: URI), empty-cache (clear the MetaPost/ cache first). LaTeX uses
	`max width=\linewidth`; scale/width are HTML-only, as with the TiKZ container.
*/

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import crypto from 'crypto';
import { configManager } from './config-manager.js';
import { requirePackage } from './preamble.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { addWarning } from './warnings.js';

const MP_DIR_NAME = 'MetaPost';

function ensureDirectoryExists(dirPath) {
	if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function generateHash(string) {
	return crypto.createHash('md5').update(string).digest('hex');
}

// The cache directory ('MetaPost/' next to the markdown file), created on demand.
function metapostDir() {
	const home = configManager.get('Markdown file directory');
	const dir = path.join(home, MP_DIR_NAME);
	ensureDirectoryExists(dir);
	return dir;
}

// Delete every file in the cache directory (the `empty-cache` attribute).
function emptyCache(dir) {
	for (const file of fs.readdirSync(dir)) {
		const p = path.join(dir, file);
		try { if (fs.statSync(p).isFile()) fs.unlinkSync(p); } catch { /* ignore */ }
	}
}

// Delete the intermediate files named "<hash>.<ext>" (the .mp source, .log, .mpx,
// the numeric .1 EPS, …). The kept outputs are "<hash>-N.svg" / "<hash>-N.pdf" — a
// HYPHEN follows the hash there, so they never match this and survive as the cache.
function cleanupAux(dir, hash) {
	for (const f of fs.readdirSync(dir)) {
		if (f.startsWith(hash + '.')) {
			try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
		}
	}
}

// The cached outputs for a hash: files "<hash>-N.<ext>" in document (figure) order.
function producedFiles(dir, hash, ext) {
	const re = new RegExp(`^${hash}-\\d+\\.${ext}$`);
	return fs.readdirSync(dir).filter(f => re.test(f)).sort();
}

// Remove any produced outputs for a hash. Used on the ERROR path: mpost in
// nonstopmode can write a partial "<hash>-N.svg" and still exit non-zero, and
// leaving it would let the next build cache-hit the broken figure instead of
// re-reporting the error. cleanupAux only removes the "<hash>." aux files, so the
// produced (hyphen-suffixed) outputs need this explicit sweep.
function deleteProduced(dir, hash) {
	for (const ext of ['svg', 'pdf', 'mps']) {
		for (const f of producedFiles(dir, hash, ext)) {
			try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
		}
	}
}

function readLog(logPath, error) {
	try { if (fs.existsSync(logPath)) return fs.readFileSync(logPath, 'utf8'); } catch { /* ignore */ }
	return (error && error.message) || 'Unknown error';
}

// Wrap raw drawing commands into a compilable MetaPost program. A bare body (the
// common case) is put inside beginfig(1)…endfig; a body that already has its own
// beginfig is left as-is. Either way we ensure a trailing `end.`.
function wrapMetapost(src) {
	let body = src.trim();
	if (!/\bbeginfig\b/.test(body)) {
		body = `beginfig(1);\n${body}\nendfig;`;
	}
	if (!/\bend\b\s*\.?\s*$/.test(body)) {
		body = `${body}\nend.`;
	}
	return body;
}

function esc(s) {
	return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function metapostErrorHTML(log) {
	return `<div class="metapost-error">\n` +
		`  <p class="metapost-error-message">Error processing MetaPost diagram</p>\n` +
		`  <details><summary>Show log</summary><pre>${esc(log)}</pre></details>\n` +
		`</div>`;
}

// One <img> for a produced SVG, honouring scale / width / embed (mirrors TiKZ).
function imgTag(dir, svgName, attrs) {
	let styleAttr = '';
	if (attrs?.scale) {
		styleAttr = ` style="transform: scale(${attrs.scale}); transform-origin: left top;"`;
	} else if (attrs?.width) {
		styleAttr = ` style="width: ${attrs.width};"`;
	}
	if (attrs?.embed) {
		try {
			const b64 = fs.readFileSync(path.join(dir, svgName), 'base64');
			return `<img src="data:image/svg+xml;base64,${b64}"${styleAttr}>`;
		} catch (e) {
			console.error(`Error embedding MetaPost SVG: ${e.message}`);
			// fall through to a file reference
		}
	}
	return `<img src='${MP_DIR_NAME}/${svgName}'${styleAttr}>`;
}

// HTML: compile the source to SVG (cached), return the <img>(s).
//
// NOT via mpost's own SVG backend: that emits <text> elements referencing
// TeX fonts (cmr10 and friends) with no usable font-family, so every
// browser substitutes its default and the TeX-metric letter positions read
// as garbled kerning ("empt y"). Instead `prologues := 3` embeds the Type 1
// fonts in mpost's EPS output and dvisvgm --no-fonts converts every glyph
// to SVG PATHS — labels then render identically everywhere, exactly as the
// TikZ pipeline's do (same dvisvgm, same libgs configuration). If dvisvgm
// is unavailable, the old backend still runs, with a warning.
function renderMetapostHTML(source, attrs) {
	const dir = metapostDir();
	if (attrs?.['empty-cache']) emptyCache(dir);

	const body = wrapMetapost(source);
	const fileContents = `prologues := 3;\noutputtemplate := "%j-%c.mps";\n${body}\n`;
	const hash = generateHash(fileContents);

	let svgs = producedFiles(dir, hash, 'svg');
	if (svgs.length === 0) {
		const mpFile = path.join(dir, `${hash}.mp`);
		try {
			fs.writeFileSync(mpFile, fileContents);
			execSync(`mpost -interaction=nonstopmode "${hash}.mp"`, { cwd: dir, stdio: 'ignore' });
			const figures = producedFiles(dir, hash, 'mps');
			if (figures.length === 0) throw new Error('mpost produced no figures');
			try {
				// A stale configured path (ghostscript upgrades rotate the
				// versioned Cellar dir) must not scuttle the conversion.
				const libgs = configManager.get('TiKZ libgs');
				const gs = libgs && fs.existsSync(libgs) ? ` --libgs=${libgs}` : '';
				for (const figure of figures) {
					const svgName = figure.replace(/\.mps$/, '.svg');
					execSync(`dvisvgm --eps --bbox=min${gs} --no-fonts=1 "${figure}" -o "${svgName}"`,
						{ cwd: dir, stdio: 'ignore' });
				}
			} catch {
				addWarning('dvisvgm unavailable — MetaPost labels may render with substituted fonts');
				const legacy = `outputformat := "svg";\noutputtemplate := "%j-%c.svg";\n${body}\n`;
				fs.writeFileSync(mpFile, legacy);
				execSync(`mpost -interaction=nonstopmode "${hash}.mp"`, { cwd: dir, stdio: 'ignore' });
			}
			for (const figure of producedFiles(dir, hash, 'mps')) {
				try { fs.unlinkSync(path.join(dir, figure)); } catch { /* converted or gone */ }
			}
			svgs = producedFiles(dir, hash, 'svg');
			cleanupAux(dir, hash);
		} catch (error) {
			const log = readLog(path.join(dir, `${hash}.log`), error);
			cleanupAux(dir, hash);
			deleteProduced(dir, hash);   // don't cache a partial figure from a failed run
			addWarning('MetaPost diagram failed to compile (mpost) — see the inline error box');
			console.error(`Error processing MetaPost: ${error.message}`);
			return metapostErrorHTML(log);
		}
	}
	if (svgs.length === 0) {
		addWarning('MetaPost produced no SVG output');
		return metapostErrorHTML('MetaPost ran but produced no output file.');
	}
	return svgs.map(svg => imgTag(dir, svg, attrs)).join('\n');
}

// LaTeX: convert the source to a cached PDF via mptopdf, \includegraphics it.
function renderMetapostLatex(source, attrs) {
	const dir = metapostDir();
	if (attrs?.['empty-cache']) emptyCache(dir);

	const body = wrapMetapost(source);
	// Hash a PDF-tagged variant so LaTeX and HTML cache entries never collide.
	const hash = generateHash('PDF:' + body);

	let pdfs = producedFiles(dir, hash, 'pdf');
	if (pdfs.length === 0) {
		const mpFile = path.join(dir, `${hash}.mp`);
		try {
			fs.writeFileSync(mpFile, body + '\n');
			execSync(`mptopdf "${hash}.mp"`, { cwd: dir, stdio: 'ignore' });
			pdfs = producedFiles(dir, hash, 'pdf');
			cleanupAux(dir, hash);
		} catch (error) {
			cleanupAux(dir, hash);
			deleteProduced(dir, hash);   // don't cache a partial figure from a failed run
			addWarning('MetaPost diagram failed to compile for LaTeX (mptopdf) — skipped');
			console.error(`Error processing MetaPost (LaTeX): ${error.message}`);
			return '';
		}
	}
	if (pdfs.length === 0) {
		addWarning('MetaPost (LaTeX) produced no PDF — skipped');
		return '';
	}
	requirePackage('adjustbox'); // for `max width` (also loads graphicx)
	const includes = pdfs
		.map(pdf => `\\includegraphics[max width=\\linewidth]{${path.join(dir, pdf)}}`)
		.join('\\\\\n');
	return `\\begin{center}\n${includes}\n\\end{center}\n\n`;
}

// Register the environment. mode 'verbatim' hands the renderer the raw MetaPost
// body (which contains `;`, `:=`, `--`, `*`, …) untouched by the markdown lexer.
// One format-independent pair of renderers; the begin-end core dispatches
// handler[format] (latex) → html.
registerBlockEnvironment('metapost', {
	mode: 'verbatim',
	html: (ctx) => renderMetapostHTML(ctx.rawText, ctx.attrs),
	latex: (ctx) => renderMetapostLatex(ctx.rawText, ctx.attrs)
});

export { renderMetapostHTML, renderMetapostLatex };
