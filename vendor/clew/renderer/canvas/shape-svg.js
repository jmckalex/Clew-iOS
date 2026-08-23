// Shared SVG builders for canvas shapes — used by the editable canvas view
// and by read-only canvas embeds in note previews (preview-client). Colors
// are emitted as var(--clew-canvas-*) references; the surrounding document
// (app theme or preview.css) supplies the values.
import { seededRand, roughLine, roughRect, roughDiamond, roughEllipse } from './rough.js';
import * as model from './canvas-model.js';

export function inkColor(color) {
	return color === 'ink' ? 'var(--clew-canvas-ink)' : `var(--clew-canvas-${color})`;
}

export function edgeColor(color) {
	return color ? inkColor(color) : 'var(--clew-canvas-edge)';
}

export function escapeXml(text) {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** Text-shape font stacks (real font files are never bundled; these are
 *  system stacks so PNG export rasterizes identically). */
export const TEXT_FONT_STACKS = {
	hand: "'Bradley Hand', 'Marker Felt', 'Segoe Print', 'Comic Sans MS', cursive",
	sans: "'Avenir Next', -apple-system, 'Segoe UI', sans-serif",
	serif: "'Iowan Old Style', Georgia, 'Times New Roman', serif",
	mono: "'SF Mono', Menlo, Consolas, monospace",
};

/** Sloppiness → rough amplitude. 0 = clean (no rough path at all). */
const ROUGH_AMP = { 1: 2.2, 2: 4.6 };

const DASH = { dashed: '10 8', dotted: '2 7' };

/** stroke-dasharray fragment for a shape/edge stroke style ('' when solid). */
export function dashStyle(strokeStyle) {
	return DASH[strokeStyle] ? `stroke-dasharray:${DASH[strokeStyle]};` : '';
}

// Hachure fill: parallel lines at -41° clipped to the shape, deterministic
// per shape id. Excalidraw's iconic fill.
function hachure(shape, r, color, rand) {
	const gap = 7;
	const angle = -41 * Math.PI / 180;
	const dx = Math.cos(angle), dy = Math.sin(angle);
	// Perpendicular sweep across the bounding box diagonal.
	const px = -dy, py = dx;
	const diag = Math.hypot(r.width, r.height);
	const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
	const lines = [];
	for (let offset = -diag / 2; offset <= diag / 2; offset += gap) {
		const ox = cx + px * offset, oy = cy + py * offset;
		const jx = jitterVal(rand, 1.6), jy = jitterVal(rand, 1.6);
		lines.push(`M ${r2(ox - dx * diag / 2 + jx)} ${r2(oy - dy * diag / 2 + jy)}`
			+ ` L ${r2(ox + dx * diag / 2 + jx)} ${r2(oy + dy * diag / 2 + jy)}`);
	}
	const clipId = `hch-${shape.id}`;
	const geo = shape.kind === 'rect'
		? `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="6"/>`
		: shape.kind === 'ellipse'
			? `<ellipse cx="${cx}" cy="${cy}" rx="${r.width / 2}" ry="${r.height / 2}"/>`
			: `<polygon points="${cx},${r.y} ${r.x + r.width},${cy} ${cx},${r.y + r.height} ${r.x},${cy}"/>`;
	return `<clipPath id="${clipId}">${geo}</clipPath>`
		+ `<path clip-path="url(#${clipId})" d="${lines.join(' ')}"`
		+ ` style="stroke:${color};stroke-width:1.4;fill:none;opacity:0.6"/>`;
}

const jitterVal = (rand, amp) => (rand() - 0.5) * 2 * amp;
const r2 = (n) => Math.round(n * 100) / 100;

export function shapeSvg(shape, selected, temp = false) {
	const color = inkColor(shape.color);
	const cls = `canvas-shape${selected ? ' is-selected' : ''}${temp ? ' is-temp' : ''}`;
	const rough = shape.rough ?? 1;
	const amp = ROUGH_AMP[rough];
	const rand = seededRand(shape.id);
	const fillColor = `color-mix(in srgb, ${color} 22%, transparent)`;
	const r = model.shapeRect(shape);
	const gOpen = `<g class="${cls}" data-id="${shape.id}"`
		+ (shape.opacity ? ` opacity="${shape.opacity}"` : '') + `>`;
	const dash = dashStyle(shape.strokeStyle);
	const label = shape.label
		? `<text class="canvas-shape-label" x="${r.x + r.width / 2}" y="${r.y + r.height / 2}" text-anchor="middle" dominant-baseline="middle">${escapeXml(shape.label)}</text>`
		: '';

	if (shape.kind === 'text') {
		const font = TEXT_FONT_STACKS[shape.font] ?? TEXT_FONT_STACKS.hand;
		const size = shape.fontSize ?? 20;
		return gOpen
			+ `<foreignObject x="${r.x}" y="${r.y}" width="${Math.max(10, r.width)}" height="${Math.max(10, r.height)}">`
			+ `<div xmlns="http://www.w3.org/1999/xhtml" class="canvas-shape-text" style="`
			+ `font-family:${escapeXml(font)};font-size:${size}px;color:${color};`
			+ `width:100%;height:100%;white-space:pre-wrap;overflow-wrap:anywhere;`
			+ `overflow:hidden;line-height:1.3;user-select:none;">`
			+ `${escapeXml(shape.text ?? '')}</div></foreignObject></g>`;
	}

	const boxy = !['line', 'arrow'].includes(shape.kind);
	if (boxy) {
		// Fill first (solid translucent underlay or hachure), then outline.
		const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
		let underlay = '';
		if (shape.fill && shape.fillStyle === 'hachure') {
			underlay = hachure(shape, r, color, rand);
		} else if (shape.fill) {
			underlay = shape.kind === 'rect' ? `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="6" style="fill:${fillColor};stroke:none"/>`
				: shape.kind === 'ellipse' ? `<ellipse cx="${cx}" cy="${cy}" rx="${r.width / 2}" ry="${r.height / 2}" style="fill:${fillColor};stroke:none"/>`
				: `<polygon points="${cx},${r.y} ${r.x + r.width},${cy} ${cx},${r.y + r.height} ${r.x},${cy}" style="fill:${fillColor};stroke:none"/>`;
		}
		let outline;
		if (amp) {
			const d = shape.kind === 'rect' ? roughRect(r.x, r.y, r.width, r.height, rand, amp)
				: shape.kind === 'ellipse' ? roughEllipse(cx, cy, r.width / 2, r.height / 2, rand, amp)
				: roughDiamond(r.x, r.y, r.width, r.height, rand, amp);
			outline = `<path d="${d}" style="stroke:${color};fill:none;${dash}"/>`;
		} else {
			outline = shape.kind === 'rect' ? `<rect x="${r.x}" y="${r.y}" width="${r.width}" height="${r.height}" rx="8" style="stroke:${color};fill:none;${dash}"/>`
				: shape.kind === 'ellipse' ? `<ellipse cx="${cx}" cy="${cy}" rx="${r.width / 2}" ry="${r.height / 2}" style="stroke:${color};fill:none;${dash}"/>`
				: `<polygon points="${cx},${r.y} ${r.x + r.width},${cy} ${cx},${r.y + r.height} ${r.x},${cy}" style="stroke:${color};fill:none;${dash}"/>`;
		}
		return `${gOpen}${underlay}${outline}${label}</g>`;
	}

	// line / arrow: endpoints are (x,y) → (x+width, y+height).
	const x2 = shape.x + shape.width, y2 = shape.y + shape.height;
	const angle = Math.atan2(y2 - shape.y, x2 - shape.x) * 180 / Math.PI;
	const shaft = amp
		? `<path d="${roughLine(shape.x, shape.y, x2, y2, rand, amp)}" style="stroke:${color};fill:none;${dash}"/>`
		: `<line x1="${shape.x}" y1="${shape.y}" x2="${x2}" y2="${y2}" style="stroke:${color};${dash}"/>`;
	const head = shape.kind === 'arrow'
		? `<path style="fill:${color}" transform="translate(${x2},${y2}) rotate(${angle})" d="M 2 0 L -11 6 L -11 -6 Z"/>`
		: '';
	const labelMid = shape.label
		? `<text class="canvas-shape-label" x="${(shape.x + x2) / 2}" y="${(shape.y + y2) / 2 - 8}" text-anchor="middle">${escapeXml(shape.label)}</text>`
		: '';
	return `${gOpen}${shaft}${head}${labelMid}</g>`;
}

/** One ink stroke as an SVG fragment (color, width, optional opacity). */
export function strokeSvg(stroke) {
	return `<path class="canvas-stroke" d="${model.strokePath(stroke)}"`
		+ ` style="stroke:${inkColor(stroke.color)};stroke-width:${stroke.width}`
		+ (stroke.opacity ? `;opacity:${stroke.opacity}` : '') + `"/>`;
}

/** One edge (path + arrowheads + optional label) as an SVG fragment.
 *  `style` is the clew edgeStyles entry: { dash?, path? }. */
export function edgeSvg(edge, fromNode, toNode, selected = false, style = null) {
	const geo = model.edgeGeometry(fromNode, edge.fromSide, toNode, edge.toSide, style?.path ?? 'bezier');
	const colorAttr = edgeColor(edge.color);
	const dash = dashStyle(style?.dash);
	const head = (point, angle) =>
		`<path class="canvas-edge-head" style="fill:${colorAttr}" transform="translate(${point.x},${point.y}) rotate(${angle * 180 / Math.PI})" d="M 2 0 L -10 5.5 L -10 -5.5 Z"/>`;
	return `<g class="canvas-edge${selected ? ' is-selected' : ''}" data-id="${edge.id}">`
		+ `<path class="canvas-edge-line" d="${geo.d}" style="stroke:${colorAttr};${dash}"/>`
		+ (edge.toEnd === 'none' ? '' : head(geo.to, geo.angle))
		+ (edge.fromEnd === 'arrow' ? head(geo.from, geo.fromAngle) : '')
		+ (edge.label ? `<text class="canvas-edge-label" x="${geo.mid.x}" y="${geo.mid.y - 6}" text-anchor="middle">${escapeXml(edge.label)}</text>` : '')
		+ `</g>`;
}
