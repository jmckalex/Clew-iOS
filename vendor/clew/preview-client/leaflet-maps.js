// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Interactive Leaflet maps in rendered notes (```leaflet fences — see
// src/engine/obsidian-fences.js for the config syntax). Leaflet loads
// lazily from the bundled assets the first time a document contains a map;
// tile layers come from OpenStreetMap by default (network required), or an
// `image:` map renders fully offline from a vault image.

// Assets root: the preview protocol in the app, ./assets on exported sites
// (the exporter sets window.__clewAssetBase before this bundle loads).
const ASSETS = () => window.__clewAssetBase ?? '/__clew_assets__';

let leafletLoading = null;

function loadLeaflet() {
	leafletLoading ??= new Promise((resolve, reject) => {
		const css = document.createElement('link');
		css.rel = 'stylesheet';
		css.href = `${ASSETS()}/leaflet/leaflet.css`;
		document.head.append(css);
		const script = document.createElement('script');
		script.src = `${ASSETS()}/leaflet/leaflet.js`;
		script.onload = () => {
			// Default marker icons resolve relative to the bundled assets.
			window.L.Icon.Default.prototype.options.imagePath = `${ASSETS()}/leaflet/images/`;
			resolve();
		};
		script.onerror = () => reject(new Error('Leaflet failed to load'));
		document.head.append(script);
	});
	return leafletLoading;
}

const post = (msg) => window.parent.postMessage({ source: 'clew-preview', ...msg }, '*');

// Named tile styles (all ToS-clean, attribution required). OSM is the
// default: CARTO's free basemaps began watermarking keyless requests with
// "API KEY REQUIRED" tiles, so voyager/light/dark remain available BY NAME
// for vaults that carry a key-fronting proxy or accept the watermark, but
// the out-of-the-box look must be a map, not a licensing banner.
const OSM_ATTR = '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>';
const CARTO_ATTR = OSM_ATTR + ' © <a href="https://carto.com/attributions">CARTO</a>';
const TILE_STYLES = {
	voyager: {
		url: 'https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png',
		attribution: CARTO_ATTR, subdomains: 'abcd', maxZoom: 20,
	},
	light: {
		url: 'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png',
		attribution: CARTO_ATTR, subdomains: 'abcd', maxZoom: 20,
	},
	dark: {
		url: 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png',
		attribution: CARTO_ATTR, subdomains: 'abcd', maxZoom: 20, dark: true,
	},
	satellite: {
		url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
		attribution: '© Esri, Maxar, Earthstar Geographics', maxZoom: 19, dark: true,
	},
	terrain: {
		url: 'https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png',
		attribution: OSM_ATTR + ', SRTM | © <a href="https://opentopomap.org">OpenTopoMap</a>', maxZoom: 17,
	},
	osm: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', attribution: OSM_ATTR, maxZoom: 19 },
};

export async function initLeafletMaps() {
	const pending = [...document.querySelectorAll('.clew-leaflet[data-leaflet]')]
		.filter((el) => !el.dataset.leafletInit);
	if (pending.length === 0) return;
	// Claim BEFORE the async library load: init runs both at page load and
	// after every morph, and an unclaimed div would be double-initialized
	// ("Map container is already initialized") by the second caller.
	for (const el of pending) el.dataset.leafletInit = '1';
	try {
		await loadLeaflet();
	} catch {
		for (const el of pending) el.textContent = '(map library failed to load)';
		return;
	}
	for (const el of pending) {
		try {
			buildMap(el, JSON.parse(el.dataset.leaflet));
		} catch (err) {
			el.textContent = `(map failed: ${err.message})`;
		}
	}
}

function buildMap(el, config) {
	const L = window.L;
	if (config.width) el.style.width = config.width;
	const mapOptions = {
		...(config.zoomDelta ? { zoomDelta: config.zoomDelta, zoomSnap: config.zoomDelta } : {}),
		...(config.noScrollZoom ? { scrollWheelZoom: false } : {}),
		...(config.noUI ? { zoomControl: false } : {}),
	};
	let map;
	if (config.imageUrl) {
		// Image-based map (a floor plan, a fantasy map): simple CRS over the
		// image's own pixel space (or explicit bounds), fit once loaded.
		map = L.map(el, { crs: L.CRS.Simple, minZoom: -4, ...mapOptions });
		const img = new Image();
		img.onload = () => {
			const bounds = config.bounds ?? [[0, 0], [img.naturalHeight, img.naturalWidth]];
			L.imageOverlay(config.imageUrl, bounds).addTo(map);
			map.fitBounds(bounds);
			decorate(map, el, config, []);
		};
		img.src = config.imageUrl;
		return;
	}
	const style = config.tileServer
		? { url: config.tileServer, attribution: '' }
		: TILE_STYLES[config.tiles] ?? TILE_STYLES.osm;
	map = L.map(el, {
		minZoom: config.minZoom,
		maxZoom: config.maxZoom ?? style.maxZoom,
		...mapOptions,
	}).setView([config.lat ?? 0, config.long ?? 0], config.zoom ?? 5);
	const tiles = L.tileLayer(style.url, {
		attribution: style.attribution,
		...(config.tileSubdomains ? { subdomains: config.tileSubdomains }
			: style.subdomains ? { subdomains: style.subdomains } : {}),
		...(style.maxZoom ? { maxZoom: style.maxZoom } : {}),
	});
	tiles.addTo(map);
	for (const overlay of config.tileOverlays ?? []) {
		L.tileLayer(overlay, { opacity: 0.7 }).addTo(map);
	}
	if (config.bounds) map.fitBounds(config.bounds);
	// Styles that are already dark (or photographic) skip the dark-theme dim.
	if (style.dark) el.classList.add('is-light');
	if (config.darkMode) el.classList.add('is-dark');

	const photoPins = addPhotoMarkers(map, config);
	decorate(map, el, config, photoPins);
}

// Everything beyond the base layer: markers of all kinds, circle overlays,
// GeoJSON, GPX tracks, image overlays, fitting, locking, distance tool.
function decorate(map, el, config, photoPins) {
	const L = window.L;
	const fitPoints = [...photoPins];

	addMarkers(map, config, fitPoints);
	for (const o of config.overlays ?? []) {
		const circle = L.circle([o.lat, o.long], {
			radius: o.radius,
			color: o.color ?? config.overlayColor ?? '#3388ff',
			weight: 2, fillOpacity: 0.15,
		}).addTo(map);
		if (o.label) circle.bindTooltip(o.label);
		fitPoints.push([o.lat, o.long]);
	}
	for (const overlay of config.imageOverlays ?? []) {
		if (overlay.url) L.imageOverlay(overlay.url, overlay.bounds, { opacity: 0.85 }).addTo(map);
	}

	const featureLayers = [];
	const featuresDone = Promise.all([
		...(config.geojsonFiles ?? []).map(async (url) => {
			try {
				const data = await (await fetch(url)).json();
				const layer = L.geoJSON(data, {
					style: { color: config.geojsonColor ?? '#3388ff', weight: 2 },
					onEachFeature: (feature, lyr) => {
						const name = feature?.properties?.name ?? feature?.properties?.title;
						if (name) lyr.bindTooltip(String(name));
					},
				}).addTo(map);
				featureLayers.push(layer);
			} catch { /* bad file — skipped */ }
		}),
		...(config.gpxFiles ?? []).map(async (url) => {
			try {
				const xml = new DOMParser().parseFromString(await (await fetch(url)).text(), 'text/xml');
				const points = [...xml.querySelectorAll('trkpt, rtept')]
					.map((pt) => [Number(pt.getAttribute('lat')), Number(pt.getAttribute('lon'))])
					.filter((pair) => pair.every(Number.isFinite));
				if (points.length < 2) return;
				const track = L.polyline(points, { color: config.gpxColor ?? '#e9973f', weight: 3 }).addTo(map);
				L.circleMarker(points[0], { radius: 5, color: '#44cf6e', fillOpacity: 1 }).addTo(map).bindTooltip('Start');
				L.circleMarker(points[points.length - 1], { radius: 5, color: '#fb464c', fillOpacity: 1 }).addTo(map).bindTooltip('End');
				for (const wpt of xml.querySelectorAll('wpt')) {
					const lat = Number(wpt.getAttribute('lat'));
					const lon = Number(wpt.getAttribute('lon'));
					const name = wpt.querySelector('name')?.textContent;
					if (Number.isFinite(lat) && Number.isFinite(lon)) {
						const m = L.circleMarker([lat, lon], { radius: 4, color: '#a882ff', fillOpacity: 1 }).addTo(map);
						if (name) m.bindTooltip(name);
					}
				}
				featureLayers.push(track);
			} catch { /* bad file — skipped */ }
		}),
	]);

	featuresDone.then(() => {
		if (config.zoomFeatures && featureLayers.length) {
			const bounds = featureLayers[0].getBounds();
			for (const layer of featureLayers.slice(1)) bounds.extend(layer.getBounds());
			map.fitBounds(bounds, { padding: [30, 30] });
		} else if ((config.lat === undefined || config.showAllMarkers) && fitPoints.length && !config.bounds) {
			map.fitBounds(fitPoints, { padding: [40, 40], maxZoom: config.zoom ?? 15 });
		}
	});

	if (config.lock) {
		map.dragging.disable();
		map.scrollWheelZoom.disable();
		map.doubleClickZoom.disable();
		map.boxZoom.disable();
		map.keyboard.disable();
	}
	if (config.recenter && config.lat !== undefined) {
		const home = { center: [config.lat, config.long ?? 0], zoom: config.zoom ?? 5 };
		let timer = null;
		map.on('dragend', () => {
			clearTimeout(timer);
			timer = setTimeout(() => map.flyTo(home.center, map.getZoom()), 900);
		});
	}
	wireDistanceTool(map, config);

	if (config.photosSkipped || config.photosError) {
		const note = L.control({ position: 'bottomleft' });
		note.onAdd = () => {
			const div = document.createElement('div');
			div.className = 'clew-leaflet-note';
			div.textContent = config.photosError
				?? `${config.photosSkipped} photo${config.photosSkipped === 1 ? '' : 's'} without location`;
			return div;
		};
		note.addTo(map);
	}
}

// Shift-click two points to measure the distance between them (unit: /
// scale: config keys); Escape or a third shift-click starts over.
function wireDistanceTool(map, config) {
	const L = window.L;
	const UNITS = { m: [1, 'm'], km: [0.001, 'km'], mi: [0.000621371, 'mi'], ft: [3.28084, 'ft'] };
	const [factor, suffix] = UNITS[config.unit] ?? UNITS.km;
	const scale = config.scale ?? 1;
	let first = null;
	let line = null;
	let control = null;
	const clear = () => {
		line?.remove();
		control?.remove();
		first = null; line = null; control = null;
	};
	map.on('click', (e) => {
		if (!e.originalEvent.shiftKey) return;
		if (first && line) clear();
		if (!first) {
			first = e.latlng;
			line = L.polyline([first, first], { dashArray: '6 6', weight: 2, color: '#fb464c' }).addTo(map);
			return;
		}
		line.setLatLngs([first, e.latlng]);
		const meters = map.distance(first, e.latlng) * scale;
		const display = `${(meters * factor).toLocaleString(undefined, { maximumFractionDigits: 2 })} ${suffix}`;
		control = L.control({ position: 'bottomleft' });
		control.onAdd = () => {
			const div = document.createElement('div');
			div.className = 'clew-leaflet-note';
			div.textContent = display;
			return div;
		};
		control.addTo(map);
		first = null;
	});
	map.getContainer().addEventListener('keydown', (e) => {
		if (e.key === 'Escape') clear();
	});
}

/** Photo pins: thumbnail popup + open-the-photo + a note wikilink (which
 *  Clew creates on first click — the "add notes to the day" workflow). */
function addPhotoMarkers(map, config) {
	const L = window.L;
	const points = [];
	for (const p of config.photoMarkers ?? []) {
		points.push([p.lat, p.long]);
		const marker = L.marker([p.lat, p.long]).addTo(map);
		const popup = document.createElement('div');
		popup.className = 'clew-leaflet-photo';
		const img = document.createElement('img');
		img.src = p.url;
		img.alt = p.name;
		img.title = 'Open the photo';
		img.addEventListener('click', () => post({ type: 'link-click', target: p.file, newTab: true }));
		const caption = document.createElement('div');
		caption.className = 'photo-caption';
		const note = document.createElement('a');
		note.href = '#';
		note.textContent = p.name;
		note.title = `Open (or create) the note “${p.name}”`;
		note.addEventListener('click', (e) => {
			e.preventDefault();
			post({ type: 'link-click', target: p.name, newTab: true });
		});
		caption.append(note);
		if (p.time) {
			const time = document.createElement('span');
			const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2})/.exec(p.time);
			time.textContent = m ? ` ${m[3]}/${m[2]} ${m[4]}` : '';
			caption.append(time);
		}
		popup.append(img, caption);
		marker.bindPopup(popup, { minWidth: 180 });
	}
	return points;
}

const TYPE_COLORS = {
	red: '#fb464c', orange: '#e9973f', yellow: '#e0de71', green: '#44cf6e',
	teal: '#53dfdd', blue: '#3388ff', purple: '#a882ff',
};

function addMarkers(map, config, fitPoints = []) {
	const L = window.L;
	const place = (m) => {
		fitPoints.push([m.lat, m.long]);
		const color = TYPE_COLORS[m.type?.toLowerCase?.()];
		return color
			? L.circleMarker([m.lat, m.long], { radius: 8, color, fillColor: color, fillOpacity: 0.85, weight: 2 }).addTo(map)
			: L.marker([m.lat, m.long]).addTo(map);
	};
	for (const m of [...(config.markers ?? []), ...(config.noteMarkers ?? [])]) {
		const marker = place(m);
		if (m.link) {
			// A wikilink marker: popup with an internal link that opens in the app.
			const a = document.createElement('a');
			a.href = '#';
			a.textContent = m.label ?? m.link;
			a.addEventListener('click', (e) => {
				e.preventDefault();
				post({ type: 'link-click', target: m.link, newTab: e.metaKey || e.ctrlKey });
			});
			marker.bindPopup(a);
		} else if (m.label) {
			marker.bindPopup(document.createTextNode(m.label));
		}
	}
}
