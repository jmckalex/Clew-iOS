// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Obsidian-compatibility fences for the render worker. Obsidian writes
// mermaid diagrams as ```mermaid code fences; jmarkdown's native forms are
// :::mermaid / @begin(mermaid). This extension makes the fence render as a
// client-side mermaid diagram in HTML previews. (For LaTeX export use the
// native forms — those rasterise via mmdc; a fence exports as nothing.)
//
// Loaded via the vault's generated .jmarkdown/config.json:
//     "Extensions": [..., "mermaidFence from <dist>/engine/obsidian-fences.js"]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveTarget, resolveFileTarget, sitePath } from './wikilinks.js';
import { exifGps } from './exif-gps.js';

const escapeHtml = (s) =>
	s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const mermaidFence = {
	name: 'mermaidFence',
	level: 'block',
	start(src) { return src.match(/^```mermaid/m)?.index; },
	tokenizer(src) {
		const match = /^```mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'mermaidFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		// mermaid.js reads the element's textContent, so entity-escaping is safe
		// (and keeps diagram text from being parsed as HTML).
		return `<div class="mermaid">\n${escapeHtml(token.text)}\n</div>\n`;
	},
};

/**
 * Parse a ```leaflet fence body (obsidian-leaflet-compatible subset):
 * `key: value` lines — lat, long, zoom, minZoom, maxZoom, height,
 * defaultZoom (alias of zoom), tileServer, darkMode — plus repeatable
 * `marker: lat, long[, link or label]` lines and `image: [[file]]` for
 * image-based maps. Unknown keys are ignored. Pure; exported for tests.
 */
export function parseLeafletConfig(body) {
	const config = { markers: [] };
	const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : undefined);
	const bool = (v) => v === 'true' || v === '';
	const wikiOrText = (v) => {
		const wiki = /\[\[([^\[\]|]+)\]\]/.exec(v);
		return (wiki ? wiki[1] : v).trim();
	};
	const push = (key, v) => { (config[key] ??= []).push(v); };
	for (const line of body.split('\n')) {
		const m = /^\s*([A-Za-z]+)\s*:\s*(.*?)\s*$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const value = m[2];
		if (key === 'lat') config.lat = num(value);
		else if (key === 'long' || key === 'lng') config.long = num(value);
		else if (key === 'zoom' || key === 'defaultzoom') config.zoom = num(value);
		else if (key === 'minzoom') config.minZoom = num(value);
		else if (key === 'maxzoom') config.maxZoom = num(value);
		else if (key === 'height') config.height = /^\d+$/.test(value) ? `${value}px` : value;
		else if (key === 'tileserver') config.tileServer = value;
		else if (key === 'tileoverlay') push('tileOverlays', value);
		else if (key === 'tilesubdomains') config.tileSubdomains = value.replace(/[^a-z0-9]/gi, '');
		else if (key === 'tiles' || key === 'style') config.tiles = value.toLowerCase();
		else if (key === 'width') config.width = /^\d+$/.test(value) ? `${value}px` : value;
		else if (key === 'zoomdelta') config.zoomDelta = num(value);
		else if (key === 'unit') config.unit = value.toLowerCase();
		else if (key === 'scale') config.scale = num(value);
		else if (key === 'bounds') {
			try {
				const b = JSON.parse(value);
				if (Array.isArray(b) && b.length === 2) config.bounds = b;
			} catch { /* ignored */ }
		}
		else if (key === 'noscrollzoom') config.noScrollZoom = bool(value);
		else if (key === 'noui') config.noUI = bool(value);
		else if (key === 'lock') config.lock = bool(value);
		else if (key === 'recenter') config.recenter = bool(value);
		else if (key === 'zoomfeatures') config.zoomFeatures = bool(value);
		else if (key === 'showallmarkers') config.showAllMarkers = bool(value);
		else if (key === 'overlaycolor') config.overlayColor = value;
		else if (key === 'geojsoncolor') config.geojsonColor = value;
		else if (key === 'gpxcolor') config.gpxColor = value;
		else if (key === 'geojson') push('geojsonFiles', wikiOrText(value));
		else if (key === 'gpx') push('gpxFiles', wikiOrText(value));
		else if (key === 'markerfile') push('markerFiles', wikiOrText(value));
		else if (key === 'markerfolder') push('markerFolders', wikiOrText(value));
		else if (key === 'markertag') push('markerTags', value.replace(/^#/, '').toLowerCase());
		else if (key === 'imageoverlay') {
			// imageOverlay: [[file.png]], [[lat,long],[lat,long]]
			const file = wikiOrText(value.split(',')[0]);
			const b = /\[\s*\[([^\]]+)\]\s*,\s*\[([^\]]+)\]\s*\]\s*$/.exec(value);
			if (b) {
				const p1 = b[1].split(',').map(Number);
				const p2 = b[2].split(',').map(Number);
				if (p1.every(Number.isFinite) && p2.every(Number.isFinite)) {
					push('imageOverlays', { file, bounds: [p1, p2] });
				}
			}
		}
		else if (key === 'overlay') {
			// overlay: [color,] lat, long, radius[unit] [, label]
			const parts = value.split(',').map((v) => v.trim());
			if (parts.length && !/^-?[\d.]+$/.test(parts[0])) {
				var overlayColor = parts.shift();
			}
			const lat = num(parts[0]);
			const long = num(parts[1]);
			const r = /^([\d.]+)\s*(m|km|mi|ft)?$/.exec(parts[2] ?? '');
			if (lat !== undefined && long !== undefined && r) {
				const factor = { m: 1, km: 1000, mi: 1609.34, ft: 0.3048 }[r[2] ?? 'm'];
				push('overlays', {
					lat, long, radius: Number(r[1]) * factor,
					...(overlayColor ? { color: overlayColor } : {}),
					...(parts[3] ? { label: parts.slice(3).join(', ') } : {}),
				});
			}
		}
		else if (key === 'darkmode') config.darkMode = value === 'true';
		else if (key === 'image') {
			const wiki = /\[\[([^\[\]|]+)\]\]/.exec(value);
			config.image = (wiki ? wiki[1] : value).trim();
		} else if (key === 'photos') {
			const wiki = /\[\[([^\[\]|]+)\]\]/.exec(value);
			config.photos = (wiki ? wiki[1] : value).trim();
		} else if (key === 'marker') {
			// marker: [type,] lat, long [, [[link]] or label text]
			const parts = value.split(',').map((s) => s.trim());
			let type = null;
			if (parts.length && !/^-?[\d.]+$/.test(parts[0])) type = parts.shift(); // optional type
			const lat = num(parts[0]);
			const long = num(parts[1]);
			if (lat === undefined || long === undefined) continue;
			const rest = parts.slice(2).join(', ');
			const wiki = /\[\[([^\[\]|]+)(?:\|([^\[\]]+))?\]\]/.exec(rest);
			const marker = { lat, long };
			if (type && type.toLowerCase() !== 'default') marker.type = type;
			if (wiki) {
				marker.link = wiki[1].trim();
				marker.label = (wiki[2] ?? wiki[1]).trim();
			} else if (rest) {
				marker.label = rest;
			}
			config.markers.push(marker);
		}
	}
	return config;
}

// ```leaflet fences → an interactive Leaflet.js map, initialized client-side
// by the preview client (leaflet-maps.js) from the JSON config carried in
// the data attribute. Tiles come from OpenStreetMap by default (network);
// `image: [[file.png]]` makes an offline image-based map instead.
export const leafletFence = {
	name: 'leafletFence',
	level: 'block',
	start(src) { return src.match(/^```leaflet/m)?.index; },
	tokenizer(src) {
		const match = /^```leaflet[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'leafletFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		const config = parseLeafletConfig(token.text);
		for (const key of ['geojsonFiles', 'gpxFiles']) {
			if (!config[key]) continue;
			config[key] = config[key]
				.map((f) => { const rel = resolveFileTarget(f); return rel ? sitePath(rel) : null; })
				.filter(Boolean);
		}
		for (const overlay of config.imageOverlays ?? []) {
			const rel = resolveFileTarget(overlay.file);
			overlay.url = rel ? sitePath(rel) : null;
			delete overlay.file;
		}
		if (config.markerFiles || config.markerFolders || config.markerTags) {
			config.noteMarkers = collectNoteMarkers(config);
			delete config.markerFiles;
			delete config.markerFolders;
			delete config.markerTags;
		}
		if (config.photos) {
			const scanned = scanPhotoFolder(config.photos);
			config.photoMarkers = scanned.markers;
			config.photosSkipped = scanned.skipped;
			config.photosError = scanned.error;
			delete config.photos;
		}
		if (config.image) {
			// Resolve the image like any attachment wikilink and emit its URL.
			const rel = resolveFileTarget(config.image);
			config.imageUrl = rel ? sitePath(rel) : null;
		}
		const json = JSON.stringify(config)
			.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
		const height = config.height ?? '400px';
		return `<div class="clew-leaflet" data-leaflet="${json}" style="height:${height}"></div>\n`;
	},
};

// ---- note markers (markerFile / markerFolder / markerTag) ------------------

/**
 * Extract a map marker from a note's frontmatter: `location: [lat, long]`
 * places it, `mapmarker: <type>` colors it, `map-label:` overrides the
 * label. Pure; exported for tests.
 */
export function noteMarkerFrom(text, notePath) {
	const fm = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!fm) return null;
	const loc = /^location:\s*\[?\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\]?\s*$/m.exec(fm[1]);
	if (!loc) return null;
	const lat = Number(loc[1]);
	const long = Number(loc[2]);
	if (!Number.isFinite(lat) || !Number.isFinite(long)) return null;
	const type = /^mapmarker:\s*(\S+)\s*$/m.exec(fm[1])?.[1];
	const label = /^map-label:\s*(.+?)\s*$/m.exec(fm[1])?.[1];
	const name = notePath.split('/').pop().replace(/\.(md|jmd)$/i, '');
	return {
		lat, long, link: notePath,
		label: label ?? name,
		...(type ? { type } : {}),
	};
}

/** Does a note's frontmatter carry the tag (tags: [..] or list form)? */
export function noteHasTag(text, tag) {
	const fm = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!fm) return false;
	const inline = /^tags:\s*\[([^\]]*)\]\s*$/m.exec(fm[1]);
	if (inline) {
		return inline[1].split(',').some((t) => t.trim().replace(/^#/, '').toLowerCase() === tag);
	}
	const block = /^tags:\s*\n((?:\s*-\s*.+\n?)+)/m.exec(fm[1]);
	if (block) {
		return block[1].split('\n').some((line) =>
			line.replace(/^\s*-\s*/, '').trim()
				.replace(/^["']|["']$/g, '').replace(/^#/, '').toLowerCase() === tag);
	}
	return false;
}

const NOTE_FILE = /\.(md|jmd)$/i;

function collectNoteMarkers(config) {
	const root = process.env.CLEW_VAULT_ROOT;
	if (!root) return [];
	const markers = [];
	const seen = new Set();
	const add = (abs) => {
		const rel = path.relative(root, abs).split(path.sep).join('/');
		if (seen.has(rel)) return;
		seen.add(rel);
		try {
			const marker = noteMarkerFrom(fs.readFileSync(abs, 'utf8'), rel);
			if (marker) markers.push(marker);
		} catch { /* unreadable — skipped */ }
	};
	for (const target of config.markerFiles ?? []) {
		const rel = resolveTarget(target);
		if (rel) add(path.join(root, rel));
	}
	const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);
	const walk = (dir, filter) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const abs = path.join(dir, entry.name);
			if (entry.isDirectory()) walk(abs, filter);
			else if (NOTE_FILE.test(entry.name) && (!filter || filter(abs))) add(abs);
		}
	};
	for (const folder of config.markerFolders ?? []) {
		const dir = resolvePhotoFolder(folder);
		if (dir) walk(dir, null);
	}
	for (const tag of config.markerTags ?? []) {
		walk(root, (abs) => {
			try { return noteHasTag(fs.readFileSync(abs, 'utf8'), tag); } catch { return false; }
		});
	}
	return markers;
}

// ---- photo maps ------------------------------------------------------------

const JPEG_EXT = /\.(jpe?g)$/i;
const HEIC_EXT = /\.(heic|heif)$/i;

/** Resolve a photos folder: vault-relative path first, else a walk for a
 *  directory whose path ends with the target (case-insensitive). */
function resolvePhotoFolder(target) {
	const root = process.env.CLEW_VAULT_ROOT;
	if (!root) return null;
	const direct = path.join(root, target);
	if (fs.existsSync(direct) && fs.statSync(direct).isDirectory()) return direct;
	const wanted = ('/' + target).toLowerCase();
	const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);
	const stack = [''];
	while (stack.length) {
		const rel = stack.pop();
		let entries;
		try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (('/' + childRel).toLowerCase().endsWith(wanted)) return path.join(root, childRel);
			stack.push(childRel);
		}
	}
	return null;
}

/**
 * Scan a vault folder for geotagged photos → map markers. HEIC files are
 * auto-converted to JPEG alongside the original (macOS sips; skipped with
 * a count elsewhere) so iPhone photos never need manual conversion; the
 * conversion runs once — an existing, newer .jpg wins.
 */
function scanPhotoFolder(target) {
	const root = process.env.CLEW_VAULT_ROOT;
	const dir = resolvePhotoFolder(target);
	if (!dir) return { markers: [], skipped: 0, error: `folder not found: ${target}` };
	let names;
	try { names = fs.readdirSync(dir); } catch { return { markers: [], skipped: 0, error: `unreadable: ${target}` }; }

	// HEIC → JPEG first, so the JPEG pass below picks the conversions up.
	if (process.platform === 'darwin') {
		for (const name of names) {
			if (!HEIC_EXT.test(name)) continue;
			const src = path.join(dir, name);
			const dst = src.replace(HEIC_EXT, '.jpg');
			try {
				if (fs.existsSync(dst) && fs.statSync(dst).mtimeMs >= fs.statSync(src).mtimeMs) continue;
				execFileSync('sips', ['-s', 'format', 'jpeg', src, '--out', dst], { stdio: 'ignore' });
			} catch { /* counted as skipped below when no jpg exists */ }
		}
		names = fs.readdirSync(dir);
	}

	const markers = [];
	let skipped = 0;
	for (const name of names.sort()) {
		if (HEIC_EXT.test(name)) {
			// Only counts as skipped when conversion didn't produce a JPEG.
			if (!names.includes(name.replace(HEIC_EXT, '.jpg'))) skipped++;
			continue;
		}
		if (!JPEG_EXT.test(name)) continue;
		const abs = path.join(dir, name);
		let gps = null;
		try {
			// EXIF lives at the front of the file; 256KB is generous.
			const fd = fs.openSync(abs, 'r');
			const head = Buffer.alloc(Math.min(262144, fs.statSync(abs).size));
			fs.readSync(fd, head, 0, head.length, 0);
			fs.closeSync(fd);
			gps = exifGps(head);
		} catch { /* unreadable — skipped */ }
		if (!gps) { skipped++; continue; }
		const rel = path.relative(root, abs).split(path.sep).join('/');
		markers.push({
			lat: gps.lat, long: gps.long,
			url: sitePath(rel), file: rel,
			name: name.replace(JPEG_EXT, ''),
			...(gps.time ? { time: gps.time } : {}),
		});
	}
	return { markers, skipped, error: null };
}

export default [mermaidFence, leafletFence];
