// Note Headers — a Clew preview-surface plugin. Reads the current note's
// frontmatter and, when it carries header-* keys, opens the rendered note
// with a full-width banner:
//
//   ---
//   header-image: "[[banner.jpg]]"     (wikilink or vault path)
//   header-title: A Grand Title        (optional; math welcome: $e^{i\pi}$)
//   header-subtitle: with a subtitle   (optional)
//   header-height: 240                 (optional, px; headers without an
//                                       image hug their text instead)
//   ---
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
		const title = get('title');
		if (!image && !title) return null;
		return { image, title, subtitle: get('subtitle'), height: get('height') };
	};

	const imageUrl = (ref) => {
		const target = /\[\[([^\[\]|]+)\]\]/.exec(ref)?.[1] ?? ref;
		const enc = (p) => p.split('/').map(encodeURIComponent).join('/');
		// A path is used as-is; a bare name is tried in Attachments/.
		const rel = target.includes('/') ? target : `Attachments/${target}`;
		return `/${sid}/${enc(rel)}`;
	};

	let header = null;

	const apply = async () => {
		try {
			const text = await (await fetch(notePath)).text();
			const spec = parseHeader(text);
			document.querySelector('.clew-note-header')?.remove();
			if (!spec) return;
			header = document.createElement('div');
			header.className = 'clew-note-header';
			// With an image the banner has a fixed height and the text sits at
			// the bottom of it; without one it simply hugs its text.
			const height = spec.image ? `height:${Number(spec.height) || 170}px;` : '';
			header.style.cssText = 'position:relative;margin:-24px -32px 1.2em;'
				+ `${height}border-radius:0 0 10px 10px;`
				+ 'overflow:hidden;display:flex;flex-direction:column;justify-content:flex-end;'
				+ 'padding:18px 32px;box-sizing:border-box;';
			if (spec.image) {
				header.style.background = `url("${imageUrl(spec.image)}") center/cover no-repeat`;
			} else {
				// No image: a brand-gradient plate so the white text always reads.
				header.style.background = 'linear-gradient(120deg, #2b2440, #7852ee)';
			}
			const scrim = document.createElement('div');
			scrim.style.cssText = 'position:absolute;inset:0;'
				+ 'background:linear-gradient(transparent 30%, rgba(0,0,0,0.55));';
			header.append(scrim);
			if (spec.title) {
				const h = document.createElement('div');
				h.style.cssText = 'position:relative;font-size:2em;font-weight:700;'
					+ 'color:#fff;text-shadow:0 1px 8px rgba(0,0,0,0.6);line-height:1.15;';
				h.textContent = spec.title;
				header.append(h);
				// The banner replaces a duplicate leading H1.
				const firstH1 = document.querySelector('body > h1, body > [data-source-line] h1');
				if (firstH1 && firstH1.textContent.trim() === spec.title.trim()) {
					firstH1.style.display = 'none';
				}
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
