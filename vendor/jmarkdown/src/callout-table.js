/*
	The callout TABLE — the built-in types, their icons and palette, the
	custom types installed over them, and the lookups — with NO imports but
	callout-definitions.js, which has none.

	Split from callouts.js so that code with no engine can share it: Clew's
	renderer bundle (esbuild, browser: no fs, os or module) and its main
	process import this module, not callouts.js (which pulls in
	config-manager.js, and with it the filesystem and the cwd's config). One
	module instance serves both: a table installed here with
	applyCustomCallouts() is the one callouts.js renders with. tests/callouts
	checks the import graph stays this small.

	callouts.js holds the marked extension, the `Callouts` config key (which
	needs the filesystem, for Font Awesome's svgs) and the LaTeX side, and
	re-exports this module's names.
*/

import { defaultTitle } from './callout-definitions.js';

/** "CAUTION" → "Caution": a name as a title (see untitledCalloutTitle). */
export { defaultTitle };

/** Each icon's path, in its own viewBox (VIEWBOX) — all exact Font Awesome Free
 *  6.7.2 (solid, but `clipboard` is regular); see THIRD-PARTY-NOTICES.md. */
export const ICONS = {
	pencil: 'M410.3 231l11.3-11.3-33.9-33.9-62.1-62.1L291.7 89.8l-11.3 11.3-22.6 22.6L58.6 322.9c-10.4 10.4-18 23.3-22.2 37.4L1 480.7c-2.5 8.4-.2 17.5 6.1 23.7s15.3 8.5 23.7 6.1l120.3-35.4c14.1-4.2 27-11.8 37.4-22.2L387.7 253.7 410.3 231zM160 399.4l-9.1 22.7c-4 3.1-8.5 5.4-13.3 6.9L59.4 452l23-78.1c1.4-4.9 3.8-9.4 6.9-13.3l22.7-9.1 0 32c0 8.8 7.2 16 16 16l32 0zM362.7 18.7L348.3 33.2 325.7 55.8 314.3 67.1l33.9 33.9 62.1 62.1 33.9 33.9 11.3-11.3 22.6-22.6 14.5-14.5c25-25 25-65.5 0-90.5L453.3 18.7c-25-25-65.5-25-90.5 0zm-47.4 168l-144 144c-6.2 6.2-16.4 6.2-22.6 0s-6.2-16.4 0-22.6l144-144c6.2-6.2 16.4-6.2 22.6 0s6.2 16.4 0 22.6z',
	clipboard: 'M280 64l40 0c35.3 0 64 28.7 64 64l0 320c0 35.3-28.7 64-64 64L64 512c-35.3 0-64-28.7-64-64L0 128C0 92.7 28.7 64 64 64l40 0 9.6 0C121 27.5 153.3 0 192 0s71 27.5 78.4 64l9.6 0zM64 112c-8.8 0-16 7.2-16 16l0 320c0 8.8 7.2 16 16 16l256 0c8.8 0 16-7.2 16-16l0-320c0-8.8-7.2-16-16-16l-16 0 0 24c0 13.3-10.7 24-24 24l-88 0-88 0c-13.3 0-24-10.7-24-24l0-24-16 0zm128-8a24 24 0 1 0 0-48 24 24 0 1 0 0 48z',
	info: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM216 336l24 0 0-64-24 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l48 0c13.3 0 24 10.7 24 24l0 88 8 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24zm40-208a32 32 0 1 1 0 64 32 32 0 1 1 0-64z',
	circleCheck: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM369 209L241 337c-9.4 9.4-24.6 9.4-33.9 0l-64-64c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l47 47L335 175c9.4-9.4 24.6-9.4 33.9 0s9.4 24.6 0 33.9z',
	fire: 'M159.3 5.4c7.8-7.3 19.9-7.2 27.7 .1c27.6 25.9 53.5 53.8 77.7 84c11-14.4 23.5-30.1 37-42.9c7.9-7.4 20.1-7.4 28 .1c34.6 33 63.9 76.6 84.5 118c20.3 40.8 33.8 82.5 33.8 111.9C448 404.2 348.2 512 224 512C98.4 512 0 404.1 0 276.5c0-38.4 17.8-85.3 45.4-131.7C73.3 97.7 112.7 48.6 159.3 5.4zM225.7 416c25.3 0 47.7-7 68.8-21c42.1-29.4 53.4-88.2 28.1-134.4c-4.5-9-16-9.6-22.5-2l-25.2 29.3c-6.6 7.6-18.5 7.4-24.7-.5c-16.5-21-46-58.5-62.8-79.8c-6.3-8-18.3-8.1-24.7-.1c-33.8 42.5-50.8 69.3-50.8 99.4C112 375.4 162.6 416 225.7 416z',
	check: 'M438.6 105.4c12.5 12.5 12.5 32.8 0 45.3l-256 256c-12.5 12.5-32.8 12.5-45.3 0l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0L160 338.7 393.4 105.4c12.5-12.5 32.8-12.5 45.3 0z',
	question: 'M256 512A256 256 0 1 0 256 0a256 256 0 1 0 0 512zM169.8 165.3c7.9-22.3 29.1-37.3 52.8-37.3l58.3 0c34.9 0 63.1 28.3 63.1 63.1c0 22.6-12.1 43.5-31.7 54.8L280 264.4c-.2 13-10.9 23.6-24 23.6c-13.3 0-24-10.7-24-24l0-13.5c0-8.6 4.6-16.5 12.1-20.8l44.3-25.4c4.7-2.7 7.6-7.7 7.6-13.1c0-8.4-6.8-15.1-15.1-15.1l-58.3 0c-3.4 0-6.4 2.1-7.5 5.3l-.4 1.2c-4.4 12.5-18.2 19-30.6 14.6s-19-18.2-14.6-30.6l.4-1.2zM224 352a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z',
	triangleExclamation: 'M256 32c14.2 0 27.3 7.5 34.5 19.8l216 368c7.3 12.4 7.3 27.7 .2 40.1S486.3 480 472 480L40 480c-14.3 0-27.6-7.7-34.7-20.1s-7-27.8 .2-40.1l216-368C228.7 39.5 241.8 32 256 32zm0 128c-13.3 0-24 10.7-24 24l0 112c0 13.3 10.7 24 24 24s24-10.7 24-24l0-112c0-13.3-10.7-24-24-24zm32 224a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z',
	xmark: 'M342.6 150.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192 210.7 86.6 105.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L146.7 256 41.4 361.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192 301.3 297.4 406.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.3 256 342.6 150.6z',
	bolt: 'M349.4 44.6c5.9-13.7 1.5-29.7-10.6-38.5s-28.6-8-39.9 1.8l-256 224c-10 8.8-13.6 22.9-8.9 35.3S50.7 288 64 288l111.5 0L98.6 467.4c-5.9 13.7-1.5 29.7 10.6 38.5s28.6 8 39.9-1.8l256-224c10-8.8 13.6-22.9 8.9-35.3s-16.6-20.7-30-20.7l-111.5 0L349.4 44.6z',
	bug: 'M256 0c53 0 96 43 96 96l0 3.6c0 15.7-12.7 28.4-28.4 28.4l-135.1 0c-15.7 0-28.4-12.7-28.4-28.4l0-3.6c0-53 43-96 96-96zM41.4 105.4c12.5-12.5 32.8-12.5 45.3 0l64 64c.7 .7 1.3 1.4 1.9 2.1c14.2-7.3 30.4-11.4 47.5-11.4l112 0c17.1 0 33.2 4.1 47.5 11.4c.6-.7 1.2-1.4 1.9-2.1l64-64c12.5-12.5 32.8-12.5 45.3 0s12.5 32.8 0 45.3l-64 64c-.7 .7-1.4 1.3-2.1 1.9c6.2 12 10.1 25.3 11.1 39.5l64.3 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-64 0c0 24.6-5.5 47.8-15.4 68.6c2.2 1.3 4.2 2.9 6 4.8l64 64c12.5 12.5 12.5 32.8 0 45.3s-32.8 12.5-45.3 0l-63.1-63.1c-24.5 21.8-55.8 36.2-90.3 39.6L272 240c0-8.8-7.2-16-16-16s-16 7.2-16 16l0 239.2c-34.5-3.4-65.8-17.8-90.3-39.6L86.6 502.6c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3l64-64c1.9-1.9 3.9-3.4 6-4.8C101.5 367.8 96 344.6 96 320l-64 0c-17.7 0-32-14.3-32-32s14.3-32 32-32l64.3 0c1.1-14.1 5-27.5 11.1-39.5c-.7-.6-1.4-1.2-2.1-1.9l-64-64c-12.5-12.5-12.5-32.8 0-45.3z',
	listOl: 'M24 56c0-13.3 10.7-24 24-24l32 0c13.3 0 24 10.7 24 24l0 120 16 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-80 0c-13.3 0-24-10.7-24-24s10.7-24 24-24l16 0 0-96-8 0C34.7 80 24 69.3 24 56zM86.7 341.2c-6.5-7.4-18.3-6.9-24 1.2L51.5 357.9c-7.7 10.8-22.7 13.3-33.5 5.6s-13.3-22.7-5.6-33.5l11.1-15.6c23.7-33.2 72.3-35.6 99.2-4.9c21.3 24.4 20.8 60.9-1.1 84.7L86.8 432l33.2 0c13.3 0 24 10.7 24 24s-10.7 24-24 24l-88 0c-9.5 0-18.2-5.6-22-14.4s-2.1-18.9 4.3-25.9l72-78c5.3-5.8 5.4-14.6 .3-20.5zM224 64l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32zm0 160l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32zm0 160l256 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-256 0c-17.7 0-32-14.3-32-32s14.3-32 32-32z',
	quoteLeft: 'M0 216C0 149.7 53.7 96 120 96l8 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-8 0c-30.9 0-56 25.1-56 56l0 8 64 0c35.3 0 64 28.7 64 64l0 64c0 35.3-28.7 64-64 64l-64 0c-35.3 0-64-28.7-64-64l0-32 0-32 0-72zm256 0c0-66.3 53.7-120 120-120l8 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-8 0c-30.9 0-56 25.1-56 56l0 8 64 0c35.3 0 64 28.7 64 64l0 64c0 35.3-28.7 64-64 64l-64 0c-35.3 0-64-28.7-64-64l0-32 0-32 0-72z',
	listCheck: 'M152.1 38.2c9.9 8.9 10.7 24 1.8 33.9l-72 80c-4.4 4.9-10.6 7.8-17.2 7.9s-12.9-2.4-17.6-7L7 113C-2.3 103.6-2.3 88.4 7 79s24.6-9.4 33.9 0l22.1 22.1 55.1-61.2c8.9-9.9 24-10.7 33.9-1.8zm0 160c9.9 8.9 10.7 24 1.8 33.9l-72 80c-4.4 4.9-10.6 7.8-17.2 7.9s-12.9-2.4-17.6-7L7 273c-9.4-9.4-9.4-24.6 0-33.9s24.6-9.4 33.9 0l22.1 22.1 55.1-61.2c8.9-9.9 24-10.7 33.9-1.8zM224 96c0-17.7 14.3-32 32-32l224 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-224 0c-17.7 0-32-14.3-32-32zm0 160c0-17.7 14.3-32 32-32l224 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-224 0c-17.7 0-32-14.3-32-32zM160 416c0-17.7 14.3-32 32-32l288 0c17.7 0 32 14.3 32 32s-14.3 32-32 32l-288 0c-17.7 0-32-14.3-32-32zM48 368a48 48 0 1 1 0 96 48 48 0 1 1 0-96z',
	// jmarkdown's own `suggestion` type (below): Font Awesome Free 6.7.2 solid.
	lightbulb: 'M272 384c9.6-31.9 29.5-59.1 49.2-86.2c0 0 0 0 0 0c5.2-7.1 10.4-14.2 15.4-21.4c19.8-28.5 31.4-63 31.4-100.3C368 78.8 289.2 0 192 0S16 78.8 16 176c0 37.3 11.6 71.9 31.4 100.3c5 7.2 10.2 14.3 15.4 21.4c0 0 0 0 0 0c19.8 27.1 39.7 54.4 49.2 86.2l160 0zM192 512c44.2 0 80-35.8 80-80l0-16-160 0 0 16c0 44.2 35.8 80 80 80zM112 176c0 8.8-7.2 16-16 16s-16-7.2-16-16c0-61.9 50.1-112 112-112c8.8 0 16 7.2 16 16s-7.2 16-16 16c-44.2 0-80 35.8-80 80z',
};

// viewBox differs between icons; Font Awesome's are all 512 high but vary in
// width, so each entry carries its own.
export const VIEWBOX = {
	pencil: '0 0 512 512', clipboard: '0 0 384 512', info: '0 0 512 512',
	circleCheck: '0 0 512 512', fire: '0 0 448 512', check: '0 0 448 512',
	question: '0 0 512 512', triangleExclamation: '0 0 512 512', xmark: '0 0 384 512',
	bolt: '0 0 448 512', bug: '0 0 512 512', listOl: '0 0 512 512',
	quoteLeft: '0 0 448 512', listCheck: '0 0 512 512',
	lightbulb: '0 0 384 512',
};

/**
 * Obsidian's callout types, their aliases, and the icon each gets. The
 * canonical name becomes the CSS hook; aliases fold onto it, so `[!tldr]` and
 * `[!abstract]` are the same callout and a stylesheet needs one rule.
 */
export const BUILTIN = {
	note: { icon: 'pencil', label: 'Note' },
	abstract: { icon: 'clipboard', label: 'Abstract', aliases: ['summary', 'tldr'] },
	info: { icon: 'info', label: 'Info' },
	todo: { icon: 'circleCheck', label: 'Todo' },
	tip: { icon: 'fire', label: 'Tip', aliases: ['hint', 'important'] },
	success: { icon: 'check', label: 'Success', aliases: ['check', 'done'] },
	question: { icon: 'question', label: 'Question', aliases: ['help', 'faq'] },
	warning: { icon: 'triangleExclamation', label: 'Warning', aliases: ['caution', 'attention'] },
	failure: { icon: 'xmark', label: 'Failure', aliases: ['fail', 'missing'] },
	danger: { icon: 'bolt', label: 'Danger', aliases: ['error'] },
	bug: { icon: 'bug', label: 'Bug' },
	example: { icon: 'listOl', label: 'Example' },
	quote: { icon: 'quoteLeft', label: 'Quote', aliases: ['cite'] },
	// Not Obsidian's, but it appeared in its own help vault often enough to be
	// worth recognising rather than dropping to a bare blockquote.
	compatibility: { icon: 'listCheck', label: 'Compatibility' },
	// jmarkdown's own, kept from its marked-alert days (the owner's call,
	// 2026-10-02) so `[!SUGGESTION]` keeps a look of its own. The one built-in
	// Clew @0423008 does not have: there, [!suggestion] fell through.
	suggestion: { icon: 'lightbulb', label: 'Suggestion' },
};

// Each type's accent colour, for LaTeX: the same values as the palette in
// jmarkdown.css (tests/callouts/run.sh checks the two agree). A type with no
// entry — unknown, or custom with no colour of its own — takes note's, which
// is also the stylesheet's default, as Obsidian draws such a callout.
export const PALETTE = {
	note: '#5b8def', abstract: '#00b8a3', info: '#3b9dd8', todo: '#3b9dd8',
	tip: '#00b8a3', success: '#3fb950', question: '#d9a441', warning: '#e08c3c',
	failure: '#e5534b', danger: '#e5534b', bug: '#e5534b', example: '#a371f7',
	quote: '#8b949e', compatibility: '#00b8a3',
	// A hue nothing else uses (OKLCH 0.66, 0.17, 350°): a lightbulb's yellow
	// would sit too near question's amber.
	suggestion: '#db61a2',
};

// The installed table: BUILTIN, or BUILTIN with a custom table merged in.
let TYPES = BUILTIN;
let ALIASES = aliasMap(TYPES);
let generation = 0;

/**
 * The canonical types, for an editor: name → { label, aliases, color }. One
 * table, so an editor cannot offer or draw a type the engine would not
 * render. A LIVE binding: applyCustomCallouts replaces it, so read it when it
 * is used.
 */
export let CALLOUT_TYPES = publicTable(TYPES);

/** The built-ins alone, whatever is installed — what a definition overrides. */
export const BUILTIN_CALLOUT_TYPES = publicTable(BUILTIN);

/** alias → canonical name. A type's own name always wins over an alias. */
function aliasMap(types) {
	const map = new Map();
	for (const [name, spec] of Object.entries(types)) {
		for (const alias of spec.aliases ?? []) map.set(alias, name);
	}
	for (const name of Object.keys(types)) map.set(name, name);
	return map;
}

function publicTable(types) {
	return Object.freeze(Object.fromEntries(Object.entries(types).map(([name, spec]) =>
		[name, Object.freeze({ label: spec.label, aliases: spec.aliases ?? [], color: spec.color ?? null, custom: spec.custom === true })])));
}

// Checked again here although the caller validated them: what reaches markup
// is a colour from this grammar and path data from these characters, whatever
// the caller passed.
const NAME_OK = /^[a-z][\w-]*$/;
const COLOR_OK = /^(?:#[0-9a-fA-F]{3,8}|(?:rgba?|hsla?)\([\d\s.,%/deg]+\)|[a-zA-Z]+)$/;
const PATH_OK = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;

// What a host installed with applyCustomCallouts — kept, so the `Callouts`
// config (callouts.js) can be unset again without losing it — and a count of
// how often one was, which callouts.js watches to know when to look again.
let hostTable = null;
let hostVersion = 0;

/**
 * Install a host's custom types (replacing any installed before); `{}` or
 * null goes back to the built-ins. Each entry is resolved already: a
 * built-in's name overrides it, and a null icon or colour keeps the
 * built-in's.
 *
 * @param {Record<string, {label?: string, color?: string|null,
 *   icon?: [number, number, string]|null, aliases?: string[]}>|null} custom
 */
export function applyCustomCallouts(custom) {
	hostTable = custom ?? null;
	hostVersion++;
	installCalloutTable(hostTable);
}

/** The table a host installed, or null. */
export function hostCalloutTable() {
	return hostTable;
}

/** Bumped by every applyCustomCallouts. */
export function hostCalloutVersion() {
	return hostVersion;
}

/** Install a resolved table as the one rendered with — the host's, or the
 *  `Callouts` config's (callouts.js). Same contract as applyCustomCallouts. */
export function installCalloutTable(custom) {
	const entries = Object.entries(custom ?? {}).filter(([name]) => NAME_OK.test(name));
	generation++;
	if (entries.length === 0) {
		TYPES = BUILTIN;
	} else {
		TYPES = { ...BUILTIN };
		for (const [name, spec] of entries) {
			const base = BUILTIN[name];
			const svg = Array.isArray(spec.icon) && spec.icon.length === 3 && PATH_OK.test(String(spec.icon[2]))
				&& Number(spec.icon[0]) > 0 && Number(spec.icon[1]) > 0
				? [Number(spec.icon[0]), Number(spec.icon[1]), String(spec.icon[2])] : null;
			const color = typeof spec.color === 'string' && COLOR_OK.test(spec.color.trim()) ? spec.color.trim() : null;
			const label = typeof spec.label === 'string' && spec.label.trim()
				? spec.label.trim() : base?.label ?? name.charAt(0).toUpperCase() + name.slice(1);
			const aliases = (Array.isArray(spec.aliases) ? spec.aliases : [])
				.map((a) => String(a).toLowerCase()).filter((a) => NAME_OK.test(a));
			TYPES[name] = {
				icon: svg ? null : base?.icon ?? 'pencil',
				svg,
				label,
				aliases: [...new Set([...(base?.aliases ?? []), ...aliases])],
				color,
				custom: true,
			};
		}
	}
	ALIASES = aliasMap(TYPES);
	CALLOUT_TYPES = publicTable(TYPES);
}

/** Bumped by every change of table — a widget keyed on a type redraws. */
export function calloutGeneration() {
	return generation;
}

// Clew's render worker is handed its resolved table at spawn through
// CLEW_CALLOUTS; `process` is a guard, not an assumption — a browser or
// Clew-iOS loads this module where there is none.
try {
	const fromEnv = globalThis.process?.env?.CLEW_CALLOUTS;
	if (fromEnv) applyCustomCallouts(JSON.parse(fromEnv));
} catch {
	// A table that does not parse is no table: the built-ins stand.
}

/* --- Types, icons, colours ---------------------------------------------------- */

// The spec a type renders with — an unknown type's is note's look, titled
// with its own name.
export function specFor(type) {
	return TYPES[type] ?? { icon: 'pencil', label: defaultTitle(type), aliases: [] };
}

/** A type's icon as inline SVG markup (the same one reading mode draws). */
export function calloutIcon(type) {
	const spec = specFor(type);
	return spec.svg ? customSvg(spec.svg) : iconSvg(spec.icon);
}

/** A BUILT-IN type's own icon, whatever a definition put over it. */
export function builtinCalloutIcon(type) {
	return iconSvg(BUILTIN[type]?.icon ?? 'pencil');
}

/** A custom colour for a type, or null (the stylesheet's palette applies). */
export function calloutColor(type) {
	return TYPES[type]?.color ?? null;
}

/** The canonical type for whatever the author wrote, or null. Case-insensitive. */
export function resolveType(raw) {
	return ALIASES.get(String(raw ?? '').toLowerCase().trim()) ?? null;
}

/**
 * The heading of an UNTITLED callout, from the type as the author WROTE it
 * — as GitHub and Obsidian title them. The type's own name (in any case)
 * gives the type's title: a built-in's label, or a custom type's `title`. An
 * alias, or an unknown type, gives the name written, through defaultTitle:
 *
 *   [!NOTE], [!note] → "Note"    [!CAUTION] → "Caution" (a warning)
 *   [!tldr] → "Tldr" (abstract)  [!my-type] → "My-type" (unknown)
 *
 * The callout's look — icon, colour, data-callout — is always the canonical
 * type's; only the words change.
 */
export function untitledCalloutTitle(written) {
	const name = String(written ?? '').toLowerCase().trim();
	const type = resolveType(name) ?? name;
	return name === type ? specFor(type).label : defaultTitle(name);
}

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
	.replace(/"/g, '&quot;');

function iconSvg(name) {
	const path = ICONS[name];
	if (!path) return '';
	return `<svg class="callout-icon" viewBox="${VIEWBOX[name]}" aria-hidden="true" focusable="false">`
		+ `<path fill="currentColor" d="${path}"/></svg>`;
}

function customSvg([width, height, d]) {
	return `<svg class="callout-icon" viewBox="0 0 ${width} ${height}" aria-hidden="true" focusable="false">`
		+ `<path fill="currentColor" d="${escapeHtml(d)}"/></svg>`;
}

/** [width, height, path] for a type's icon, whichever kind it is — what
 *  callout-latex.js draws. */
export function calloutIconGeometry(type) {
	return iconGeometry(specFor(type));
}

function iconGeometry(spec) {
	if (spec.svg) return spec.svg;
	const name = ICONS[spec.icon] ? spec.icon : 'pencil';
	const [, , width, height] = VIEWBOX[name].split(' ').map(Number);
	return [width, height, ICONS[name]];
}

/** A type's accent colour in its palette, for LaTeX (the stylesheet holds the
 *  same values); a type with none — unknown, or custom with no colour of its
 *  own — takes note's. A custom colour is calloutColor's, not this. */
export function calloutAccent(type) {
	return PALETTE[type] ?? PALETTE.note;
}
