/*
	LaTeX rendering of Obsidian callouts (callouts.js), to match the HTML
	design: a tcolorbox per callout, with the type's accent colour for the
	left rule, the icon and the title, a light tint of it as the background,
	rounded corners, and a title row of icon plus title.

	Three self-contained pieces, so the output needs nothing from a preamble
	but packages (tcolorbox with its skins and breakable libraries; TikZ with
	svg.path; graphicx) — a --fragment build compiles wherever those are
	loaded:

	  - COLOUR. The accent is defined inside each box (tcolorbox's `code=`),
	    so it is local to that box: a callout nested in another redefines it
	    only for itself. A custom colour arrives as CSS (validated by
	    callout-definitions.js: hex, rgb(), hsl() or a CSS name) and is
	    converted here, with the stylesheet's light-page legibility rule
	    applied — OKLCH lightness at most 0.68 — since print is a light page.

	  - ICON. The SAME Font Awesome glyph as the HTML, drawn from its SVG path
	    with TikZ's svg.path library: exact, and no font to install. The path
	    is normalised here to absolute M/L/C/Z first — arcs and quadratics
	    become cubic Béziers — because svg.path mis-draws Font Awesome's
	    semicircular arcs (the disc of `info`, `question`, `circle-check`
	    vanished) and so is handed nothing but its four simplest commands.
	    The viewBox is the bounding box, scaled to 1em high, as the CSS sizes
	    it.

	  - BOX. The frame is hidden and the box drawn in `interior code`: the
	    tint as a rounded rectangle, then the accent strip clipped to the same
	    rounded shape, so the left rule curves with the corners as CSS's
	    border-left does. (A drawn frame under the interior showed as a
	    hairline outline wherever antialiasing let it through.)
*/

import { requirePackage, addPreamble } from './preamble.js';

/* --- Colour ---------------------------------------------------------------- */

// CSS named colours (CSS Color Module Level 4), name → hex; the values as
// published in the `color-name` package (MIT).
const NAMED = new Map((
	'aliceblue:f0f8ff antiquewhite:faebd7 aqua:00ffff aquamarine:7fffd4 '
	+ 'azure:f0ffff beige:f5f5dc bisque:ffe4c4 black:000000 blanchedalmond:ffebcd '
	+ 'blue:0000ff blueviolet:8a2be2 brown:a52a2a burlywood:deb887 '
	+ 'cadetblue:5f9ea0 chartreuse:7fff00 chocolate:d2691e coral:ff7f50 '
	+ 'cornflowerblue:6495ed cornsilk:fff8dc crimson:dc143c cyan:00ffff '
	+ 'darkblue:00008b darkcyan:008b8b darkgoldenrod:b8860b darkgray:a9a9a9 '
	+ 'darkgreen:006400 darkgrey:a9a9a9 darkkhaki:bdb76b darkmagenta:8b008b '
	+ 'darkolivegreen:556b2f darkorange:ff8c00 darkorchid:9932cc darkred:8b0000 '
	+ 'darksalmon:e9967a darkseagreen:8fbc8f darkslateblue:483d8b '
	+ 'darkslategray:2f4f4f darkslategrey:2f4f4f darkturquoise:00ced1 '
	+ 'darkviolet:9400d3 deeppink:ff1493 deepskyblue:00bfff dimgray:696969 '
	+ 'dimgrey:696969 dodgerblue:1e90ff firebrick:b22222 floralwhite:fffaf0 '
	+ 'forestgreen:228b22 fuchsia:ff00ff gainsboro:dcdcdc ghostwhite:f8f8ff '
	+ 'gold:ffd700 goldenrod:daa520 gray:808080 green:008000 greenyellow:adff2f '
	+ 'grey:808080 honeydew:f0fff0 hotpink:ff69b4 indianred:cd5c5c indigo:4b0082 '
	+ 'ivory:fffff0 khaki:f0e68c lavender:e6e6fa lavenderblush:fff0f5 '
	+ 'lawngreen:7cfc00 lemonchiffon:fffacd lightblue:add8e6 lightcoral:f08080 '
	+ 'lightcyan:e0ffff lightgoldenrodyellow:fafad2 lightgray:d3d3d3 '
	+ 'lightgreen:90ee90 lightgrey:d3d3d3 lightpink:ffb6c1 lightsalmon:ffa07a '
	+ 'lightseagreen:20b2aa lightskyblue:87cefa lightslategray:778899 '
	+ 'lightslategrey:778899 lightsteelblue:b0c4de lightyellow:ffffe0 lime:00ff00 '
	+ 'limegreen:32cd32 linen:faf0e6 magenta:ff00ff maroon:800000 '
	+ 'mediumaquamarine:66cdaa mediumblue:0000cd mediumorchid:ba55d3 '
	+ 'mediumpurple:9370db mediumseagreen:3cb371 mediumslateblue:7b68ee '
	+ 'mediumspringgreen:00fa9a mediumturquoise:48d1cc mediumvioletred:c71585 '
	+ 'midnightblue:191970 mintcream:f5fffa mistyrose:ffe4e1 moccasin:ffe4b5 '
	+ 'navajowhite:ffdead navy:000080 oldlace:fdf5e6 olive:808000 olivedrab:6b8e23 '
	+ 'orange:ffa500 orangered:ff4500 orchid:da70d6 palegoldenrod:eee8aa '
	+ 'palegreen:98fb98 paleturquoise:afeeee palevioletred:db7093 '
	+ 'papayawhip:ffefd5 peachpuff:ffdab9 peru:cd853f pink:ffc0cb plum:dda0dd '
	+ 'powderblue:b0e0e6 purple:800080 rebeccapurple:663399 red:ff0000 '
	+ 'rosybrown:bc8f8f royalblue:4169e1 saddlebrown:8b4513 salmon:fa8072 '
	+ 'sandybrown:f4a460 seagreen:2e8b57 seashell:fff5ee sienna:a0522d '
	+ 'silver:c0c0c0 skyblue:87ceeb slateblue:6a5acd slategray:708090 '
	+ 'slategrey:708090 snow:fffafa springgreen:00ff7f steelblue:4682b4 tan:d2b48c '
	+ 'teal:008080 thistle:d8bfd8 tomato:ff6347 turquoise:40e0d0 violet:ee82ee '
	+ 'wheat:f5deb3 white:ffffff whitesmoke:f5f5f5 yellow:ffff00 '
	+ 'yellowgreen:9acd32 '
).trim().split(/\s+/).map((pair) => pair.split(':')));

const clamp01 = (x) => Math.min(1, Math.max(0, x));

/**
 * A CSS colour as [r, g, b] in 0–255, or null. Accepts what
 * callout-definitions.js's validColor accepts (alpha is ignored: print has
 * no transparency to show it against).
 */
export function cssColorToRgb(value) {
	const v = String(value ?? '').trim().toLowerCase();
	const named = NAMED.get(v);
	if (named) return hexToRgb(named);
	let m = /^#([0-9a-f]{3,8})$/.exec(v);
	if (m) {
		const h = m[1];
		if (h.length === 3 || h.length === 4) return hexToRgb([...h.slice(0, 3)].map((c) => c + c).join(''));
		if (h.length === 6 || h.length === 8) return hexToRgb(h.slice(0, 6));
		return null;
	}
	m = /^(rgba?|hsla?)\((.*)\)$/.exec(v);
	if (!m) return null;
	const parts = m[2].split(/\s*[,/]\s*|\s+/).filter(Boolean);
	if (parts.length < 3) return null;
	if (m[1].startsWith('rgb')) {
		return parts.slice(0, 3).map((p) => Math.round(255 * clamp01(p.endsWith('%') ? parseFloat(p) / 100 : parseFloat(p) / 255)));
	}
	const h = ((parseFloat(parts[0]) % 360) + 360) % 360 / 360;
	const s = clamp01(parseFloat(parts[1]) / 100);
	const l = clamp01(parseFloat(parts[2]) / 100);
	return hslToRgb(h, s, l);
}

function hexToRgb(hex) {
	return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function hslToRgb(h, s, l) {
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const channel = (t) => {
		t = ((t % 1) + 1) % 1;
		if (t < 1 / 6) return p + (q - p) * 6 * t;
		if (t < 1 / 2) return q;
		if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
		return p;
	};
	return [h + 1 / 3, h, h - 1 / 3].map((t) => Math.round(255 * channel(t)));
}

// sRGB ⇄ OKLab (Björn Ottosson's matrices).
const toLinear = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLinear = (x) => Math.round(255 * clamp01(x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055));

function rgbToOklab([r, g, b]) {
	const [lr, lg, lb] = [r, g, b].map(toLinear);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
	];
}

function oklabToRgb([L, a, b]) {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3;
	return [
		4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
		-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
		-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
	].map(fromLinear);
}

/**
 * A custom colour made legible on a light page — the stylesheet's
 * `oklch(from <colour> min(l, 0.68) c h)`: lightness capped, chroma and hue
 * kept, then clipped back into sRGB. Most colours pass through unchanged.
 */
export function legibleOnLight(rgb) {
	const [L, a, b] = rgbToOklab(rgb);
	return L <= 0.68 ? rgb : oklabToRgb([0.68, a, b]);
}

/* --- Icons ------------------------------------------------------------------ */

const NUMBER = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/y;
const fmt = (x) => {
	const s = (Math.round(x * 1000) / 1000).toFixed(3).replace(/\.?0+$/, '');
	return s === '-0' ? '0' : s;
};

/**
 * SVG path data as absolute M/L/C/Z only: relative commands made absolute,
 * H/V as lines, S/Q/T and arcs as cubic Béziers. Null if it does not parse.
 * The result holds nothing but those four letters, digits, `.`, `-` and
 * spaces, so it is also safe to put into TeX as it stands.
 */
export function normaliseSvgPath(d) {
	const src = String(d ?? '');
	let i = 0;
	const skip = () => { while (i < src.length && /[\s,]/.test(src[i])) i++; };
	const number = () => {
		skip();
		NUMBER.lastIndex = i;
		const m = NUMBER.exec(src);
		if (!m) return null;
		i = NUMBER.lastIndex;
		return parseFloat(m[0]);
	};
	const flag = () => {
		skip();
		if (src[i] === '0' || src[i] === '1') return src[i++] === '1';
		return null;
	};
	const numbers = (count) => {
		const out = [];
		for (let k = 0; k < count; k++) {
			const n = number();
			if (n === null) return null;
			out.push(n);
		}
		return out;
	};

	const out = [];
	let cx = 0, cy = 0, sx = 0, sy = 0;
	let lastCubic = null, lastQuad = null;   // the previous segment's control point
	let command = null;

	const lineTo = (x, y) => { out.push(`L ${fmt(x)} ${fmt(y)}`); cx = x; cy = y; };
	const cubicTo = (x1, y1, x2, y2, x, y) => {
		out.push(`C ${fmt(x1)} ${fmt(y1)} ${fmt(x2)} ${fmt(y2)} ${fmt(x)} ${fmt(y)}`);
		lastCubic = [x2, y2];
		cx = x; cy = y;
	};
	const quadTo = (qx, qy, x, y) => {
		cubicTo(cx + 2 / 3 * (qx - cx), cy + 2 / 3 * (qy - cy), x + 2 / 3 * (qx - x), y + 2 / 3 * (qy - y), x, y);
		lastQuad = [qx, qy];
	};

	for (;;) {
		skip();
		if (i >= src.length) break;
		if (/[A-Za-z]/.test(src[i])) {
			command = src[i++];
		} else if (command === null) {
			return null;   // numbers before any command
		}
		const rel = command === command.toLowerCase();
		const ox = rel ? cx : 0, oy = rel ? cy : 0;
		const prevCubic = lastCubic, prevQuad = lastQuad;
		lastCubic = null; lastQuad = null;
		switch (command.toUpperCase()) {
		case 'M': {
			const p = numbers(2); if (!p) return null;
			cx = ox + p[0]; cy = oy + p[1]; sx = cx; sy = cy;
			out.push(`M ${fmt(cx)} ${fmt(cy)}`);
			command = rel ? 'l' : 'L';   // further pairs are lines
			break;
		}
		case 'L': { const p = numbers(2); if (!p) return null; lineTo(ox + p[0], oy + p[1]); break; }
		case 'H': { const p = numbers(1); if (!p) return null; lineTo(ox + p[0], cy); break; }
		case 'V': { const p = numbers(1); if (!p) return null; lineTo(cx, oy + p[0]); break; }
		case 'C': {
			const p = numbers(6); if (!p) return null;
			cubicTo(ox + p[0], oy + p[1], ox + p[2], oy + p[3], ox + p[4], oy + p[5]);
			break;
		}
		case 'S': {
			const p = numbers(4); if (!p) return null;
			const [x1, y1] = prevCubic ? [2 * cx - prevCubic[0], 2 * cy - prevCubic[1]] : [cx, cy];
			cubicTo(x1, y1, ox + p[0], oy + p[1], ox + p[2], oy + p[3]);
			break;
		}
		case 'Q': { const p = numbers(4); if (!p) return null; quadTo(ox + p[0], oy + p[1], ox + p[2], oy + p[3]); break; }
		case 'T': {
			const p = numbers(2); if (!p) return null;
			const [qx, qy] = prevQuad ? [2 * cx - prevQuad[0], 2 * cy - prevQuad[1]] : [cx, cy];
			quadTo(qx, qy, ox + p[0], oy + p[1]);
			break;
		}
		case 'A': {
			const r = numbers(3); if (!r) return null;
			const large = flag(), sweep = flag();
			if (large === null || sweep === null) return null;
			const p = numbers(2); if (!p) return null;
			const x = ox + p[0], y = oy + p[1];
			const curves = arcToCubics(cx, cy, r[0], r[1], r[2], large, sweep, x, y);
			if (curves === 'line') lineTo(x, y);
			else for (const c of curves) cubicTo(...c);
			cx = x; cy = y;
			lastCubic = null;
			break;
		}
		case 'Z':
			out.push('Z');
			cx = sx; cy = sy;
			command = null;   // Z takes no arguments; a number after it is an error
			break;
		default:
			return null;
		}
	}
	return out.length ? out.join(' ') : null;
}

// An elliptical arc as cubic Béziers of at most 90° each (SVG 1.1 F.6.5,
// endpoint to centre parameterisation). 'line' for a degenerate radius.
function arcToCubics(x1, y1, rx, ry, rotation, large, sweep, x2, y2) {
	if (x1 === x2 && y1 === y2) return [];
	rx = Math.abs(rx); ry = Math.abs(ry);
	if (rx === 0 || ry === 0) return 'line';
	const phi = rotation * Math.PI / 180, cos = Math.cos(phi), sin = Math.sin(phi);
	const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
	const x1p = cos * dx + sin * dy, y1p = -sin * dx + cos * dy;
	const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
	if (lambda > 1) { rx *= Math.sqrt(lambda); ry *= Math.sqrt(lambda); }
	const num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p;
	const den = rx * rx * y1p * y1p + ry * ry * x1p * x1p;
	let coef = Math.sqrt(Math.max(0, num / den));
	if (large === sweep) coef = -coef;
	const cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
	const ccx = cos * cxp - sin * cyp + (x1 + x2) / 2;
	const ccy = sin * cxp + cos * cyp + (y1 + y2) / 2;
	const angle = (ux, uy, vx, vy) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
	const start = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
	let sweepAngle = angle((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
	if (!sweep && sweepAngle > 0) sweepAngle -= 2 * Math.PI;
	if (sweep && sweepAngle < 0) sweepAngle += 2 * Math.PI;
	const segments = Math.max(1, Math.ceil(Math.abs(sweepAngle) / (Math.PI / 2) - 1e-9));
	const delta = sweepAngle / segments;
	const t = 4 / 3 * Math.tan(delta / 4);
	const point = (a) => {
		const ex = rx * Math.cos(a), ey = ry * Math.sin(a);
		return [cos * ex - sin * ey + ccx, sin * ex + cos * ey + ccy];
	};
	const tangent = (a) => {
		const ex = -rx * Math.sin(a), ey = ry * Math.cos(a);
		return [cos * ex - sin * ey, sin * ex + cos * ey];
	};
	const curves = [];
	for (let k = 0; k < segments; k++) {
		const a1 = start + k * delta, a2 = a1 + delta;
		const [p1x, p1y] = point(a1), [p2x, p2y] = point(a2);
		const [d1x, d1y] = tangent(a1), [d2x, d2y] = tangent(a2);
		curves.push([p1x + t * d1x, p1y + t * d1y, p2x - t * d2x, p2y - t * d2y, p2x, p2y]);
	}
	// Land exactly on the endpoint the path names.
	curves[curves.length - 1][4] = x2;
	curves[curves.length - 1][5] = y2;
	return curves;
}

/**
 * The icon as TeX, drawn in the current colour: [width, height, path] in the
 * glyph's own viewBox (Font Awesome's are 512 high), scaled so the viewBox is
 * 1em tall and lowered as Font Awesome's CSS lowers it (-0.125em). Empty if
 * the path does not parse.
 */
export function iconLatex([width, height, d]) {
	const path = normaliseSvgPath(d);
	if (!path || !(width > 0) || !(height > 0)) return '';
	requirePackage('graphicx');
	requirePackage('tikz');
	addPreamble('\\usetikzlibrary{svg.path}');
	return `\\raisebox{-0.125em}{\\resizebox{!}{1em}{\\begin{tikzpicture}[yscale=-1]`
		+ `\\useasboundingbox svg {M 0 0 L ${fmt(width)} 0 L ${fmt(width)} ${fmt(height)} L 0 ${fmt(height)} Z};`
		+ `\\fill svg {${path}};\\end{tikzpicture}}}`;
}

/* --- The box ------------------------------------------------------------------ */

/**
 * One callout as a tcolorbox. `rgb` is the accent; `icon` is TeX (or '');
 * `title` and `body` are TeX already. Folded callouts arrive here like any
 * other: print shows them expanded.
 */
// What the box draws behind its text, in each of its parts: the tint as a
// rounded rectangle, then the accent strip clipped to the same rounded shape.
// Defined once per box (a local macro, in `code=`) and handed to all four
// skins below: every tcolorbox skin sets its OWN interior code, so a box
// broken across pages — drawn with the first/middle/last skins — otherwise
// lost it and fell back to tcolorbox's default grey, strip and tint gone.
const INTERIOR = '\\fill[jmdcallout!12!white, rounded corners=3.75pt] (frame.south west) rectangle (frame.north east);'
	+ '\\begin{scope}\\clip[rounded corners=3.75pt] (frame.south west) rectangle (frame.north east);'
	+ '\\fill[jmdcallout] (frame.south west) rectangle ([xshift=3pt]frame.north west);\\end{scope}';

export function calloutLatex({ rgb, icon, title, body }) {
	requirePackage('tcolorbox');
	addPreamble('\\tcbuselibrary{skins,breakable}');
	const head = `{\\color{jmdcallout}\\bfseries ${icon ? `${icon}\\hspace{0.45em}` : ''}${title}}`;
	return [
		'\\begin{tcolorbox}[enhanced, breakable, frame hidden,',
		`  code={\\definecolor{jmdcallout}{RGB}{${rgb.join(',')}}\\def\\jmdcalloutinterior{${INTERIOR}}},`,
		'  boxrule=0pt, leftrule=3pt, arc=3.75pt, boxsep=0pt,',
		'  left=12pt, right=12pt, top=9pt, bottom=9pt,',
		'  interior code=\\jmdcalloutinterior,',
		'  skin first is subskin of={enhancedfirst}{frame hidden, interior code=\\jmdcalloutinterior},',
		'  skin middle is subskin of={enhancedmiddle}{frame hidden, interior code=\\jmdcalloutinterior},',
		'  skin last is subskin of={enhancedlast}{frame hidden, interior code=\\jmdcalloutinterior}]',
		body ? `${head}\\par\\vspace{4.5pt}` : head,
		...(body ? [body] : []),
		'\\end{tcolorbox}',
		'',
		'',
	].join('\n');
}
