// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Where the `latexEngine` setting lives in Settings, named ONCE: the settings
// view draws its row from this, and main/latex-engine.js names it when a
// forced engine is the reason an export ran as it did. The first copy said
// "Settings → Export", a section that does not exist (found by Clew-docs,
// 2026-10-02). tests/latex-engine.test.js holds `section` to the view's own
// section title, so moving the row without moving this fails a test.

export const LATEX_ENGINE_SETTING = {
	section: 'Appearance',
	label: 'LaTeX engine (PDF via LaTeX export)',
};

/** "Settings → Appearance → LaTeX engine (PDF via LaTeX export)" */
export const latexEngineSettingPath = () => `Settings → ${LATEX_ENGINE_SETTING.section} → ${LATEX_ENGINE_SETTING.label}`;
