// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Clew's style for a LaTeX export and a PDF via LaTeX (the owner's choice,
// 2026-10-19: "a properly-formatted LaTeX document using a font like
// Garamond") — EB Garamond with Garamond-Math, 12pt on A4 (Letter where the
// region uses it), microtype, the document language's hyphenation (babel),
// smart quotes, quieter lists and headings, smaller long quotations, a colour
// emoji fallback, links unboxed. Setting `latexExportStyle` (Settings →
// Appearance, beside the LaTeX engine): `clew`, the default, or `none` — the
// user's jmarkdown configuration alone, as every export was before.
//
// Applied as CONFIGURATION, the engine's own keys, which the export worker
// sets twice: before the build, from the user's config files alone, and
// again when the engine merges the note's HEADER (configManager.mergeMetadata
// — the worker wraps it), so the header's own `Lang`, `LaTeX engine`,
// `Class options` and `Geometry` decide the style as they decide everything
// else (Clew-docs measured the first version deciding without them: a German
// note hyphenated as British, a header's pdflatex overruled):
//   - a header forcing `LaTeX engine: pdflatex` gets no style at all, as the
//     setting forcing pdfLaTeX does (fontspec needs a Unicode engine);
//   - the language is the header's `Lang`, else the config's, else English;
//     its region, else the machine's, chooses the paper and English's
//     variant; a language babel does not know gets no hyphenation from the
//     style — the engine's own table (book.js#BABEL), mirrored here and held
//     to it by a test;
//   - a layout key (`Class options`, `Geometry`, `LaTeX engine`) only where
//     neither the header nor the user's config sets it (a config left at the
//     engine's DEFAULT_CONFIG sets nothing); class options that name no paper
//     get the region's paper through `Geometry`;
//   - `Packages` and `LaTeX preamble` ADDED to the user's — the packages load
//     before hyperref, the preamble lines after the user's own, so the
//     style's fonts win over a config's `\setmainfont` (the owner's: Garamond
//     over his global Optima); a header setting either replaces the style's
//     with the user's, as the engine replaces any config's;
//   - no key the header set is touched, and every style command is guarded
//     (\@ifpackageloaded — as old as LaTeX2e, unlike the 2021 kernel's
//     \IfPackageLoadedTF — babel only where no babel or polyglossia is
//     loaded: the engine's book loads babel for a book in other languages).
// The fonts are named by FILE, which LuaLaTeX and XeLaTeX both find in
// TeX Live, and guarded by \IfFontExistsTF: a TeX installation without them
// keeps its default face rather than failing. Imports nothing; tested by
// tests/latex-style.test.js.

/** The values `latexExportStyle` takes, its default first. */
export const LATEX_EXPORT_STYLES = ['clew', 'none'];

/** The configuration keys the style sets: what the worker restores before
 *  deciding again, the header's merge known. */
export const STYLE_KEYS = ['LaTeX engine', 'Class options', 'Geometry', 'Smart typography', 'Packages', 'LaTeX preamble'];

/** The header keys the style reads, by their spelling folded (case, spaces). */
const HEADER_KEYS = new Map(['Lang', ...STYLE_KEYS].map((k) => [k.toLowerCase(), k]));

/** Packages the style loads (by name, so before hyperref), in order. */
const PACKAGES = ['unicode-math', 'microtype', 'enumitem', 'titlesec', 'titling', 'etoolbox'];

/** The engine's babel names (jmarkdown book.js#BABEL), mirrored: the engine's
 *  module loads its config manager, so it is not imported. */
export const BABEL = {
	en: 'english', 'en-us': 'american', 'en-gb': 'british', 'en-au': 'australian', 'en-ca': 'canadian',
	'en-nz': 'newzealand', de: 'ngerman', 'de-at': 'naustrian', 'de-ch': 'nswissgerman', fr: 'french',
	es: 'spanish', it: 'italian', pt: 'portuguese', 'pt-br': 'brazilian', nl: 'dutch', sv: 'swedish',
	da: 'danish', nb: 'norsk', no: 'norsk', nn: 'nynorsk', fi: 'finnish', is: 'icelandic', pl: 'polish',
	cs: 'czech', sk: 'slovak', hu: 'magyar', ro: 'romanian', hr: 'croatian', sl: 'slovenian', tr: 'turkish',
	ca: 'catalan', gl: 'galician', eu: 'basque', ga: 'irish', cy: 'welsh', et: 'estonian', lv: 'latvian',
	lt: 'lithuanian', la: 'latin', ru: 'russian', uk: 'ukrainian', el: 'greek',
};

/** Regions whose paper is Letter, not A4. */
const LETTER_REGIONS = new Set(['US', 'CA', 'MX', 'PH', 'CL', 'CO', 'VE', 'GT', 'PR']);
/** A class option or geometry key that names the paper. */
const PAPER = /\b(a[0-6]|b[0-6]|letter|legal|executive)paper\b|\bpaper(size)?\s*=/;

/** A colour emoji face each platform ships, for the main font's fallback. */
const EMOJI = { darwin: 'AppleColorEmoji', win32: 'SegoeUIEmoji', linux: 'NotoColorEmoji',
	// Clew-iOS's TeX (mp-tikz-wasm) has no HarfBuzz, which a colour face's
	// fallback needs (`mode=harf`), and the iPad's fonts are not TeX's: none.
	ios: null };

const asList = (v) => (v == null || v === '' ? [] : Array.isArray(v) ? v : [v]);
const asText = (v) => asList(v).join(' ').trim();
const regionOf = (tag) => /[-_]([A-Za-z]{2})\b/.exec(String(tag ?? ''))?.[1]?.toUpperCase() ?? '';

/**
 * The note header's values for the keys the style reads, from the metadata
 * the engine merges (its keys as written, its values lists of lines).
 *
 * @param {Record<string, unknown>} metadata
 * @returns {Record<string, string>} by the style's spelling of each key
 */
export function headerValues(metadata) {
	const out = {};
	for (const [key, value] of Object.entries(metadata ?? {})) {
		const name = HEADER_KEYS.get(key.toLowerCase().replace(/[\s_]+/g, ' ').trim());
		if (name) out[name] = asList(value).join('\n');
	}
	return out;
}

/**
 * babel's name for a language tag — the engine's table; a bare `en` takes
 * the region's English (the machine's: a British Mac's `en` is British), and
 * falls back to babel's `english`. Null for a tag babel does not know.
 */
export function babelName(lang, region = '') {
	const tag = String(lang ?? '').trim().toLowerCase().replace(/_/g, '-');
	if (tag === 'en' && region) return BABEL[`en-${region.toLowerCase()}`] ?? BABEL.en;
	return BABEL[tag] ?? BABEL[tag.split('-')[0]] ?? null;
}

/**
 * Whether a build gets the style, and what then decides its paper and faces —
 * the host's settings, as each host reads them: null unless the build is
 * LaTeX (a PDF via LaTeX is one), the `latexExportStyle` setting is `clew`
 * (its default) and the `latexEngine` setting does not force pdfLaTeX (which
 * no Garamond-by-file style survives); else the machine's locale and
 * platform (`darwin`, `win32`, `linux`, `ios` — the emoji face, EMOJI).
 *
 * @param {{ to?: string, style?: string, engine?: string, locale?: string, platform?: string }} o
 * @returns {{ locale: string, platform: string } | null}
 */
export function latexStyleWanted({ to, style, engine, locale = '', platform = '' } = {}) {
	if (to !== 'latex' || (style ?? 'clew') !== 'clew' || engine === 'pdflatex') return null;
	return { locale, platform };
}

/**
 * The configuration keys the style sets, as [key, value] pairs — none at all
 * for a header that forces pdfLaTeX, and none the header set itself.
 *
 * @param {(key: string) => unknown} get - the engine's configuration as the
 *   user's config files left it (configManager.get before the header)
 * @param {{ locale?: string, platform?: string, defaults?: object,
 *   header?: Record<string, string> }} [where] - the machine's locale (`en-GB`)
 *   and platform; the engine's DEFAULT_CONFIG, so a key still at its default
 *   counts as unset; the note header's values (headerValues), or none
 * @returns {[string, unknown][]}
 */
export function latexStyleConfig(get, { locale = '', platform = 'darwin', defaults = {}, header = {} } = {}) {
	if (/^\s*pdflatex\s*$/i.test(header['LaTeX engine'] ?? '')) return [];
	const out = [];
	const configured = (key) => {
		const v = get(key);
		return v == null || v === '' || v === defaults[key] ? null : v;
	};
	const chosen = (key) => (key in header ? header[key] : configured(key));
	const lang = String(chosen('Lang') ?? 'en');
	const region = regionOf(lang) || regionOf(locale);
	const paper = LETTER_REGIONS.has(region) ? 'letterpaper' : 'a4paper';

	if (chosen('LaTeX engine') == null) out.push(['LaTeX engine', 'lualatex']);
	const classOptions = chosen('Class options');
	if (classOptions == null) out.push(['Class options', `12pt,${paper}`]);
	if (chosen('Geometry') == null) {
		// Class options that name no paper (`11pt`) would print on the class's
		// Letter: the region's paper, through geometry.
		const own = classOptions != null && !PAPER.test(asText(classOptions));
		out.push(['Geometry', `${own ? `${paper},` : ''}textwidth=31pc,top=30mm,bottom=32mm`]);
	}
	if (!('Smart typography' in header) && get('Smart typography') !== true) out.push(['Smart typography', true]);
	if (!('Packages' in header)) {
		const userPackages = asList(get('Packages'));
		out.push(['Packages', [...userPackages, ...PACKAGES.filter((p) => !userPackages.includes(p))]]);
	}
	if (!('LaTeX preamble' in header)) {
		out.push(['LaTeX preamble', [...asList(get('LaTeX preamble')), ...preamble({ babel: babelName(lang, region), platform })]]);
	}
	return out;
}

/** The style's preamble lines: every one guarded by the package it needs. */
function preamble({ babel, platform }) {
	const emoji = Object.hasOwn(EMOJI, platform) ? EMOJI[platform] : EMOJI.linux;
	const garamond = 'EBGaramond-Regular.otf';
	const faces = '[Extension=.otf,UprightFont=*-Regular,ItalicFont=*-Italic,BoldFont=*-Bold,BoldItalicFont=*-BoldItalic';
	// Commands as old as LaTeX2e: \@ifpackageloaded, inside \makeatletter —
	// never the 2021-11 kernel's \IfPackageLoadedTF, which an older TeX Live
	// does not have, and the style is on by default (Clew-boss, 2026-10-19).
	const ifLoaded = (pkg, then) => `\\@ifpackageloaded{${pkg}}{${then}}{}`;
	return [
		'% Clew\'s export style (Settings → Appearance; `latexExportStyle: none` leaves it out).',
		'\\makeatletter',
		// The document language's hyphenation, unless a babel or polyglossia
		// is loaded already (the engine's for a book in other languages, the
		// user's own). Loaded late, after hyperref: measured to compile and
		// hyphenate as the language does (british or-gan-isa-tion, ngerman
		// or-ga-ni-sa-ti-on).
		...(babel ? [`\\@ifpackageloaded{babel}{}{\\@ifpackageloaded{polyglossia}{}{\\usepackage[${babel}]{babel}}}`] : []),
		// fontspec's, so only where it is loaded (a config forcing pdfLaTeX has
		// none). The emoji fallback is LuaTeX's — luaotfload 3.11 and later
		// (TeX Live 2020), asked first — and only for a face that is there: a
		// fallback naming a missing one leaves the MAIN font null, every
		// character dropped (measured). XeTeX gets the face alone, and so does a
		// platform with no colour face (`ios`).
		'\\@ifpackageloaded{fontspec}{\\IfFontExistsTF{' + garamond + '}{%',
		...(emoji ? [
			'  \\ifdefined\\directlua',
			`    \\IfFontExistsTF{${emoji}}{%`,
			'      \\ifnum\\directlua{tex.sprint(luaotfload.add_fallback and 1 or 0)}=1\\relax',
			`        \\directlua{luaotfload.add_fallback("clewemoji", {"${emoji}:mode=harf;"})}%`,
			`        \\setmainfont{EBGaramond}${faces},RawFeature={fallback=clewemoji}]%`,
			'      \\else',
			`        \\setmainfont{EBGaramond}${faces}]%`,
			'      \\fi',
			`    }{\\setmainfont{EBGaramond}${faces}]}%`,
			'  \\else',
			`    \\setmainfont{EBGaramond}${faces}]%`,
			'  \\fi',
		] : [`  \\setmainfont{EBGaramond}${faces}]%`]),
		'}{}}{}',
		ifLoaded('unicode-math', '\\IfFontExistsTF{Garamond-Math.otf}{\\setmathfont{Garamond-Math.otf}[StylisticSet={7,8,9}]}{}'),
		ifLoaded('enumitem', '\\setlist{itemsep=0.35\\baselineskip,topsep=0.5\\baselineskip}\\setlist[itemize,2]{label=–,itemsep=0.15\\baselineskip}'),
		'\\@ifpackageloaded{titlesec}{%',
		'  \\titleformat{\\section}{\\normalfont\\Large\\bfseries}{\\thesection}{0.8em}{}%',
		'  \\titleformat{\\subsection}{\\normalfont\\large\\itshape}{\\thesubsection}{0.8em}{}%',
		'  \\titlespacing*{\\section}{0pt}{3ex plus 1ex minus .2ex}{1.2ex plus .2ex}%',
		'  \\titlespacing*{\\subsection}{0pt}{2ex plus .5ex minus .2ex}{0.8ex plus .2ex}%',
		'}{}',
		ifLoaded('etoolbox', '\\AtBeginEnvironment{quote}{\\small}\\AtBeginEnvironment{quotation}{\\small}'),
		// The title: jmarkdown's \maketitle under `LaTeX maketitle` (the
		// title-page directives, which the export worker turns on) or the
		// header's. Each author is a column, as LaTeX's own — `\and` closes one
		// tabular and opens the next, so the authors' line needs them — its
		// name in small capitals and the institution under it upright.
		'\\@ifpackageloaded{titling}{%',
		'  \\pretitle{\\begin{center}\\LARGE}\\posttitle{\\par\\end{center}\\vskip 1.2em}%',
		'  \\preauthor{\\begin{center}\\lineskip .5em\\def\\and{\\end{tabular}\\hskip 1em \\@plus.17fil\\begin{tabular}[t]{c}\\large\\scshape}\\begin{tabular}[t]{c}\\large\\scshape}%',
		'  \\postauthor{\\end{tabular}\\par\\end{center}}%',
		'  \\predate{\\begin{center}\\normalsize}\\postdate{\\par\\end{center}\\vskip 1.5em}%',
		'}{}',
		ifLoaded('hyperref', '\\hypersetup{hidelinks}'),
		'\\makeatother',
	];
}
