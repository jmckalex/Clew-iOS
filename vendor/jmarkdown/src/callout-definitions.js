/*
	Custom callout TYPES — validation and merging, shared by the callout
	extension (callouts.js) and any host that resolves its own definitions.

	Ported from Clew-app's src/shared/custom-callouts.js (@0423008), so a
	definition is accepted or refused for the same reason in both: Clew
	resolves its global and per-vault lists with it and hands the engine the
	result (applyCustomCallouts), and the jmarkdown CLI resolves the
	`Callouts` config key with it. The code below is Clew's except for
	defaultTitle, which now lower-cases the rest of the name (2026-10-02:
	titles come from the type as WRITTEN, so `CAUTION` must give "Caution");
	Clew imports this module rather than keeping its own copy.

	A definition is `{ name, title?, icon?, color?, aliases? }`. Everything is
	validated because a definition may come from anyone (a shared vault, a
	project config): a bad entry is SKIPPED with a reason, never half-applied,
	and nothing from a definition reaches the output but an escaped title, a
	colour from a fixed grammar and path data from the icon table itself.
*/

/** The `[!name]` token, as the callout tokenizer reads it. */
export const NAME_RE = /^[A-Za-z][\w-]*$/;

const MAX_TITLE = 80;
const MAX_ALIASES = 8;

// CSS colours, by grammar — no url(), var(), expressions or `;`.
const NUM = String.raw`\d{1,3}(?:\.\d+)?`;
const SEP = String.raw`(?:\s*,\s*|\s+)`;
const ALPHA = String.raw`(?:\s*(?:,|\/)\s*(?:0|1|0?\.\d+|\d{1,3}%))?`;
const COLOR_RES = [
	/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i,
	new RegExp(String.raw`^rgba?\(\s*${NUM}%?${SEP}${NUM}%?${SEP}${NUM}%?${ALPHA}\s*\)$`, 'i'),
	new RegExp(String.raw`^hsla?\(\s*${NUM}(?:deg)?${SEP}${NUM}%${SEP}${NUM}%${ALPHA}\s*\)$`, 'i'),
];
const NAMED = new Set(('aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet '
	+ 'brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan '
	+ 'darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred '
	+ 'darksalmon darkseagreen darkslateblue darkslategray darkslategrey darkturquoise darkviolet deeppink '
	+ 'deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold '
	+ 'goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory khaki lavender lavenderblush '
	+ 'lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey '
	+ 'lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime '
	+ 'limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen '
	+ 'mediumslateblue mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin '
	+ 'navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise '
	+ 'palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue '
	+ 'saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray slategrey snow '
	+ 'springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen').split(' '));

/** A colour a definition may use: hex, rgb()/rgba(), hsl()/hsla() or a CSS name. */
export function validColor(value) {
	const v = String(value ?? '').trim();
	return COLOR_RES.some((re) => re.test(v)) || NAMED.has(v.toLowerCase());
}

/** SVG path data, and nothing else (the icon table's, checked anyway). */
const PATH_RE = /^[MmLlHhVvCcSsQqTtAaZz0-9.,\s+-]+$/;

/** `pencil`, `regular:circle`, `brands:github` → the table's key, or null. */
export function iconKey(icon, table) {
	const name = String(icon ?? '').trim().toLowerCase();
	if (!/^(?:(?:solid|regular|brands):)?[a-z0-9-]+$/.test(name)) return null;
	if (name.includes(':')) return table?.[name] ? name : null;
	for (const family of ['solid', 'regular', 'brands']) if (table?.[`${family}:${name}`]) return `${family}:${name}`;
	return null;
}

/**
 * A callout name as a title: the first letter upper-case, the rest lower —
 * "CAUTION" → "Caution", "tldr" → "Tldr", "my-type" → "My-type". Obsidian's
 * docs say an untitled callout is titled with "its type identifier in title
 * case"; a hyphenated name is one word here, as GitHub's single-word alert
 * names give no other guide.
 */
export const defaultTitle = (name) => String(name).charAt(0).toUpperCase() + String(name).slice(1).toLowerCase();

/**
 * One stored entry, checked: `{ name, title?, icon?, color?, aliases? }`.
 *
 * @returns {{ entry: {name, title, icon, color, aliases} } | { reason: string }}
 *   `icon` is the table's key or null; `title` null when none was given
 */
export function checkEntry(raw, iconTable) {
	if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { reason: 'not an entry' };
	const name = String(raw.name ?? '').trim();
	if (!name) return { reason: 'no name' };
	if (!NAME_RE.test(name)) return { reason: `“${name}” is not a callout name — a letter, then letters, digits, - or _` };
	let title = null;
	if (raw.title != null && String(raw.title).trim()) {
		// eslint-disable-next-line no-control-regex
		title = String(raw.title).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, MAX_TITLE);
	}
	let icon = null;
	if (raw.icon != null && String(raw.icon).trim()) {
		icon = iconKey(raw.icon, iconTable);
		if (!icon) return { reason: `no Font Awesome icon called “${String(raw.icon).trim()}”` };
		if (!PATH_RE.test(iconTable[icon][2])) return { reason: `the icon “${icon}” has unexpected path data` };
	}
	let color = null;
	if (raw.color != null && String(raw.color).trim()) {
		if (!validColor(raw.color)) return { reason: `“${String(raw.color).trim()}” is not a colour (hex, rgb(), hsl() or a CSS name)` };
		color = String(raw.color).trim();
	}
	const aliases = [];
	for (const alias of Array.isArray(raw.aliases) ? raw.aliases.slice(0, MAX_ALIASES) : []) {
		const a = String(alias ?? '').trim().toLowerCase();
		if (!a) continue;
		if (!NAME_RE.test(a)) return { reason: `the alias “${a}” is not a callout name` };
		aliases.push(a);
	}
	return { entry: { name: name.toLowerCase(), title, icon, color, aliases } };
}

/**
 * Built-in < global < vault, resolved.
 *
 * @param {{ builtins: Record<string, {label: string, aliases: string[]}>,
 *   global?: unknown[], vault?: unknown[],
 *   iconTable?: Record<string, [number, number, string]> }} input
 * @returns {{
 *   custom: Record<string, {label: string, color: string|null,
 *     icon: [number, number, string]|null, aliases: string[], scope: 'global'|'vault'}>,
 *   problems: {scope: 'global'|'vault', index: number, name: string, reason: string,
 *     skipped: boolean}[] }}
 *   `custom` holds only what a definition changes or adds; `icon` null keeps a
 *   built-in's own. A problem either SKIPPED its entry (index is its place in
 *   the list) or is a note about one that applies (index -1 when the note is
 *   about the merged result, not one row)
 */
export function resolveCallouts({ builtins, global = [], vault = [], iconTable = {} }) {
	const custom = {};
	const problems = [];
	for (const scope of ['global', 'vault']) {
		const list = scope === 'global' ? global : vault;
		if (!Array.isArray(list)) {
			if (list != null) problems.push({ scope, index: -1, name: '', reason: 'not a list of callouts — ignored', skipped: true });
			continue;
		}
		const seen = new Set();
		list.forEach((raw, index) => {
			const checked = checkEntry(raw, iconTable);
			const name = String(raw?.name ?? '');
			if (checked.reason) { problems.push({ scope, index, name, reason: checked.reason, skipped: true }); return; }
			const { entry } = checked;
			if (seen.has(entry.name)) problems.push({ scope, index, name, reason: 'named twice in this list — the last one wins', skipped: false });
			seen.add(entry.name);
			const builtin = builtins[entry.name];
			const below = custom[entry.name] ?? (builtin ? { label: builtin.label, color: null, icon: null, aliases: builtin.aliases ?? [] } : null);
			custom[entry.name] = {
				label: entry.title ?? below?.label ?? defaultTitle(entry.name),
				color: entry.color ?? below?.color ?? null,
				icon: entry.icon ? iconTable[entry.icon] : below?.icon ?? null,
				aliases: [...new Set([...(below?.aliases ?? []), ...entry.aliases])],
				scope,
			};
		});
	}
	// An alias may not take a name that is itself a type: it would hijack it.
	// One that another type already has moves to this one — the engine reads
	// the types in this order (built-ins, then new names), later ones last —
	// which is worth saying, since `[!hint]` then opens something else.
	const types = new Set([...Object.keys(builtins), ...Object.keys(custom)]);
	const owner = new Map();
	const order = [...Object.keys(builtins), ...Object.keys(custom).filter((name) => !builtins[name])];
	for (const name of order) {
		const spec = custom[name];
		const aliases = spec ? spec.aliases : builtins[name].aliases ?? [];
		if (spec) {
			spec.aliases = aliases.filter((alias) => {
				if (alias === name) return false;
				if (!types.has(alias)) return true;
				problems.push({ scope: spec.scope, index: -1, name, reason: `the alias “${alias}” is a callout type of its own — ignored`, skipped: false });
				return false;
			});
		}
		for (const alias of spec ? spec.aliases : aliases) {
			const before = owner.get(alias);
			if (spec && before && before !== name) {
				problems.push({ scope: spec.scope, index: -1, name, reason: `the alias “${alias}” was ${before}’s — [!${alias}] now opens ${name}`, skipped: false });
			}
			owner.set(alias, name);
		}
	}
	// A new type named like another's alias takes the name: a type always
	// wins over an alias.
	for (const name of Object.keys(custom)) {
		const before = owner.get(name);
		if (!builtins[name] && before && before !== name) {
			problems.push({ scope: custom[name].scope, index: -1, name, reason: `“${name}” was ${before}’s alias — [!${name}] now opens this type`, skipped: false });
		}
	}
	return { custom, problems };
}
