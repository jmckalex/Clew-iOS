// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// A bibliography entry's PDF opened (BIB_ENTRIES' `pdf`: {path, exists,
// inVault}, from the entry's `file` field): a vault PDF in a tab, one
// outside the vault through the OS and the open-file guard
// (main/open-file.js). The References panel's Library and a citation
// hover's ⌘-click both come here.
import { workspaceStore } from './state/workspace-store.js';
import { ipc, CH } from './ipc.js';
import { notice } from './plugins.js';

/** @returns {boolean} whether the entry has a PDF to open at all */
export function openEntryPdf(entry) {
	const pdf = entry?.pdf;
	if (!pdf) return false;
	if (!pdf.exists) { notice(`The PDF for ${entry.key} is missing: ${pdf.path}`); return true; }
	if (pdf.inVault) { workspaceStore.openFile(pdf.path, { newTab: true }); return true; }
	const url = `file://${pdf.path.split('/').map(encodeURIComponent).join('/')}`;
	ipc.invoke(CH.SHELL_OPEN_PATH, { url })
		.then((result) => { if (result && !result.ok) notice(result.reason); })
		.catch(() => notice(`Could not open ${pdf.path}`));
	return true;
}
