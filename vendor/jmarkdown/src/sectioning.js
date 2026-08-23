/*
	Sectioning ladder + heading-base resolution, shared by the LaTeX renderer
	(which heading command to emit) and the cross-reference resolver (which type
	word a heading-anchored :cref should say). Keeping it here avoids two copies
	of the class→base mapping drifting apart.
*/

import { configManager } from './config-manager.js';

// The LaTeX sectioning ladder, deepest-up. A heading of depth N maps to the
// rung `base + (N - 1)`, clamped at the bottom.
export const SECTIONING = ['part', 'chapter', 'section', 'subsection', 'subsubsection', 'paragraph', 'subparagraph'];

const CHAPTER_CLASSES = ['book', 'report', 'memoir', 'scrbook', 'scrreprt', 'extbook', 'extreport'];

// Coerce a metadata/config value (string, or single-element array from the
// metadata-header parser) to a trimmed lower-case word.
function metaWord(key) {
	const v = configManager.getMeta(key);
	if (v == null) return '';
	return (Array.isArray(v) ? v.join(' ') : String(v)).trim().toLowerCase();
}

// Which rung a depth-1 heading (`#`) starts on. An explicit `Heading base` wins;
// otherwise it is derived from the document class — chapter-bearing classes
// start at \chapter, everything else (article, the default) at \section.
export function headingBaseIndex() {
	const explicit = metaWord('Heading base');
	if (explicit && SECTIONING.includes(explicit)) return SECTIONING.indexOf(explicit);

	const cls = metaWord('Document class') || 'article';
	return SECTIONING.indexOf(CHAPTER_CLASSES.includes(cls) ? 'chapter' : 'section');
}

// Whether the document class is chapter-bearing. Exported because LaTeX splits
// other things on the same distinction — notably the bibliography heading, which
// is \bibname in book/report and \refname in article (see citations.js) — and
// this module is the one place the class list is allowed to live.
export function isChapterClass() {
	return CHAPTER_CLASSES.includes(metaWord('Document class') || 'article');
}

// The sectioning command / type word for a heading of the given depth (1-based):
// e.g. depth 1 → 'section' (article) or 'chapter' (book); depth 2 → 'subsection'
// or 'section'; clamped at 'subparagraph'.
export function commandForDepth(depth) {
	const idx = Math.min(headingBaseIndex() + (depth - 1), SECTIONING.length - 1);
	return SECTIONING[idx];
}
