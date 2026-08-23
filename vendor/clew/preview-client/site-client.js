// Runtime for EXPORTED vault websites (File → Export Vault as Website):
// everything a static page needs that isn't plain HTML — interactive maps
// and mermaid diagrams. No app bridge, no morphs, no note API: exported
// pages are documents. window.__clewAssetBase (set by the exporter, per
// page depth) points leaflet at the copied assets.
import { initLeafletMaps } from './leaflet-maps.js';

initLeafletMaps();

if (window.mermaid) {
	window.mermaid.initialize({ startOnLoad: false, theme: 'dark' });
	window.mermaid.run({ querySelector: '.mermaid' }).catch?.(() => {});
}
