// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// How a PDF via LaTeX is run on this computer: latexmk's command, with the
// user's own configuration only, and the refusal a vault this device does not
// trust gets. Which engine, and what a failure says, are the shared half
// (shared/latex-engine.js). Electron-free and pure (tests/latex-engine.test.js,
// tests/latexmk-command.test.js).
/** latexmk's flag for an engine. */
export const latexmkFlag = (engine) => ({ pdflatex: '-pdf', lualatex: '-lualatex', xelatex: '-xelatex' })[engine];

// What latexmk and the biber it runs take as their configuration: the
// user's own files, never the folder a build runs in (2026-10-15). latexmk
// runs a `latexmkrc` or `.latexmkrc` in its working folder as Perl, and biber
// obeys a `biber.conf` or `.biber.conf` there — its `output_file` writes
// wherever the user can (both measured: latexmk 4.87, biber 2.21). A book's
// PDF compiles in the vault's own build/ folder, where a vault can leave
// either; and a document's TeX can write one into ANY folder it runs in
// (openout_any allows the working folder — measured with pdfLaTeX and
// LuaLaTeX), which biber reads in the same run. So latexmk gets `-norc`, then
// with `-r` the system and user files its own search reads (latexmk.pl, "Read
// rc files": the first of each list; the working folder's, read last, is the
// one left out); and biber the user's own config file, in biber's order less
// the working folder and kpsewhich (which searches it), else `--noconf`. The
// path rides in the environment, so the shell latexmk runs biber through
// quotes it.
const LATEXMK_SYSTEM_DIRS = ['/etc', '/opt/local/share/latexmk', '/usr/local/share/latexmk', '/usr/local/lib/latexmk'];

/**
 * The command that compiles `texFile` with latexmk: its arguments, and what
 * its environment needs beyond the caller's.
 *
 * @param {{ engine: string, texFile: string, env: Record<string, string|undefined>,
 *   isFile: (p: string) => boolean, platform?: string }} o
 * @returns {{ args: string[], env: Record<string, string> }}
 */
export function latexmkCommand({ engine, texFile, env, isFile, platform = process.platform }) {
	const first = (paths) => paths.find((p) => isFile(p)) ?? null;
	const home = 'HOME' in env ? env.HOME ?? '' : env.USERPROFILE ?? '';
	const system = 'LATEXMKRCSYS' in env
		? (isFile(env.LATEXMKRCSYS) ? env.LATEXMKRCSYS : null)
		: first(['LatexMk', 'latexmkrc'].flatMap((name) => LATEXMK_SYSTEM_DIRS.map((dir) => `${dir}/${name}`)));
	const xdg = 'XDG_CONFIG_HOME' in env ? env.XDG_CONFIG_HOME ?? '' : home ? `${home}/.config` : '';
	const user = home ? first([...(xdg ? [`${xdg}/latexmk/latexmkrc`] : []), `${home}/.latexmkrc`]) : null;
	const biberConf = home ? first([
		`${home}/.biber.conf`,
		...(env.XDG_CONFIG_HOME ? [`${env.XDG_CONFIG_HOME}/biber/biber.conf`] : []),
		`${home}/.config/biber/biber.conf`,
		...(platform === 'darwin' ? [`${home}/Library/biber/biber.conf`] : []),
	]) : null;
	// Whatever `$biber` the user's rc set, the flag goes after its program;
	// a command that is not biber's is replaced by latexmk's default.
	const flag = biberConf ? '--configfile="$CLEW_BIBER_CONF"' : '--noconf';
	const biber = `$biber = q(biber %O %S) unless $biber =~ m{^\\s*\\S*biber(?:\\.exe)?\\s}; $biber =~ s/^(\\s*\\S+)/$1 . q( ${flag})/e;`;
	return {
		args: ['-norc', ...[system, user].filter(Boolean).flatMap((f) => ['-r', f]), '-e', biber,
			latexmkFlag(engine), '-g', '-interaction=nonstopmode', '-quiet', texFile],
		env: biberConf ? { CLEW_BIBER_CONF: biberConf } : {},
	};
}

/**
 * Why a PDF via LaTeX is not made in a vault this device does not trust (the
 * owner's decision 2026-10-15): it runs the TeX installed here over the
 * vault's own TeX code, which reads any file the user can (measured: a TikZ
 * node's `\input{<a file outside the vault>}` printed its text into the
 * export), and the tools around it read their configuration from the folders
 * they run in (latexmkCommand). The vault's LaTeX and HTML exports stay —
 * their figures are drawn by the built-in TeX, which sees no disk, and nothing
 * else is typeset — and so do the reading-view PDFs, which need no TeX.
 *
 * @param {'note'|'book'|'proof'} kind
 * @param {string} device  the device word (renderer/lib/device-name.js)
 */
export function latexPdfRefusal(kind, device) {
	const what = { note: 'A PDF via LaTeX', book: 'A book\'s PDF via LaTeX', proof: 'A chapter proof (a PDF via LaTeX)' }[kind];
	const instead = { note: 'Export the note as PDF (reading view), or trust', book: 'Build the book as PDF (reading view), or trust', proof: 'Trust' }[kind];
	return `${what} is not made in a vault ${device} does not trust: it would run your TeX installation `
		+ `over the vault's own TeX, which can read any file you can. ${instead} the vault (Settings → This vault).`;
}
