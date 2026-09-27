// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// The jmarkdown dialect overlay: a ViewPlugin that runs the pure scanner
// (jmarkdown-scan.js, ported from the jmacs project, GPL-3.0-or-later)
// over the document and paints its captures as CSS-class mark decorations
// on top of the lang-markdown base language. This module is the CM6 side
// of the port — the scanner itself imports nothing from CodeMirror.
//
// Every face the scanner emits becomes the class `jmd-<face>` (faces that
// already carry the `jmd-` prefix are used as-is). The full set of
// emitted classes, for the stylesheet:
//
//   metadata header   jmd-meta-fence jmd-meta-key jmd-meta-element
//                     jmd-meta-regex jmd-meta-delim jmd-meta-bool
//                     jmd-meta-number
//   directives        jmd-directive-punct jmd-directive-name
//                     jmd-directive-bracket
//   environments      jmd-env-keyword jmd-env-name jmd-env-paren
//   attributes        jmd-attr-class jmd-attr-id jmd-attr-name jmd-string
//   inline spans      jmd-punct jmd-mustache jmd-highlight jmd-italic
//                     jmd-cite jmd-cite-key jmd-footnote jmd-footnote-body
//                     jmd-math
//   obsidian passes   jmd-wikilink-bracket jmd-wikilink-target
//                     jmd-wikilink-alias jmd-tag
//   mermaid bodies    jmd-keyword jmd-operator jmd-constant jmd-string
//                     jmd-function jmd-variable jmd-number jmd-type
//                     jmd-paren jmd-comment
//   embedded spans    jmd-embedded
//
// The scanner's `injections` (latex / html / css / javascript bodies —
// tree-sitter injections in jmacs) are painted uniformly as
// `jmd-embedded` here; `jmarkdown_inline` injections (the `[text]` group
// of an `@name[…]` directive) are skipped — that text is ambient
// jmarkdown, already highlighted by the base language and the scanner's
// own inline passes.
import { ViewPlugin, Decoration } from '@codemirror/view';
import { scanJmarkdown } from './jmarkdown-scan.js';
import { scanFor } from './scan-cache.js';

// Above this size the full-document scan starts to cost real time on
// every edit, so the plugin degrades: it scans only the viewport plus a
// margin (see ensureScan).
const BIG_DOC = 500000;
const BIG_DOC_MARGIN = 5000;

/** One Decoration.mark per face, shared across rebuilds. */
const marks = new Map();

function markFor(face) {
	let deco = marks.get(face);
	if (!deco) {
		deco = Decoration.mark({
			class: face.startsWith('jmd-') ? face : `jmd-${face}`,
		});
		marks.set(face, deco);
	}
	return deco;
}

/**
 * The jmarkdown dialect overlay extension.
 *
 * The scan is memoised by document reference (scan-cache.js, shared
 * with folding and live edit): it reruns only when the
 * document changes (`docChanged`); a viewport change merely rebuilds
 * the decoration set — for the newly visible ranges — from the cached
 * scan. Decorations are built ONLY for `view.visibleRanges`, so a long
 * document never carries a full-length DecorationSet.
 *
 * @returns {import('@codemirror/state').Extension}
 */
export function jmdOverlay() {
	return ViewPlugin.fromClass(class {
		constructor(view) {
			this.scanDoc = null; // the Text the cached scan belongs to
			this.scan = null;
			this.scanFrom = 0; // window offset (0 unless degraded)
			this.scanTo = 0;
			this.decorations = this.build(view);
		}

		update(update) {
			if (update.docChanged || update.viewportChanged) {
				this.decorations = this.build(update.view);
			}
		}

		/**
		 * Ensure `this.scan` covers the current document (and, for a big
		 * document, the current viewport window).
		 *
		 * Documents over BIG_DOC degrade gracefully: only the viewport ±
		 * BIG_DOC_MARGIN chars (snapped to line boundaries) is scanned.
		 * This is an approximation — a construct that opens before the
		 * window or closes after it (a long fenced block, an unclosed
		 * `:::TiKZ` body, a metadata header far above) can be mis-read at
		 * the window's edges. Accepted: at that size a full scan per edit
		 * is worse than an occasional edge artefact.
		 */
		ensureScan(view) {
			const doc = view.state.doc;
			if (doc.length > BIG_DOC) {
				const from = doc.lineAt(
					Math.max(0, view.viewport.from - BIG_DOC_MARGIN)
				).from;
				const to = doc.lineAt(
					Math.min(doc.length, view.viewport.to + BIG_DOC_MARGIN)
				).to;
				if (doc === this.scanDoc && from === this.scanFrom && to === this.scanTo) return;
				this.scan = scanJmarkdown(doc.sliceString(from, to));
				this.scanDoc = doc;
				this.scanFrom = from;
				this.scanTo = to;
				return;
			}
			if (doc === this.scanDoc) return;
			this.scan = scanFor(doc);
			this.scanDoc = doc;
			this.scanFrom = 0;
			this.scanTo = doc.length;
		}

		/** The decoration set for the currently visible ranges. */
		build(view) {
			this.ensureScan(view);
			const base = this.scanFrom;
			const visible = view.visibleRanges;
			const touchesViewport = (start, end) => {
				for (const r of visible) {
					if (start < r.to && end > r.from) return true;
				}
				return false;
			};
			const ranges = [];
			for (const c of this.scan.captures) {
				const start = base + c.start;
				const end = base + c.end;
				if (touchesViewport(start, end)) {
					ranges.push(markFor(c.face).range(start, end));
				}
			}
			for (const inj of this.scan.injections) {
				if (inj.language === 'jmarkdown_inline') continue;
				const start = base + inj.start;
				const end = base + inj.end;
				if (end > start && touchesViewport(start, end)) {
					ranges.push(markFor('embedded').range(start, end));
				}
			}
			return Decoration.set(ranges, true);
		}
	}, {
		decorations: (plugin) => plugin.decorations,
	});
}
