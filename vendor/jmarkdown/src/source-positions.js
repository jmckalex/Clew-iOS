/*
	Source position tracking for JMarkdown inverse search.

	This module provides a marked.js extension that annotates tokens with their
	source line number in the original .jmd file, enabling click-to-edit from
	the rendered HTML output.

	Unlike marked-token-position, this approach:
	  - Tracks top-level tokens via contiguous offset scanning
	  - Attempts to locate child tokens in the source text for precise line numbers
	  - Uses the parent's source offset to avoid false matches (e.g., generated text
	    matching a string literal in a <script> block earlier in the file)
	  - Falls back to inheriting the parent's line for dynamically generated content
	  - Never throws on generated content

	Usage:
	    import { sourcePositions } from './source-positions.js';
	    marked.use(sourcePositions(text, headerLength));
*/

/**
 * Build a function that maps a character offset in `text` to a 0-based line number.
 */
function buildLineMap(text) {
	const lineStarts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text[i] === '\n') {
			lineStarts.push(i + 1);
		}
	}
	return function offsetToLine(offset) {
		let lo = 0, hi = lineStarts.length - 1;
		while (lo < hi) {
			const mid = (lo + hi + 1) >> 1;
			if (lineStarts[mid] <= offset) lo = mid;
			else hi = mid - 1;
		}
		return lo;
	};
}

/**
 * Try to find a token's raw text in the source, searching from `searchFrom`.
 * If found, sets token.sourceLine and token._sourceOffset.
 * Returns true if found, false otherwise.
 */
function tryLocateInSource(token, text, offsetToLine, headerLength, searchFrom) {
	if (!token.raw) return false;
	const idx = text.indexOf(token.raw, searchFrom);
	if (idx !== -1) {
		token.sourceLine = offsetToLine(idx) + headerLength;
		token._sourceOffset = idx;
		return true;
	}
	return false;
}

/**
 * Walk a token tree, attempting to locate each token in the source text.
 * Tokens whose raw text can be found (searching from the parent's offset)
 * get a precise sourceLine. Tokens that can't be found are dynamically
 * generated and inherit parentLine.
 */
function resolveSourceLines(tokens, parentLine, text, offsetToLine, headerLength, searchFrom) {
	if (!tokens) return;
	for (const token of tokens) {
		if (token.sourceLine === undefined) {
			if (!tryLocateInSource(token, text, offsetToLine, headerLength, searchFrom)) {
				// Can't find it searching forward from the parent's position.
				// This is dynamically generated content — inherit the parent's line.
				if (parentLine !== undefined) {
					token.sourceLine = parentLine;
				}
			}
		}
		const line = token.sourceLine;

		// When recursing into children, search from this token's source offset
		// if it was found, otherwise keep the parent's searchFrom.
		const childSearchFrom = token._sourceOffset !== undefined ? token._sourceOffset : searchFrom;

		// Standard child arrays
		if (token.tokens) {
			resolveSourceLines(token.tokens, line, text, offsetToLine, headerLength, childSearchFrom);
		}

		// List items
		if (token.type === 'list' && token.items) {
			resolveSourceLines(token.items, line, text, offsetToLine, headerLength, childSearchFrom);
		}

		// Table cells
		if (token.type === 'table') {
			if (token.header) {
				for (const cell of token.header) {
					if (cell.tokens) resolveSourceLines(cell.tokens, line, text, offsetToLine, headerLength, childSearchFrom);
				}
			}
			if (token.rows) {
				for (const row of token.rows) {
					for (const cell of row) {
						if (cell.tokens) resolveSourceLines(cell.tokens, line, text, offsetToLine, headerLength, childSearchFrom);
					}
				}
			}
		}

		// childTokens (used by some extensions like description lists)
		if (token.childTokens) {
			for (const childKey of token.childTokens) {
				if (token[childKey]) {
					resolveSourceLines(token[childKey], line, text, offsetToLine, headerLength, childSearchFrom);
				}
			}
		}
	}
}

/**
 * Returns a marked extension that annotates every token with a `sourceLine`
 * property indicating the 1-based line number in the original source file.
 *
 * @param {string} text - The processed markdown string passed to marked.parse()
 * @param {number} headerLength - Number of lines in the YAML header (to offset back to the original file)
 */
export function sourcePositions(text, headerLength = 0) {
	// Honour the 1-based contract documented above in the headerless case too:
	// offsetToLine() is 0-based, and a file with a metadata header passes a
	// headerLength that already lands in 1-based original-file coordinates —
	// so a headerless file needs the +1 explicitly.
	if (headerLength === 0) headerLength = 1;
	const offsetToLine = buildLineMap(text);

	return {
		hooks: {
			processAllTokens(tokens) {
				// Phase 1: Annotate top-level tokens by contiguous offset scanning.
				// Also record each token's character offset in the source via
				// _sourceOffset, so Phase 2 can use it as a search boundary.
				let offset = 0;
				for (const token of tokens) {
					if (!token.raw) continue;
					const idx = text.indexOf(token.raw, offset);
					if (idx !== -1) {
						token.sourceLine = offsetToLine(idx) + headerLength;
						token._sourceOffset = idx;
						offset = idx + token.raw.length;
					}
				}

				// Phase 2: Resolve source lines for all children.
				// Each child is searched starting from its parent's offset in
				// the source, so generated text can't falsely match a string
				// literal that appears earlier (e.g., inside a <script> block).
				resolveSourceLines(tokens, undefined, text, offsetToLine, headerLength, 0);

				return tokens;
			}
		}
	};
}
