// Folding for jmarkdown's block constructs, derived from the scanner's
// `folds` output (jmarkdown-scan.js, ported from the jmacs project,
// GPL-3.0-or-later): `:::name` … `:::` directive blocks (nested by
// colon count, `:::TiKZ`/`:::mermaid` verbatim bodies included) and
// `@begin(name)` … `@end(name)` environments.
//
// A directive fold hides everything from the end of the opener line
// through the closer line, like lang-markdown's fenced-code folds. An
// environment fold is a `block` fold in the scanner's terms: the
// `@end(…)` line stays visible (jmacs renders a vertical ellipsis
// between the two kept lines; here the closer line simply remains).
import { foldService } from '@codemirror/language';
import { scanJmarkdown } from './jmarkdown-scan.js';

// Same threshold as overlay.js: a document this large is not scanned
// per fold-gutter query. (The overlay's windowed scan is anchored to
// the viewport, which a fold query is not, so folding just bows out.)
const BIG_DOC = 500000;

/** Scanned folds per document, memoised by Text reference. */
const foldCache = new WeakMap();

function foldsFor(doc) {
	let folds = foldCache.get(doc);
	if (!folds) {
		folds = scanJmarkdown(doc.toString()).folds;
		foldCache.set(doc, folds);
	}
	return folds;
}

/**
 * The jmarkdown folding extension: a foldService answering "what fold
 * starts on this line?" from the scanner's fold spans.
 *
 * @returns {import('@codemirror/state').Extension}
 */
export function jmdFolding() {
	return foldService.of((state, lineStart, lineEnd) => {
		if (state.doc.length > BIG_DOC) return null;
		let best = null;
		for (const fold of foldsFor(state.doc)) {
			if (fold.start >= lineStart && fold.start <= lineEnd) {
				if (!best || fold.end > best.end) best = fold;
			}
		}
		if (!best) return null;
		// Fold from the end of the opener line; a block fold keeps its
		// closing line visible (`to` stops at the end of the line before
		// the `@end(…)` line).
		const to = best.block
			? state.doc.lineAt(best.end).from - 1
			: best.end;
		return to > lineEnd ? { from: lineEnd, to } : null;
	});
}
