// "Export as HTML" on the iPad: the note as reading view DREW it, in one
// file with nothing to run and nothing to fetch.
//
// The engine's HTML is not that page. Its TikZ and MetaPost figures are
// source text that only the preview client draws, and its styles and
// scripts are /__clew_assets__/ URLs that resolve only inside Clew (34 KB of
// unstyled source for Features/Diagrams). Clew's manual promises a
// standalone page whose diagrams render. So the share is a SNAPSHOT: the
// bridge loads the note's own clew-preview:// document in the hidden web
// view the PDF export uses (PrintPDF.swift), waits for the same ready probe
// (figures typeset, Mermaid drawn, MathJax and fonts done), and runs
// SNAPSHOT_SCRIPT in a content world of its own, where the note's scripts
// cannot reach it. The script serializes the drawn page into an inert
// document and returns it:
//   - no scripts at all: <script> and every other active element go, and so
//     do on* attributes and javascript: URLs; a CSP meta forbids scripts
//     besides;
//   - styles inlined (the stylesheets, the page's own and adopted sheets,
//     and what their url()s name);
//   - the drawn SVGs kept: figures, MathJax (its per-equation glyph cache),
//     Mermaid;
//   - vault images inlined as data: URLs, up to SHARE_IMAGE_MAX each and
//     SHARE_IMAGES_MAX per share; past either, a placeholder that names the
//     file by its vault-relative name;
//   - apps, decks, PDFs, drawings, canvases and other frames: a one-line
//     placeholder naming what it was;
//   - wikilinks and other in-Clew links: plain text. http(s), mailto and
//     same-page #anchors stay.
// The shim then checks the finished string itself (shareLeaks) and refuses
// to share a page that still carries a script or an internal path.

export const SHARE_IMAGE_MAX = 2 * 1024 * 1024;
export const SHARE_IMAGES_MAX = 10 * 1024 * 1024;

// The body of an async function (WKWebView callAsyncJavaScript), given
// `maxImage` and `maxTotal`; it returns { html, stats }. String.raw, so the
// regular expressions keep their backslashes; it holds no backtick and no
// dollar-brace.
export const SNAPSHOT_SCRIPT = String.raw`
const t0 = performance.now();
const session = location.pathname.split('/').filter(Boolean)[0] || '';
const stats = { images: 0, imageBytes: 0, held: [], embeds: [], links: 0, scripts: 0, handlers: 0, canvases: 0, shadowHosts: 0 };
let budget = maxTotal;
const mb = (n) => (n / 1048576).toFixed(1) + ' MB';

// The vault-relative name of a URL on this document's origin under this
// session; null for Clew's own assets and for anything else.
const vaultName = (raw) => {
	if (!String(raw || '').trim()) return null;
	try {
		const u = new URL(raw, location.href);
		if (u.origin !== location.origin) return null;
		const parts = u.pathname.split('/').filter(Boolean).map((p) => decodeURIComponent(p));
		if (parts[0] !== session) return null;
		parts.shift();
		return parts.join('/') || null;
	} catch (e) { return null; }
};
const isWeb = (raw) => /^(https?:|mailto:|tel:)/i.test(String(raw || '').trim());
const isData = (raw) => /^data:/i.test(String(raw || '').trim());
const local = (raw) => {
	try { const u = new URL(raw, location.href); return u.origin === location.origin || u.protocol === 'blob:'; } catch (e) { return false; }
};
const toDataUrl = (blob) => new Promise((resolve, reject) => {
	const r = new FileReader();
	r.onload = () => resolve(r.result);
	r.onerror = () => reject(r.error);
	r.readAsDataURL(blob);
});
// A file of this page's, as a data: URL within the caps, or why not.
const inline = async (raw) => {
	let blob;
	try {
		const res = await fetch(new URL(raw, location.href).href);
		if (!res.ok) return { held: 'not found' };
		blob = await res.blob();
	} catch (e) { return { held: 'not found' }; }
	if (blob.size > maxImage) return { held: 'too large to include (' + mb(blob.size) + ')' };
	if (blob.size > budget) return { held: 'over the ' + mb(maxTotal) + ' this page allows for images' };
	budget -= blob.size;
	return { data: await toDataUrl(blob), bytes: blob.size };
};

// ---- the live page: state its markup does not carry --------------------------
for (const c of document.querySelectorAll('canvas')) {
	let png = '';
	try { png = c.toDataURL('image/png'); } catch (e) { png = ''; }
	c.setAttribute('data-clew-share-png', png);
	stats.canvases++;
}
for (const el of document.querySelectorAll('input, textarea, select')) {
	if (el.type === 'checkbox' || el.type === 'radio') el.toggleAttribute('checked', el.checked);
	else if (el.tagName === 'TEXTAREA') el.textContent = el.value;
	else if (el.tagName === 'SELECT') { for (const o of el.options) o.toggleAttribute('selected', o.selected); }
	else if (el.type !== 'password' && el.type !== 'file') el.setAttribute('value', el.value);
}
for (const el of document.querySelectorAll('*')) if (el.shadowRoot) stats.shadowHosts++;
const adopted = [...(document.adoptedStyleSheets || [])].map((s) => {
	try { return [...s.cssRules].map((r) => r.cssText).join('\n'); } catch (e) { return ''; }
}).join('\n');
const pending = (() => { try { return document.querySelectorAll('tikz-diagram, metapost-diagram').length - document.querySelectorAll('.mpw-ok, .mpw-error').length; } catch (e) { return 0; } })();

// An inert copy: nothing in a parsed document runs or loads.
const doc = new DOMParser().parseFromString('<!DOCTYPE html>' + document.documentElement.outerHTML, 'text/html');
for (const el of document.querySelectorAll('[data-clew-share-png]')) el.removeAttribute('data-clew-share-png');

const placeholder = (kind, name, why, block) => {
	const el = doc.createElement('span');
	el.className = 'clew-share-placeholder' + (block ? ' is-block' : '');
	el.textContent = '[' + kind + (name ? ': ' + name : '') + ' — ' + (why || 'not included in this page') + ']';
	return el;
};

// ---- active elements ------------------------------------------------------------
for (const el of doc.querySelectorAll('script, noscript, template, base, portal, frameset, frame, applet, param')) {
	if (el.localName === 'script') stats.scripts++;
	el.remove();
}
for (const el of doc.querySelectorAll('meta')) {
	if (el.hasAttribute('charset') || (el.getAttribute('name') || '').toLowerCase() === 'viewport') continue;
	el.remove();
}

// ---- embeds: a named placeholder each -------------------------------------
const nameIn = (box) => {
	const app = box.getAttribute('data-app');
	if (app && !app.startsWith('/') && !/^[a-z]+:/i.test(app)) return app;
	for (const el of [box, ...box.querySelectorAll('*')]) {
		const pdf = el.getAttribute('data-clew-pdf');
		if (pdf && !pdf.startsWith('/') && !/^[a-z]+:/i.test(pdf)) return pdf;
		for (const a of el.attributes) {
			const n = a.name.toLowerCase();
			if (!(n === 'src' || n === 'data' || /^data-([a-z-]*-)?(src|path)$/.test(n)) || !a.value) continue;
			if (isWeb(a.value)) return a.value;
			let v = vaultName(a.value);
			// One of Clew's viewers (__clew_assets__/…?src=<the vault file>).
			if (!v) {
				let inner = '';
				try { inner = new URL(a.value, location.href).searchParams.get('src') || ''; } catch (e) { inner = ''; }
				v = inner ? vaultName(inner) : null;
			}
			if (v) return v;
			if (!a.value.startsWith('/') && !/^[a-z]+:/i.test(a.value)) return a.value;
		}
	}
	// The title bar's own words: the PDF viewer adds its controls (a ⟷ button,
	// a status chip) to it.
	const bar = box.querySelector('.embed-title')?.cloneNode(true);
	for (const control of bar ? bar.querySelectorAll('button, .clew-pdf-status') : []) control.remove();
	const title = bar?.textContent?.trim();
	return title || box.getAttribute('title') || '';
};
const EMBEDS = [
	['clew-app-embed, .clew-app-embed', 'App'],
	['.pdf-embed-box', 'PDF'],
	['.excalidraw-embed-box', 'Drawing'],
	['.canvas-embed', 'Canvas'],
	['.office-embed-box', 'Office document'],
	['iframe.reveal-embed', 'Presentation'],
	['iframe[data-clew-pdf]', 'PDF'],
	['iframe', 'Embedded page'],
	['embed, object', 'Embedded file'],
];
for (const [selector, kind] of EMBEDS) {
	for (const box of doc.querySelectorAll(selector)) {
		if (!box.isConnected) continue;
		const name = nameIn(box);
		stats.embeds.push(kind + (name ? ': ' + name : ''));
		box.replaceWith(placeholder(kind, name, null, true));
	}
}
for (const media of doc.querySelectorAll('video, audio')) {
	const srcs = [media.getAttribute('src'), ...[...media.querySelectorAll('source')].map((s) => s.getAttribute('src'))].filter(Boolean);
	if (srcs.length && srcs.every(isWeb)) { media.removeAttribute('autoplay'); continue; }
	const kind = media.localName === 'video' ? 'Video' : 'Audio';
	const name = srcs.map(vaultName).find(Boolean) || '';
	stats.embeds.push(kind + (name ? ': ' + name : ''));
	media.replaceWith(placeholder(kind, name, null, true));
}

// ---- images ---------------------------------------------------------------------
for (const s of doc.querySelectorAll('picture source')) s.remove();
for (const img of doc.querySelectorAll('img, input[type=image]')) {
	img.removeAttribute('srcset');
	img.removeAttribute('sizes');
	const src = img.getAttribute('src') || '';
	if (isData(src) || /^https?:/i.test(src.trim())) continue;
	const name = vaultName(src) || img.getAttribute('alt') || '';
	const got = local(src) ? await inline(src) : { held: 'not included in this page' };
	if (got.data) { img.setAttribute('src', got.data); stats.images++; stats.imageBytes += got.bytes; }
	else { stats.held.push(name + ': ' + got.held); img.replaceWith(placeholder('Image', name, got.held)); }
}
for (const c of doc.querySelectorAll('canvas')) {
	const png = c.getAttribute('data-clew-share-png') || '';
	const bytes = Math.round(png.length * 0.75);
	if (png && bytes <= maxImage && bytes <= budget) {
		budget -= bytes;
		const img = doc.createElement('img');
		img.setAttribute('src', png);
		for (const a of ['width', 'height', 'class', 'style']) if (c.hasAttribute(a)) img.setAttribute(a, c.getAttribute(a));
		c.replaceWith(img);
	} else {
		stats.held.push('chart: ' + (png ? 'too large to include' : 'could not be read'));
		c.replaceWith(placeholder('Chart', '', png ? 'too large to include' : 'not included in this page'));
	}
}
const XLINK = 'http://www.w3.org/1999/xlink';
for (const im of doc.querySelectorAll('image')) {
	for (const [ns, n] of [[null, 'href'], [XLINK, 'href']]) {
		const v = ns ? im.getAttributeNS(ns, n) : im.getAttribute(n);
		if (!v || isData(v) || /^https?:/i.test(v.trim())) continue;
		const got = local(v) ? await inline(v) : {};
		if (got.data) { ns ? im.setAttributeNS(ns, 'xlink:' + n, got.data) : im.setAttribute(n, got.data); }
		else { ns ? im.removeAttributeNS(ns, n) : im.removeAttribute(n); }
	}
}

// ---- links: in-Clew ones become plain text -------------------------------------
for (const a of doc.querySelectorAll('a')) {
	const href = a.getAttribute('href') ?? a.getAttributeNS(XLINK, 'href');
	let anchor = null;
	if (href && href.length > 1 && href.startsWith('#')) {
		try { anchor = doc.getElementById(decodeURIComponent(href.slice(1))); } catch (e) { anchor = null; }
	}
	if (href && (isWeb(href) || anchor)) continue;
	stats.links++;
	a.replaceWith(...a.childNodes);
}
for (const area of doc.querySelectorAll('area')) area.removeAttribute('href');

// ---- styles: inlined ------------------------------------------------------------
const inlineCss = async (css, base) => {
	css = String(css || '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/@import[^;]*;/gi, '');
	const urls = [...css.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)];
	let out = '';
	let last = 0;
	for (const m of urls) {
		const raw = m[2];
		let next = raw;
		if (!isData(raw) && !/^https?:/i.test(raw) && !raw.startsWith('#')) {
			let abs = '';
			try { abs = new URL(raw, base).href; } catch (e) { abs = ''; }
			const got = abs && local(abs) ? await inline(abs) : {};
			next = got.data || 'data:,';
		}
		out += css.slice(last, m.index) + 'url("' + next.replace(/"/g, '%22') + '")';
		last = m.index + m[0].length;
	}
	return out + css.slice(last);
};
for (const link of doc.querySelectorAll('link')) {
	const rel = (link.getAttribute('rel') || '').toLowerCase().split(/\s+/);
	const href = link.getAttribute('href') || '';
	if (rel.includes('stylesheet') && local(href)) {
		let css = '';
		const abs = new URL(href, location.href).href;
		try { const res = await fetch(abs); css = res.ok ? await res.text() : ''; } catch (e) { css = ''; }
		const style = doc.createElement('style');
		style.textContent = await inlineCss(css, abs);
		link.replaceWith(style);
	} else {
		link.remove();
	}
}
for (const style of doc.querySelectorAll('style')) {
	if (/url\(/i.test(style.textContent)) style.textContent = await inlineCss(style.textContent, location.href);
}
if (adopted.trim()) {
	const style = doc.createElement('style');
	style.textContent = await inlineCss(adopted, location.href);
	doc.head.append(style);
}

// ---- every attribute ------------------------------------------------------------
const LEAK = /clew-preview:|\/__clew_|file:\/\/|^\s*blob:|^\s*\/vault\//i;
const hasSession = (v) => session && v.includes(session);
for (const el of doc.querySelectorAll('*')) {
	const ln = el.localName;
	if ((ln === 'set' || ln === 'animate') && /href/i.test(el.getAttribute('attributeName') || '')) { el.remove(); continue; }
	for (const a of [...el.attributes]) {
		const n = a.name.toLowerCase();
		const plain = a.value.replace(/[\u0000- \u007f-\u009f]/g, '').toLowerCase();
		if (n.startsWith('on')) { el.removeAttributeNode(a); stats.handlers++; continue; }
		if (/^(javascript|vbscript|livescript):/.test(plain) || /^data:text\/html/.test(plain)) { el.removeAttributeNode(a); continue; }
		if (['action', 'formaction', 'ping', 'srcdoc', 'manifest', 'http-equiv', 'data-clew-share-png', 'nonce'].includes(n)) { el.removeAttributeNode(a); continue; }
		if (n === 'style') {
			if (/javascript:|expression\(|behavior:/i.test(a.value)) { el.removeAttributeNode(a); continue; }
			if (/url\(/i.test(a.value)) a.value = await inlineCss(a.value, location.href);
		}
		if (LEAK.test(a.value) || hasSession(a.value)) el.removeAttributeNode(a);
	}
}

// ---- the head: what a mailed page needs -------------------------------------------
const head = doc.head;
if (!head.querySelector('meta[charset]')) { const m = doc.createElement('meta'); m.setAttribute('charset', 'utf-8'); head.prepend(m); }
if (!head.querySelector('meta[name=viewport]')) {
	const m = doc.createElement('meta');
	m.setAttribute('name', 'viewport');
	m.setAttribute('content', 'width=device-width, initial-scale=1');
	head.append(m);
}
const csp = doc.createElement('meta');
csp.setAttribute('http-equiv', 'Content-Security-Policy');
csp.setAttribute('content', "default-src 'none'; img-src data: https: http:; media-src https: http:; style-src 'unsafe-inline'; font-src data:; script-src 'none'; object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'");
head.querySelector('meta[charset]').after(csp);
if (!doc.title.trim()) {
	// The engine leaves <title> empty; a mailed page is named after its note.
	const file = decodeURIComponent(location.pathname.split('/').pop() || '').replace(/\.(md|jmd)\.html$/i, '');
	let title = head.querySelector('title');
	if (!title) { title = doc.createElement('title'); head.append(title); }
	title.textContent = doc.querySelector('h1')?.textContent?.trim() || file;
}
const own = doc.createElement('style');
own.textContent = '.clew-share-placeholder { color: #666; font-size: 0.9em; font-style: italic; }'
	+ ' .clew-share-placeholder.is-block { display: block; margin: 0.8em 0; padding: 0.5em 0.8em; border: 1px dashed #bbb; border-radius: 6px; }';
head.append(own);

const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML;
stats.ms = Math.round(performance.now() - t0);
stats.bytes = new Blob([html]).size;
stats.figuresUndrawn = pending;
return { html, stats };
`;

/**
 * What a share must never carry, looked for in the finished string: a
 * script, an event handler, a javascript: URL, or an internal path (Clew's
 * own URLs, the session, the vault's place on this device, an app
 * container). Attribute-borne checks read only the markup's own tags, where
 * a note's text cannot reach (it is escaped there). [] when clean.
 */
export function shareLeaks(html, { sessionId = '', vaultPath = '' } = {}) {
	const text = String(html ?? '');
	const tags = text.match(/<[a-zA-Z][^>]*>/g) ?? [];
	const found = [];
	if (/<script[\s>/]/i.test(text)) found.push('a script');
	if (tags.some((t) => /\son[a-z]+\s*=/i.test(t))) found.push('an event handler');
	if (tags.some((t) => /=\s*["']?\s*(?:javascript|vbscript):/i.test(t))) found.push('a javascript: URL');
	if (/clew-preview:/i.test(text)) found.push('a clew-preview: URL');
	if (/\/__clew_/.test(text)) found.push('a /__clew_ path');
	if (tags.some((t) => /file:\/\//i.test(t)) || /url\(\s*["']?\s*file:/i.test(text)) found.push('a file:// URL');
	if (sessionId && text.includes(sessionId)) found.push('the session id');
	if (vaultPath && text.includes(vaultPath)) found.push('the vault\'s path on this device');
	if (/\/var\/mobile\/Containers\/|\/Containers\/Data\/Application\/|\/CoreSimulator\/Devices\//.test(text)) found.push('an app-container path');
	if (tags.some((t) => /=\s*["']?\/vault\//.test(t))) found.push('a vault-absolute path');
	return found;
}
