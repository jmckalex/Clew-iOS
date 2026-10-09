// "Export as PDF (reading view)" — the note as the app draws it, printed.
//
// The iOS half of vendor/clew/main/print-pdf.js. Upstream prints the note's
// own clew-preview:// document from a hidden BrowserWindow once the page
// says it has settled; here the bridge does the same with a hidden
// WKWebView (ios/Clew/Sources/PrintPDF.swift) and hands the PDF to the
// share sheet — iOS's save dialog. The two scripts below are upstream's,
// copied verbatim (print-pdf.js imports electron, so they cannot be
// imported from it; upstream candidate: export them from an electron-free
// module, the open-file.js arrangement). Keep them in step.
//
// ARM: MathJax and document.fonts hand out promises rather than state, so
// the page has to remember for us. Chained rather than raced, because
// typesetting can ASK for a webfont as it goes.
export const ARM_SCRIPT = `(() => {
	window.__clewPrintReady = false;
	(window.MathJax?.startup?.promise ?? Promise.resolve())
		.then(() => document.fonts.ready)
		.then(() => { window.__clewPrintReady = true; })
		.catch(() => { window.__clewPrintReady = true; });
	return true;
})()`;

// PROBE: re-checks the font status live; a mermaid block is done when its
// source has become an <svg>; TikZ/MetaPost figures take the longest of
// anything (the first one loads the wasm engines), and the preview client
// counts them (figures.js#figuresPending).
export const READY_PROBE = `(() => {
	if (document.readyState !== 'complete') return false;
	if (window.__clewPrintReady !== true) return false;
	if (document.fonts.status !== 'loaded') return false;
	for (const el of document.querySelectorAll('.mermaid')) {
		if (!el.querySelector('svg')) return false;
	}
	if (window.__clewFiguresPending?.() > 0) return false;
	return true;
})()`;

// The page prints LIGHT whatever the app is wearing: the engine's inline
// CSS is written for a light page and the dark palette is an override on
// top of it, so light is the faithful rendering — and a PDF is a paper
// artifact. Through the client's own theme handler, so mermaid re-themes.
export const LIGHT_THEME_SCRIPT = `window.postMessage({ source: 'clew-preview-host', type: 'theme', theme: 'light' }, '*'); true;`;

export const PAPER_SIZES = ['a4', 'letter', 'legal', 'tabloid'];

// A BOOK's print (Clew-app 5abf52d): each chapter, the book's references and
// its index from a new page, and a chapter's further level-one headings too.
// Upstream's BOOK_PRINT_CSS, verbatim. Upstream injects it with insertCSS;
// here the arm script adopts it as a constructed sheet, which the preview's
// CSP does not govern, and UIKit's print formatter applies print media.
export const BOOK_PRINT_CSS = `@media print {
	section.jmd-chapter, section.jmd-book-references, nav.index { break-before: page; }
	section.jmd-chapter > h1 ~ h1:not(.unnumbered) { break-before: page; }
}`;

export const BOOK_ARM_SCRIPT = `(() => {
	try {
		const sheet = new CSSStyleSheet();
		sheet.replaceSync(${JSON.stringify(BOOK_PRINT_CSS)});
		document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
	} catch { /* an old WebKit: chapters run on */ }
	return true;
})(); ${ARM_SCRIPT}`;
