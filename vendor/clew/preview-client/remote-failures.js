// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// What the read-only viewer says when a web PDF cannot be shown
// (pdf-page.js, docs/dev/pdf-unification.md §4 and §8), keyed by the failure
// code the host names. Desktop's fetcher (main/remote-fetch.js) names every
// code but one; `insecure-url` is Clew-iOS's, whose https-only rule refuses
// an http: address (§8). A headline never states a LIMIT. Each platform has
// its own (100 MB here, 50 on the iPad), and the host's own message, shown
// on the line beneath, is what names it.
export const FAILURES = {
	'web-page': 'The site answered with a web page, not a PDF — it may need you to sign in.',
	'not-pdf': 'What the site sent is not a PDF.',
	'too-large': 'The PDF is larger than Clew fetches from the web.',
	'refused-address': 'Clew does not fetch from local or private network addresses.',
	'insecure-url': 'Clew fetches web PDFs only from secure (https) addresses — open it in your browser.',
	'bad-url': 'That address cannot be fetched.',
	'timeout': 'The download took too long.',
	'headers-timeout': 'The site did not answer in time.',
	'connect-timeout': 'Could not connect to the site in time.',
	'too-many-redirects': 'The site redirected too many times.',
	'http-status': 'The site refused the request.',
	'dns': 'Offline, or the site\'s name could not be found — and it was not fetched before.',
	'network': 'Offline, or the site could not be reached — and it was not fetched before.',
};
