// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Bare `ftp://` URLs as `URL` nodes. The engine autolinks http(s), www. and
// ftp URLs alike (marked's GFM url rule — reachable since jmarkdown 3134543);
// lezer's GFM Autolink extension knows the first two and not ftp, so without
// this live edit drew ftp:// as text where reading view drew a link. The
// URL's extent follows lezer's own rule for http(s) (a host, a port, a path
// up to whitespace or `<`, then trailing punctuation and an unbalanced `)`
// given back), so every bare URL ends where the grammar ends the others.
const FTP = /ftp:\/\/[\w-]+(?:\.[\w-]+)*(?::\d+)?(?:\/[^\s<]*)?/y;

function urlEnd(text, from, to) {
	let end = to;
	const count = (ch) => [...text.slice(from, end)].filter((c) => c === ch).length;
	for (;;) {
		const last = text[end - 1];
		if (/[?!.,:*_~]/.test(last) || (last === ')' && count(')') > count('('))) end--;
		else return end;
	}
}

/** @type {import('@lezer/markdown').MarkdownConfig} */
export const jmdFtpLinks = {
	parseInline: [{
		name: 'FtpAutolink',
		parse(cx, next, absPos) {
			if (next !== 102 /* f */ || cx.hasOpenLink) return -1;
			const pos = absPos - cx.offset;
			if (pos && /\w/.test(cx.text[pos - 1])) return -1;
			FTP.lastIndex = pos;
			const m = FTP.exec(cx.text);
			if (!m) return -1;
			const end = urlEnd(cx.text, pos, pos + m[0].length);
			if (end <= pos + 'ftp://'.length) return -1;
			cx.addElement(cx.elt('URL', absPos, end + cx.offset));
			return end + cx.offset;
		},
	}],
};
