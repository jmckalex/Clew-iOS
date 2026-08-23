import { readFileSync, realpathSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';

const MAX_RECURSION_DEPTH = 20;
const SENTINEL = '\x00';

// Mask code and display-math regions with NUL bytes so the include regex
// can run on the result without matching tokens inside those regions.
// Offsets are preserved (1 character → 1 sentinel character), so match
// indices computed against the masked text are valid indices into the
// original text.
//
// Regions masked:
//   - fenced code blocks (``` or ~~~, leading indent ≤ 3, matching length close)
//   - display math blocks (`$$ … $$`, possibly spanning lines)
//
// Indented code blocks are not masked: JMarkdown disables marked's 4-space
// indented-code tokenizer (see `src/index.js`), so a line like
// `    [[file.md]]` is ordinary text and the include should be expanded.
//
// Inline code spans and inline math are not masked either: the line-anchored
// include regex cannot match when wrapping characters are present on the line.
function maskProtectedRegions(text) {
	const lines = text.split('\n');
	let inFence = false;
	let fenceChar = null;
	let fenceLen = 0;
	let inDisplayMath = false;

	const out = lines.map(line => {
		if (inFence) {
			const close = line.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
			if (close && close[1][0] === fenceChar && close[1].length >= fenceLen) {
				inFence = false;
				fenceChar = null;
				fenceLen = 0;
			}
			return SENTINEL.repeat(line.length);
		}

		if (inDisplayMath) {
			const closeIdx = line.indexOf('$$');
			if (closeIdx !== -1) {
				inDisplayMath = false;
				return SENTINEL.repeat(closeIdx + 2) + line.slice(closeIdx + 2);
			}
			return SENTINEL.repeat(line.length);
		}

		const fenceOpen = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/);
		if (fenceOpen) {
			inFence = true;
			fenceChar = fenceOpen[1][0];
			fenceLen = fenceOpen[1].length;
			return SENTINEL.repeat(line.length);
		}

		// Scan the line for $$…$$ regions. A balanced pair on the line is
		// masked; an unbalanced opening $$ flips inDisplayMath for following
		// lines.
		let masked = '';
		let i = 0;
		const n = line.length;
		while (i < n) {
			if (line[i] === '$' && line[i + 1] === '$') {
				const close = line.indexOf('$$', i + 2);
				if (close !== -1) {
					masked += SENTINEL.repeat(close + 2 - i);
					i = close + 2;
					continue;
				}
				inDisplayMath = true;
				masked += SENTINEL.repeat(n - i);
				i = n;
				break;
			}
			masked += line[i];
			i++;
		}

		return masked;
	});

	return out.join('\n');
}

function canonicalize(filePath) {
	try {
		return realpathSync(filePath);
	} catch {
		return filePath;
	}
}

// Process file inclusions recursively.
//
// Syntax: `[[name.md]]` on a line by itself (optional surrounding whitespace).
// Inline occurrences and occurrences inside code / math regions are left
// literal.
//
// Path resolution: relative paths resolve against `basePath` (the directory
// of the file containing the include). Nested calls pass the included
// file's own directory, so deeper includes resolve relative to their
// immediate parent.
//
// Cycle detection: only active-chain cycles (A→B→A) are rejected. The same
// file may appear at multiple independent include sites in one document.
function processFileInclusions(markdown, basePath = process.cwd(), stack = [], depth = 0) {
	if (depth > MAX_RECURSION_DEPTH) {
		console.warn(`Maximum file-inclusion depth (${MAX_RECURSION_DEPTH}) exceeded; remaining includes left literal.`);
		return markdown;
	}

	const masked = maskProtectedRegions(markdown);
	const regex = /^[ \t]*\[\[([^\[\]\n]+?\.md)\]\][ \t]*$/gm;

	let lastIndex = 0;
	let result = '';
	let match;

	while ((match = regex.exec(masked)) !== null) {
		result += markdown.substring(lastIndex, match.index);
		lastIndex = regex.lastIndex;

		const requested = match[1].trim();
		const resolved = isAbsolute(requested) ? requested : resolve(basePath, requested);
		const canonical = canonicalize(resolved);

		if (stack.includes(canonical)) {
			const trail = stack.concat(canonical).join(' → ');
			console.warn(`Circular file inclusion: ${trail}. Skipping.`);
			result += match[0];
			continue;
		}

		try {
			const fileContent = readFileSync(resolved, 'utf8');
			const fileDir = dirname(resolved);
			const expanded = processFileInclusions(
				fileContent,
				fileDir,
				stack.concat(canonical),
				depth + 1
			);
			result += expanded;
		} catch (err) {
			const parent = stack.length > 0 ? stack[stack.length - 1] : '(top-level)';
			console.error(`Error including ${resolved} (from ${parent}): ${err.message}`);
			result += match[0];
		}
	}

	result += markdown.substring(lastIndex);
	return result;
}

export default processFileInclusions;
