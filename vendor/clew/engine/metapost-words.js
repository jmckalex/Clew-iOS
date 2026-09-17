// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// MetaPost's vocabulary, in the four classes a highlighter colours: the
// primitives and plain-macro statements (mpost's own plain.mp, plus the
// `boxes` package, which every flowchart uses), the type declarators, the
// named constants plain.mp defines, and the word-shaped operators.
//
// ONE list, two readers, the block-refs.js / block-ids.js arrangement: the
// engine's figures.js builds a highlight.js grammar from it for the
// preview's `show=code` fences, and the editor's metapost-mode.js tokenizes
// source-mode fences by it — so the two cannot drift. Lives in src/engine
// because dist/engine is a verbatim copy served to the render worker, which
// can reach nothing in src/shared; the renderer bundle can import from here.

/** Structure, definitions, loops and the drawing statements. */
export const METAPOST_KEYWORDS = [
	'beginfig', 'endfig', 'def', 'vardef', 'primarydef', 'secondarydef',
	'tertiarydef', 'enddef', 'if', 'else', 'elseif', 'fi', 'for', 'forever',
	'forsuffixes', 'endfor', 'upto', 'downto', 'step', 'until', 'exitif',
	'exitunless', 'let', 'begingroup', 'endgroup', 'save', 'interim',
	'newinternal', 'input', 'end', 'bye', 'btex', 'etex', 'verbatimtex',
	'draw', 'fill', 'filldraw', 'drawarrow', 'drawdblarrow', 'undraw', 'unfill',
	'cutdraw', 'clip', 'setbounds', 'addto', 'also', 'contour', 'doublepath',
	'pickup', 'label', 'dotlabel', 'thelabel', 'labels', 'dotlabels', 'shipout',
	'show', 'showtoken', 'showvariable', 'showdependencies', 'message',
	'errmessage', 'errhelp', 'special', 'scantokens', 'write', 'readfrom',
	'closefrom', 'penpos', 'penstroke',
	// the boxes package
	'boxit', 'circleit', 'drawboxed', 'drawunboxed', 'drawboxes', 'boxjoin',
	'fixsize', 'fixpos',
];

/** Type declarators, and the parameter kinds a def takes. */
export const METAPOST_TYPES = [
	'numeric', 'pair', 'path', 'pen', 'picture', 'string', 'boolean',
	'transform', 'color', 'cmykcolor', 'rgbcolor',
	'expr', 'suffix', 'text', 'primary', 'secondary', 'tertiary',
];

/** Named constants and predefined pictures, pens, colours and units. */
export const METAPOST_CONSTANTS = [
	'true', 'false', 'cycle', 'origin', 'up', 'down', 'left', 'right',
	'fullcircle', 'halfcircle', 'quartercircle', 'unitsquare', 'identity',
	'pencircle', 'pensquare', 'penrazor', 'penspeck', 'nullpen', 'nullpicture',
	'currentpicture', 'currentpen', 'black', 'white', 'red', 'green', 'blue',
	'cyan', 'magenta', 'yellow', 'whatever', 'evenly', 'withdots', 'epsilon',
	'infinity', 'pi', 'butt', 'rounded', 'squared', 'beveled', 'mitered',
	'bp', 'cm', 'mm', 'pt', 'dd', 'cc', 'pc', 'in',
	'ahlength', 'ahangle', 'labeloffset', 'bboxmargin', 'dotlabeldiam',
	'defaultpen', 'defaultscale', 'linecap', 'linejoin', 'miterlimit',
	'truecorners', 'prologues', 'outputtemplate', 'charcode',
];

/** Word-shaped operators and functions. */
export const METAPOST_OPERATORS = [
	'and', 'or', 'not', 'of', 'scaled', 'shifted', 'rotated', 'slanted',
	'xscaled', 'yscaled', 'zscaled', 'reflectedabout', 'rotatedaround',
	'transformed', 'withpen', 'withcolor', 'withrgbcolor', 'withcmykcolor',
	'withgreyscale', 'withprescript', 'withpostscript', 'dashed', 'controls',
	'tension', 'curl', 'atleast', 'intersectionpoint', 'intersectiontimes',
	'intersectionpath', 'point', 'direction', 'directionpoint', 'directiontime',
	'precontrol', 'postcontrol', 'subpath', 'length', 'cutbefore', 'cutafter',
	'reverse', 'along', 'infont', 'xpart', 'ypart', 'xxpart', 'xypart', 'yxpart',
	'yypart', 'redpart', 'greenpart', 'bluepart', 'cyanpart', 'magentapart',
	'yellowpart', 'blackpart', 'greypart', 'pathpart', 'penpart', 'textpart',
	'dashpart', 'urcorner', 'ulcorner', 'llcorner', 'lrcorner', 'center',
	'bbox', 'bpath', 'arclength', 'arctime', 'sqrt', 'sind', 'cosd', 'floor',
	'round', 'ceiling', 'abs', 'unitvector', 'angle', 'dir', 'mexp', 'mlog',
	'normaldeviate', 'uniformdeviate', 'str', 'substring', 'decimal', 'hex',
	'oct', 'char', 'ASCII', 'known', 'unknown', 'glyph', 'max', 'min',
];
