// Note Headers — a Clew preview-surface plugin. Reads the current note's
// frontmatter and, when it carries header-* keys, opens the rendered note
// with a full-width banner:
//
//   ---
//   header-image: "[[banner.jpg]]"     (wikilink or vault path)
//   header-html: "[[matrix-rain.html]]" (a live HTML background — see below;
//                                       wins over header-image if both are set)
//   header-title: A Grand Title        (optional; math welcome: $e^{i\pi}$)
//   header-subtitle: with a subtitle   (optional)
//   header-height: 240                 (optional, px; headers without a
//                                       background hug their text instead)
//   header-position: center 30%        (optional; which part of the image
//                                       shows — any CSS background-position)
//   header-align: bottom               (optional; where the text sits:
//                                       top, center, or bottom)
//   ---
//
// HTML BACKGROUNDS
//
// header-html points at an ordinary .html file in the vault, loaded into an
// iframe that fills the banner behind the title. Anything a browser can do
// it can do — a <canvas> animation, CSS keyframes, SVG, a gradient that
// drifts. Write it as a standalone page sized to 100% width/height; the
// iframe is the viewport.
//
// It runs SANDBOXED (allow-scripts only), so the page gets its own opaque
// origin: it can animate, but it cannot read the note, reach the vault,
// touch this document, or use the window.clew note API. That is deliberate —
// a decoration should not have the run of the place.
//
// The banner carries data-clew-keep, so the preview client's morphdom pass
// leaves it alone; and when the frontmatter has not changed, the existing
// banner is reused rather than rebuilt. Together those mean an animation
// keeps running across re-renders instead of restarting every time the note
// is saved.
//
// Runs after the preview client; re-applies itself after every morph via
// the 'clew:render' event. Plain script — no build step, no imports.
(() => {
	'use strict';

	// /<sid>/<note path>.html → the raw note is the same URL minus ".html".
	const notePath = decodeURIComponent(location.pathname).replace(/\.html$/i, '');
	const sid = notePath.split('/')[1];

	const parseHeader = (text) => {
		const fm = /^---\n([\s\S]*?)\n---/.exec(text);
		if (!fm) return null;
		const get = (key) => {
			const m = new RegExp(`^header-${key}:\\s*(.+?)\\s*$`, 'm').exec(fm[1]);
			return m ? m[1].replace(/^["']|["']$/g, '') : null;
		};
		const image = get('image');
		const html = get('html');
		const title = get('title');
		if (!image && !html && !title) return null;
		return {
			image, html, title, subtitle: get('subtitle'), height: get('height'),
			position: get('position'), align: get('align'),
		};
	};

	const fileUrl = (ref) => {
		const target = /\[\[([^\[\]|]+)\]\]/.exec(ref)?.[1] ?? ref;
		const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
		// A path is used as-is; a bare name is tried in Attachments/.
		const rel = target.includes('/') ? target : `Attachments/${target}`;
		return `/${sid}/${enc(rel)}`;
	};

	// The banner stands in for a duplicate leading H1. Re-applied on reuse
	// too: a morph restores the heading the incoming HTML says is visible.
	const hideDuplicateH1 = (title) => {
		if (!title) return;
		const firstH1 = document.querySelector('body > h1, body > [data-source-line] h1');
		if (firstH1 && firstH1.textContent.trim() === title.trim()) {
			firstH1.style.display = 'none';
		}
	};

	const apply = async () => {
		try {
			const text = await (await fetch(notePath)).text();
			const spec = parseHeader(text);
			const existing = document.querySelector('.clew-note-header');

			if (!spec) { existing?.remove(); return; }

			// Unchanged frontmatter: keep the banner exactly as it is, so a
			// running animation is not restarted. Only the H1 needs redoing.
			const signature = JSON.stringify(spec);
			if (existing && existing.dataset.headerSpec === signature) {
				hideDuplicateH1(spec.title);
				return;
			}
			existing?.remove();

			const header = document.createElement('div');
			header.className = 'clew-note-header';
			header.dataset.headerSpec = signature;
			// Survive the preview client's morphdom pass (see client.js).
			header.setAttribute('data-clew-keep', '');
			// With a background the banner has a fixed height and the text sits
			// at the bottom of it; without one it simply hugs its text.
			const hasBackground = spec.image || spec.html;
			const height = hasBackground ? `height:${Number(spec.height) || 170}px;` : '';
			const justify = { top: 'flex-start', center: 'center' }[spec.align] ?? 'flex-end';
			header.style.cssText = 'position:relative;margin:-24px -32px 1.2em;'
				+ `${height}border-radius:0 0 10px 10px;`
				+ `overflow:hidden;display:flex;flex-direction:column;justify-content:${justify};`
				+ 'padding:18px 32px;box-sizing:border-box;';

			if (spec.html) {
				// The brand plate underneath, so there is no flash of nothing
				// while the page loads (or if it never does).
				header.style.background = 'linear-gradient(120deg, #2b2440, #7852ee)';
				const frame = document.createElement('iframe');
				frame.src = fileUrl(spec.html);
				// allow-scripts WITHOUT allow-same-origin: it may animate, it
				// may not read anything of ours.
				frame.setAttribute('sandbox', 'allow-scripts');
				frame.setAttribute('scrolling', 'no');
				frame.setAttribute('tabindex', '-1');
				frame.setAttribute('aria-hidden', 'true');
				// pointer-events:none so the decoration never swallows a click
				// or a scroll meant for the note.
				frame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;'
					+ 'border:0;display:block;pointer-events:none;';
				header.append(frame);
			} else if (spec.image) {
				const position = spec.position || 'center';
				header.style.background = `url("${fileUrl(spec.image)}") ${position}/cover no-repeat`;
			} else {
				// No background: a brand-gradient plate so the white text reads.
				header.style.background = 'linear-gradient(120deg, #2b2440, #7852ee)';
			}

			const scrim = document.createElement('div');
			scrim.style.cssText = 'position:absolute;inset:0;pointer-events:none;'
				+ 'background:linear-gradient(transparent 30%, rgba(0,0,0,0.55));';
			header.append(scrim);
			if (spec.title) {
				const h = document.createElement('div');
				h.style.cssText = 'position:relative;font-size:2em;font-weight:700;'
					+ 'color:#fff;text-shadow:0 1px 8px rgba(0,0,0,0.6);line-height:1.15;';
				h.textContent = spec.title;
				header.append(h);
				hideDuplicateH1(spec.title);
			}
			if (spec.subtitle) {
				const sub = document.createElement('div');
				sub.style.cssText = 'position:relative;font-size:1.05em;color:#eee;'
					+ 'text-shadow:0 1px 6px rgba(0,0,0,0.6);margin-top:2px;';
				sub.textContent = spec.subtitle;
				header.append(sub);
			}
			document.body.prepend(header);
			// Titles may carry $math$ — MathJax is already in the document.
			window.MathJax?.typesetPromise?.([header]).catch(() => {});
		} catch { /* headerless is fine */ }
	};

	document.addEventListener('clew:render', apply);
	apply();
})();
