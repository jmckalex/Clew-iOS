/*
	Images and video: @image(path)[alt]{attrs} and @video(path)[alt]{attrs}.

	Two single-shot @-directives built on the begin-end registry, in both the
	inline (@image(…)) and block (@image+(…)) forms.  The path is the one thing
	neither can do without, so it takes the mandatory argument slot (arg: true —
	see begin-end-core.js); the bracket is alt text; the braces are attributes.

	    @image+(figs/network.png)[A small-world graph]{width=0.6 align=center}
	    @video(clips/run.mp4)[A run of the model]{width=0.6 poster=clips/run.png}

	A bare markdown image (![alt](src)) still works and is unchanged; reach for
	@image when you want attributes, and for @begin(figure) when you want a
	caption and a number (floats.js) — the two compose.

	THE ATTRIBUTE MODEL — one vocabulary, translated per format

	The braces are HTML attributes, with two additions that let one source serve
	both outputs:

	  1. FOUR TRANSLATED KEYS — width, height, scale, align — are interpreted by
	     both renderers rather than passed through.  Values:

	         0.6          a fraction of the text width  → 0.6\linewidth  / 60%
	         "60%"        the same thing                → 0.6\linewidth  / 60%
	         8cm 72mm     a physical unit               → verbatim in BOTH (CSS and
	         3in 24pt                                      LaTeX share these units)
	         400px        pixels                        → 300bp (at 96dpi) / 400px

	     A bare number greater than 1 is read as pixels.  Units may be written
	     bare (`width=8cm`) or quoted (`width="8cm"`) — attributes-parser splits
	     the unit off as a separate attribute, which normaliseUnits below puts
	     back together.

	  2. FORMAT-SCOPED OVERRIDES — a `tex-` or `web-` prefix on any key confines
	     it to that output and beats the unprefixed key there:

	         {width=0.5 tex-width=0.8 web-loading=lazy}

	     `tex-options` is the escape hatch for extra \includegraphics keys
	     (`tex-options="trim=0 0 0 1cm, clip"`).  It cannot contain a backslash —
	     nothing in {…} can, because attributes-parser rejects the whole string —
	     which is why width and friends are semantic keys rather than raw LaTeX.
	     For genuinely arbitrary LaTeX, reach for @begin(TeX) instead.

	  3. EVERYTHING ELSE passes through verbatim as an HTML attribute (class, id,
	     loading, srcset, controls, loop, …) and is ignored by LaTeX.

	VIDEO IN LATEX

	There is no faithful print rendering of a video, so this degrades rather than
	translates, under the `Video mode` key (per-video: {tex-mode=…}):

	    link    (default)  the poster frame hyperlinked to the video — \href{run:…}
	                       for a local file, the URL for a remote one.  Works in
	                       every PDF viewer.
	    embed              media9's RichMedia annotation, which really does carry
	                       the H.264 stream in the PDF.  Only Acrobat plays it;
	                       every other viewer shows the poster.  Adds ~480KB of
	                       player to the document — once, not per video.
	    attach             the file embedded as a PDF attachment (attachfile2),
	                       opened in the reader's own player.
	    poster             the still frame alone.

	`embed` and `attach` need a local file that exists; a remote or missing one
	falls back to `link` with a build warning.  Where a poster is needed and none
	was given, one is extracted from frame 1 with ffmpeg and cached by content
	stamp under `Video/` next to the source (the mermaid/metapost cache pattern);
	`Video poster: none` turns that off, and a missing ffmpeg degrades quietly.
*/

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFileSync } from 'child_process';
import { configManager } from './config-manager.js';
import { registerBlockEnvironment } from './begin-end-core.js';
import { requirePackage } from './preamble.js';
import { escapeLatexText } from './latex-escape.js';
import { latexGraphic, resolveGraphic, isRemote, markdownDir, escapeLatexPath } from './latex-graphics.js';
import { addWarning } from './warnings.js';

const VIDEO_DIR_NAME = 'Video';

/* --- small shared helpers -------------------------------------------------- */

function htmlEscape(s) {
	return String(s)
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;');
}

function escAttr(s) {
	return htmlEscape(s).replace(/"/g, '&quot;');
}


// Trim float noise: 0.6000000000000001 → 0.6, 45 → 45.
function num(n) {
	return String(Math.round(Number(n) * 10000) / 10000);
}

/* --- the four translated keys ---------------------------------------------- */

const TRANSLATED = new Set(['width', 'height', 'scale', 'align']);

const DIM_RE = /^\s*(-?\d*\.?\d+)\s*(cm|mm|in|pt|pc|em|ex|bp|px|%)\s*$/i;

const UNITS = new Set(['cm', 'mm', 'in', 'pt', 'pc', 'em', 'ex', 'bp', 'px', '%']);

// attributes-parser follows the HTML attribute grammar, in which `8cm` is not a
// value: `width=8cm` reads as width=8 plus a bare attribute named `cm`, and
// `width=50%` as width=50 plus `%`.  A unit is exactly what a dimension wants,
// so rather than make every author quote every dimension, re-join them.
//
// It has to be done from the token stream, not the parsed object: two dimensions
// sharing a unit (`width=8cm height=5cm`) collide on the one `cm` key and the
// second is lost.  A unit is an AttributeName token that starts exactly where the
// preceding numeric value ended — glued, with no whitespace, which is what tells
// it apart from a genuine neighbouring attribute.
function normaliseUnits(attrs) {
	if (!attrs) return {};
	const out = { ...attrs };
	if (typeof attrs.getTokens !== 'function') return out;

	const tokens = attrs.getTokens().filter(t => t.type !== 'WhiteSpace');
	const stray = new Set();
	for (let i = 0; i < tokens.length - 3; i++) {
		const [key, sep, value, unit] = tokens.slice(i, i + 4);
		if (key.type !== 'AttributeName' || sep.type !== 'Separator') continue;
		if (value.type !== 'NumericLiteral' || unit.type !== 'AttributeName') continue;
		if (unit.offset !== value.offset + value.text.length) continue;
		if (!UNITS.has(String(unit.value).toLowerCase())) continue;
		out[key.value] = `${value.text}${unit.value}`;
		stray.add(unit.value);
	}
	for (const key of stray) {
		if (out[key] === key) delete out[key];         // the bare token we just consumed
	}
	return out;
}

// A dimension as LaTeX writes it. `axis` picks the base a fraction is relative
// to: \linewidth for widths (so it also behaves inside a minipage or a
// subfigure), \textheight for heights.
function latexDim(value, axis) {
	const base = axis === 'height' ? '\\textheight' : '\\linewidth';
	if (typeof value === 'number') {
		return (value > 0 && value <= 1) ? `${num(value)}${base}` : `${num(value * 0.75)}bp`;
	}
	const m = DIM_RE.exec(String(value));
	if (!m) return null;
	const n = Number(m[1]), unit = m[2].toLowerCase();
	if (unit === '%') return `${num(n / 100)}${base}`;
	if (unit === 'px') return `${num(n * 0.75)}bp`;      // 96dpi px → 72dpi big point
	return `${num(n)}${unit}`;                            // cm/mm/in/pt/pc/em/ex/bp
}

// The same value as CSS writes it.
function cssDim(value) {
	if (typeof value === 'number') {
		return (value > 0 && value <= 1) ? `${num(value * 100)}%` : `${num(value)}px`;
	}
	const m = DIM_RE.exec(String(value));
	if (!m) return null;
	const n = Number(m[1]), unit = m[2].toLowerCase();
	if (unit === 'bp') return `${num(n)}pt`;              // 1bp = 1/72in = 1 CSS pt
	return `${num(n)}${unit}`;
}

// Multiply a dimension by a factor, keeping its kind (used to derive a video's
// height from its width and aspect ratio).
function scaleValue(value, factor) {
	if (typeof value === 'number') return value * factor;
	const m = DIM_RE.exec(String(value));
	if (!m) return null;
	return `${num(Number(m[1]) * factor)}${m[2]}`;
}

/* --- attribute scoping ------------------------------------------------------ */

// Split an attributes-parser result into the buckets each renderer wants:
//
//   dims  the four translated keys, with the format's own tex-/web- overrides
//         already applied
//   own   the rest of the format's prefixed keys (tex-options, web-loading, …)
//   pass  unprefixed, untranslated keys — HTML attributes to emit verbatim
//
// The other format's prefixed keys are dropped, which is the point of them.
function scope(attrs, format) {
	const dims = {}, own = {}, pass = {};
	const mine = format === 'latex' ? 'tex-' : 'web-';
	const theirs = format === 'latex' ? 'web-' : 'tex-';
	const overrides = {};

	for (const [key, value] of Object.entries(normaliseUnits(attrs))) {
		if (key.startsWith(theirs)) continue;
		if (key.startsWith(mine)) {
			const bare = key.slice(mine.length);
			if (TRANSLATED.has(bare)) overrides[bare] = value;
			else own[bare] = value;
			continue;
		}
		if (TRANSLATED.has(key)) dims[key] = value;
		else pass[key] = value;
	}
	Object.assign(dims, overrides);                       // the scoped key wins
	return { dims, own, pass };
}

// Build the CSS for the translated keys.  Alignment is a block-form notion —
// an inline image sits in the text flow, where margins can't centre it.
function styleFor(dims, name, isBlock) {
	const parts = [];
	for (const axis of ['width', 'height']) {
		if (dims[axis] === undefined) continue;
		const css = cssDim(dims[axis]);
		if (css) parts.push(`${axis}: ${css}`);
		else addWarning(`@${name}: unrecognised ${axis} "${dims[axis]}" — expected a fraction (0.6), a percentage ("60%") or a unit (8cm, 400px)`);
	}
	if (dims.scale !== undefined) {
		parts.push(`transform: scale(${dims.scale})`, 'transform-origin: left top');
	}
	if (isBlock) {
		parts.push('display: block');
		const align = String(dims.align || '').toLowerCase();
		if (align === 'center') parts.push('margin-left: auto', 'margin-right: auto');
		else if (align === 'right') parts.push('margin-left: auto');
		else if (align === 'left') parts.push('margin-right: auto');
	} else if (dims.align) {
		addWarning(`@${name}: align only applies to the block form (@${name}+(…)) — ignored`);
	}
	return parts.join('; ');
}

// The \includegraphics option list for the translated keys plus tex-options.
function latexOptions(dims, own, name) {
	const opts = [];
	if (dims.width !== undefined) {
		const w = latexDim(dims.width, 'width');
		if (w) opts.push(`width=${w}`);
		else addWarning(`@${name}: unrecognised width "${dims.width}" — expected a fraction (0.6), a percentage ("60%") or a unit (8cm, 400px)`);
	}
	if (dims.height !== undefined) {
		const h = latexDim(dims.height, 'height');
		if (h) opts.push(`height=${h}`);
	}
	if (dims.scale !== undefined) opts.push(`scale=${dims.scale}`);
	if (own.options !== undefined) opts.push(String(own.options));
	return opts;
}

// Ordered attribute list → an HTML attribute string.  A Map so a later
// assignment (an author's own {alt=…}) overwrites our default in place.
// `alt=""` is meaningful — it marks a decorative image — so an empty value is
// kept for it, and dropped for everything else.
const KEEP_EMPTY = new Set(['alt']);

function attrString(map) {
	const out = [];
	for (const [key, value] of map) {
		if (value === false || value === undefined || value === null) continue;
		if (value === '' && !KEEP_EMPTY.has(key)) continue;
		if (value === true) out.push(key);
		else out.push(`${key}="${escAttr(value)}"`);
	}
	return out.length ? ' ' + out.join(' ') : '';
}

function missingSource(name, format) {
	addWarning(`@${name}: no source given — the path goes in parentheses, @${name}(path/to/file)`);
	return format === 'latex' ? '' : `<span class="jmd-error">[@${name}: no source]</span>`;
}

/* --- @image ----------------------------------------------------------------- */

function imageHTML(ctx) {
	const src = (ctx.arg || '').trim();
	if (!src) return missingSource('image', 'html');

	const { dims, own, pass } = scope(ctx.attrs, 'html');
	const map = new Map([['src', src], ['alt', ctx.text || '']]);
	for (const [k, v] of Object.entries(pass)) map.set(k, v);
	for (const [k, v] of Object.entries(own)) map.set(k, v);     // web-… keys

	const style = styleFor(dims, 'image', ctx.block);
	if (style) map.set('style', style);
	const img = `<img${attrString(map)}>`;
	return ctx.block ? img + '\n' : img;
}

// Remote and SVG images in LaTeX — link instead of include — are
// latex-graphics.js's business, shared with markdown images.

function imageLatex(ctx) {
	const src = (ctx.arg || '').trim();
	if (!src) return missingSource('image', 'latex');

	const { dims, own } = scope(ctx.attrs, 'latex');
	const alt = ctx.text;

	const body = latexGraphic({
		src,
		alt,
		what: '@image',
		options: () => {
			const opts = latexOptions(dims, own, 'image');
			return opts.length ? `[${opts.join(',')}]` : '';
		},
	});

	if (!ctx.block) return body;

	// Block form: its own paragraph, with the alt text preserved as a comment
	// (\includegraphics has nowhere to put it, and a lost description is worth
	// keeping in the source the author will read).
	const note = alt ? `% alt: ${alt.replace(/\s+/g, ' ')}\n` : '';
	const align = String(dims.align || '').toLowerCase();
	const env = align === 'center' ? 'center' : align === 'right' ? 'flushright' : align === 'left' ? 'flushleft' : null;
	if (env) return `${note}\\begin{${env}}\n${body}\n\\end{${env}}\n\n`;
	return `${note}${body}\n\n`;
}

/* --- video: poster frames and probing --------------------------------------- */

let ffmpegChecked = null;
function hasFFmpeg() {
	if (ffmpegChecked === null) {
		try { execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' }); ffmpegChecked = true; }
		catch { ffmpegChecked = false; }
	}
	return ffmpegChecked;
}

const aspectCache = new Map();

// The video's width/height ratio via ffprobe (ships with ffmpeg), or null.
function videoAspect(file) {
	if (aspectCache.has(file)) return aspectCache.get(file);
	let aspect = null;
	try {
		// Argument arrays, no shell, here and in extractPoster: `file` is the
		// document's own @video(path) — in a shell string, `$(…)` in it ran.
		const out = execFileSync(
			'ffprobe',
			['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file],
			{ encoding: 'utf8' }
		).trim();
		const [w, h] = out.split(',').map(Number);
		if (w > 0 && h > 0) aspect = w / h;
	} catch { /* no ffprobe, or not a video — fall back to 16:9 at the call site */ }
	aspectCache.set(file, aspect);
	return aspect;
}

// A cached still from frame 1, as a path relative to the markdown file. Cached
// on a stamp of the source (path + size + mtime) rather than its bytes: video
// files are large and hashing them on every build would cost more than it saves.
function extractPoster(file) {
	if (configManager.get('Video poster', 'auto') === 'none') return null;

	const st = fs.statSync(file);
	const stamp = crypto.createHash('md5')
		.update(`${path.resolve(file)}|${st.size}|${st.mtimeMs}`)
		.digest('hex').slice(0, 16);
	const rel = `${VIDEO_DIR_NAME}/${stamp}-poster.png`;
	const out = path.join(markdownDir(), rel);
	if (fs.existsSync(out)) return rel;

	if (!hasFFmpeg()) {
		addWarning('@video: no poster given and ffmpeg is not installed — the LaTeX output has no still frame');
		return null;
	}
	try {
		fs.mkdirSync(path.dirname(out), { recursive: true });
		execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', file, '-frames:v', '1', out], { stdio: 'ignore' });
		if (fs.existsSync(out)) return rel;
	} catch (error) {
		try { fs.unlinkSync(out); } catch { /* nothing to clean up */ }
		addWarning(`@video: could not extract a poster frame from ${path.basename(file)} (${error.message.split('\n')[0]})`);
	}
	return null;
}

/* --- @video ------------------------------------------------------------------ */

function videoHTML(ctx) {
	const src = (ctx.arg || '').trim();
	if (!src) return missingSource('video', 'html');

	const { dims, own, pass } = scope(ctx.attrs, 'html');
	const map = new Map([['src', src]]);
	// A <video> with neither controls nor autoplay is an unplayable still, so
	// controls are the default; {controls=false} takes them away again.
	if (!('controls' in pass) && !('autoplay' in pass)) map.set('controls', true);
	for (const [k, v] of Object.entries(pass)) map.set(k, v);
	for (const [k, v] of Object.entries(own)) map.set(k, v);
	if (ctx.text) map.set('aria-label', ctx.text);

	const style = styleFor(dims, 'video', ctx.block);
	if (style) map.set('style', style);

	// <video> has no alt attribute; its fallback content is what a browser that
	// can't play the file shows, so put the description there as a link.
	const fallback = `<a href="${escAttr(src)}">${htmlEscape(ctx.text || src)}</a>`;
	const video = `<video${attrString(map)}>${fallback}</video>`;
	return ctx.block ? video + '\n' : video;
}

function videoLatex(ctx) {
	const src = (ctx.arg || '').trim();
	if (!src) return missingSource('video', 'latex');

	const { dims, own, pass } = scope(ctx.attrs, 'latex');
	const alt = ctx.text;
	const remote = isRemote(src);
	const file = remote ? null : path.resolve(markdownDir(), src);
	const exists = Boolean(file && fs.existsSync(file));

	let mode = String(own.mode || configManager.get('Video mode', 'link')).toLowerCase();
	if (!['link', 'embed', 'attach', 'poster'].includes(mode)) {
		addWarning(`@video: unknown Video mode "${mode}" — using "link" (link, embed, attach, poster)`);
		mode = 'link';
	}
	// embed and attach put the actual bytes in the PDF, so they need the file.
	if ((mode === 'embed' || mode === 'attach') && !exists) {
		addWarning(`@video: ${src} ${remote ? 'is remote' : 'was not found'}, so it cannot be ${mode === 'embed' ? 'embedded' : 'attached'} — falling back to a link`);
		mode = 'link';
	}

	// The poster: an explicit {poster=…}/{tex-poster=…}, else a cached still.
	const posterAttr = own.poster ?? pass.poster;
	let poster = posterAttr ? String(posterAttr) : (exists ? extractPoster(file) : null);
	if (poster && !fs.existsSync(path.resolve(markdownDir(), poster))) {
		addWarning(`@video: poster ${poster} was not found`);
		poster = null;
	}
	// An SVG still can't go to \\includegraphics; a .pdf/.png beside it can.
	if (poster && resolveGraphic(poster) === null) {
		addWarning(`@video: poster ${poster} is an SVG, which \\includegraphics cannot read — put a .pdf or .png beside it; the link shows the caption instead`);
		poster = null;
	} else if (poster) {
		poster = resolveGraphic(poster);
	}

	const opts = latexOptions(dims, own, 'video');
	const posterBox = poster
		? `\\includegraphics${opts.length ? `[${opts.join(',')}]` : ''}{${escapeLatexPath(poster)}}`
		: null;
	if (posterBox) requirePackage('graphicx');
	const caption = escapeLatexText(alt || src);
	const note = ctx.block && alt ? `% video: ${alt.replace(/\s+/g, ' ')}\n` : '';
	const wrap = (body) => (ctx.block ? `${note}${body}\n\n` : body);

	if (mode === 'poster') {
		if (!posterBox) { addWarning(`@video: no poster available for ${src} — nothing emitted in LaTeX`); return ''; }
		return wrap(posterBox);
	}

	if (mode === 'attach') {
		requirePackage('attachfile2');
		return wrap(`\\textattachfile{${escapeLatexPath(src)}}{${posterBox || caption}}`);
	}

	if (mode === 'embed') {
		// media9's RichMedia annotation. The player name decides the PDF asset
		// subtype — VPlayer.swf is what makes it /Subtype/Video rather than
		// /Subtype/Flash — and the stream itself rides along via addresource.
		// activate=onclick, not pageopen: a book that starts every video when its
		// page is turned to is not what anyone wants.
		requirePackage('media9');
		const widthVal = dims.width ?? 1;
		let heightVal = dims.height;
		let heightDim;
		if (heightVal === undefined) {
			const aspect = videoAspect(file) || (16 / 9);
			heightDim = latexDim(scaleValue(widthVal, 1 / aspect), 'width');
		} else {
			heightDim = latexDim(heightVal, 'height');
		}
		const widthDim = latexDim(widthVal, 'width') || '\\linewidth';
		const escaped = escapeLatexPath(src);
		return wrap(
			`\\includemedia[\n` +
			`  width=${widthDim}, height=${heightDim || '0.5625\\linewidth'},\n` +
			`  activate=onclick, deactivate=pageclose,\n` +
			`  addresource=${escaped},\n` +
			`  flashvars={source=${escaped}}\n` +
			`]{${posterBox || ''}}{VPlayer.swf}`
		);
	}

	// link (the default): the poster, hyperlinked. A local file opens in the
	// reader's own player via a launch action; a URL opens in the browser.
	requirePackage('hyperref');
	const target = remote ? src : `run:${src}`;
	return wrap(`\\href{${escapeLatexPath(target)}}{${posterBox || caption}}`);
}

/* --- registration ------------------------------------------------------------ */

// mode 'verbatim': the bracket is alt text, which is plain text by definition —
// lexing it as markdown would put an <em> inside an alt attribute.
registerBlockEnvironment('image', {
	arg: true,
	mode: 'verbatim',
	html: imageHTML,
	latex: imageLatex
});

registerBlockEnvironment('video', {
	arg: true,
	mode: 'verbatim',
	html: videoHTML,
	latex: videoLatex
});

export { imageHTML, imageLatex, videoHTML, videoLatex };
