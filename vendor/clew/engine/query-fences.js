// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Vault queries for the render worker — Clew's answer to Obsidian's
// Dataview and Tasks plugins, as two fences:
//
//   ```query                      ```tasks
//   table: status, due            not done
//   from: Projects                from: Projects
//   tag: #active                  tag: #work
//   where: status != done         group: note
//   sort: due asc                 limit: 50
//   limit: 20
//   ```
//
// ```query lists (or tabulates) NOTES by folder, tag, and frontmatter
// fields; ```tasks aggregates checkbox items across the vault, and the
// rendered checkboxes write back to their source notes when clicked
// (the preview client routes them by data-task-path/-line).
//
// Plus ```kanban — notes as drag-between-columns cards grouped by a
// frontmatter field; dropping a card REWRITES that note's field.
//
// The data model reads two places: frontmatter and the built-ins (name,
// path, modified). Dataview's inline fields (`Key:: value` on a line,
// `[key:: value]` in a sentence) are deliberately NOT read: `Term:: def`
// is this dialect's description list (vendor/jmarkdown/src/
// description-lists.js), and a line cannot be both a definition and a
// datum — the engine claimed the field's line as a term, sentence and
// all. Owner's decision, 2026-09-17: description lists win, data lives
// in frontmatter. Table cells over frontmatter are EDITABLE in the app —
// the preview client posts a field-edit and the host writes the note.
//
// Everything scans the live vault at render time (this file runs inside
// the one-shot worker, which has fs); open notes holding these fences
// re-render whenever any note changes. Pure helpers exported for tests.
import fs from 'node:fs';
import path from 'node:path';
import { coerceDate } from './dv-expr.js';
import { withinVault } from './vault-bounds.js';

const NOTE_FILE = /\.(md|jmd)$/i;
const IGNORED = new Set(['.obsidian', '.clew', '.git', 'node_modules', '.trash']);

const escapeHtml = (s) => String(s)
	.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// ---- frontmatter (a tiny reader: scalars, inline arrays, tag blocks) -------

/** Flat frontmatter object: strings, numbers, booleans, arrays. */
export function readFrontmatter(text) {
	const fm = /^---\n([\s\S]*?)\n---/.exec(text);
	if (!fm) return {};
	const out = {};
	const lines = fm[1].split('\n');
	for (let i = 0; i < lines.length; i++) {
		const m = /^([\w][\w -]*?):\s*(.*?)\s*$/.exec(lines[i]);
		if (!m) continue;
		const key = m[1];
		let value = m[2];
		if (value === '') {
			// Block list?
			const items = [];
			while (i + 1 < lines.length && /^\s*-\s+/.test(lines[i + 1])) {
				items.push(clean(lines[++i].replace(/^\s*-\s+/, '')));
			}
			out[key] = items.length ? items : '';
			continue;
		}
		const inline = /^\[(.*)\]$/.exec(value);
		if (inline) {
			out[key] = inline[1].split(',').map((v) => clean(v)).filter((v) => v !== '');
			continue;
		}
		out[key] = clean(value);
	}
	return out;
}

function clean(v) {
	const t = String(v).trim();
	// A double-quoted value's escapes, as shared/frontmatter.js writes them —
	// `\n` is a newline (a Meta Bind textArea's value). Repeated here, not
	// imported: engine assets never import src/shared.
	const s = /^".*"$/.test(t)
		? t.slice(1, -1).replace(/\\([nrt"\\])/g, (_, c) => ({ n: '\n', r: '\r', t: '\t' })[c] ?? c)
		: t.replace(/^["']|["']$/g, '');
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if (s === 'true') return true;
	if (s === 'false') return false;
	return s;
}

// ---- date arithmetic (where: due < today + 7d) -----------------------------

const DATE_EXPR_RE = /^today(?:\s*([+-])\s*(\d+)\s*(d|w|m|y))?$/i;

/** 'today', 'today + 7d', 'today - 2w' → ISO date string; null otherwise. */
export function resolveDateExpr(value, now = new Date()) {
	const m = DATE_EXPR_RE.exec(String(value).trim());
	if (!m) return null;
	const date = new Date(now.getFullYear(), now.getMonth(), now.getDate());
	if (m[1]) {
		const n = Number(m[2]) * (m[1] === '-' ? -1 : 1);
		if (m[3] === 'd') date.setDate(date.getDate() + n);
		else if (m[3] === 'w') date.setDate(date.getDate() + n * 7);
		else if (m[3] === 'm') date.setMonth(date.getMonth() + n);
		else date.setFullYear(date.getFullYear() + n);
	}
	const pad = (x) => String(x).padStart(2, '0');
	return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// ---- vault scan ------------------------------------------------------------

function scanNotes() {
	const root = process.env.CLEW_VAULT_ROOT;
	if (!root) return [];
	const notes = [];
	const walk = (dir, rel) => {
		let entries;
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			if (entry.name.startsWith('.') || IGNORED.has(entry.name)) continue;
			const childRel = rel ? `${rel}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(path.join(dir, entry.name), childRel);
			else if (NOTE_FILE.test(entry.name) && withinVault(path.join(dir, entry.name), root)) {
				try {
					const abs = path.join(dir, entry.name);
					const text = fs.readFileSync(abs, 'utf8');
					const fm = readFrontmatter(text);
					// sources drive edits: every field lives in frontmatter
					const sources = {};
					for (const key of Object.keys(fm)) sources[key] = 'fm';
					notes.push({
						path: childRel,
						name: entry.name.replace(NOTE_FILE, ''),
						modified: fs.statSync(abs).mtimeMs,
						text,
						fm: { ...fm },
						sources,
					});
				} catch { /* unreadable — skipped */ }
			}
		}
	};
	walk(root, '');
	return notes;
}

const noteTags = (note) => {
	const tags = note.fm.tags;
	const list = Array.isArray(tags) ? tags : tags != null && tags !== '' ? [tags] : [];
	return list.map((t) => String(t).replace(/^#/, '').toLowerCase());
};

// ---- ```query --------------------------------------------------------------

export function parseQueryConfig(body) {
	const config = { mode: 'list', columns: [], where: [], from: null, tag: null, sort: null, limit: null, group: null };
	for (const line of body.split('\n')) {
		const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		const value = m[2];
		if (key === 'table') {
			config.mode = 'table';
			config.columns = value.split(',').map((c) => c.trim()).filter(Boolean);
		} else if (key === 'list') config.mode = 'list';
		else if (key === 'from') config.from = value.replace(/\/$/, '');
		else if (key === 'tag') config.tag = value.replace(/^#/, '').toLowerCase();
		else if (key === 'where') {
			const w = /^([\w -]+?)\s*(=|!=|>=|<=|>|<|contains)\s*(.*)$/.exec(value);
			if (w) {
				const resolved = resolveDateExpr(w[3]);
				config.where.push({ field: w[1].trim(), op: w[2], value: resolved ?? clean(w[3]) });
			} else config.where.push({ field: value.trim(), op: 'exists' });
		} else if (key === 'group') config.group = value.trim(); else if (key === 'sort') {
			const s = /^([\w -]+?)(?:\s+(asc|desc))?$/.exec(value);
			if (s) config.sort = { field: s[1].trim(), dir: s[2] ?? 'asc' };
		} else if (key === 'limit') config.limit = Number(value) || null;
	}
	return config;
}

// ---- Obsidian's CORE ```query (an embedded search) --------------------------
// Same fence name, different language: core Obsidian's query block holds one
// SEARCH expression (`tag:#project path:"Areas" "deep work"`), rendered as
// the matching notes with their matching lines. The dialects are told apart
// by a single, reliable habit: Clew keys are written `key: value` (a space),
// search operators are `op:value` (none). A line neither dialect owns —
// or a search feature Clew does not run (regex, parentheses, line:/section:/
// task: operators) — refuses the block by name.

const CLEW_QUERY_LINE = /^\s*(table|list|from|tag|where|group|sort|limit)\s*:(\s|$)/i;

const SEARCH_REFUSED = new Map([
	['line', 'line:(…) scoped search'], ['block', 'block:(…) scoped search'],
	['section', 'section:(…) scoped search'], ['task', 'task:(…) search'],
	['task-todo', 'task search'], ['task-done', 'task search'],
	['match-case', 'case-sensitive matching'], ['ignore-case', 'case toggles'],
]);

/** One search expression → { groups: [[term…]…], refused: [] }. Groups are
 *  OR-alternatives; terms within a group all have to hold. */
export function parseSearchQuery(text) {
	const source = text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
	const refused = [];
	const groups = [[]];
	const tokens = source.match(/-?[\w-]+:"[^"]*"|-?"[^"]*"|-?\[[^\]]*\]|-?\/(?:[^/\\]|\\.)*\/|[()]|-?\S+/g) ?? [];
	for (let token of tokens) {
		if (token === 'OR') { groups.push([]); continue; }
		if (token === 'AND') continue;                       // implicit anyway
		if (token === '(' || token === ')') { refused.push('grouping with parentheses'); continue; }
		let neg = false;
		if (token.startsWith('-') && token.length > 1) { neg = true; token = token.slice(1); }
		const group = groups[groups.length - 1];
		const unquote = (s) => s.replace(/^"|"$/g, '');
		if (/^\/.*\/$/.test(token)) { refused.push('regular expressions'); continue; }
		if (token.startsWith('"')) { group.push({ neg, kind: 'phrase', value: unquote(token).toLowerCase() }); continue; }
		const prop = /^\[([^\]:]+)(?::(.*))?\]$/.exec(token);
		if (prop) {
			group.push({ neg, kind: 'prop', key: prop[1].trim().toLowerCase(), value: prop[2]?.trim().toLowerCase() ?? null });
			continue;
		}
		const op = /^([\w-]+):(.*)$/.exec(token);
		if (op) {
			const name = op[1].toLowerCase();
			const value = unquote(op[2]).toLowerCase();
			if (SEARCH_REFUSED.has(name)) { refused.push(SEARCH_REFUSED.get(name)); continue; }
			if (name === 'tag') { group.push({ neg, kind: 'tag', value: value.replace(/^#/, '') }); continue; }
			if (name === 'path') { group.push({ neg, kind: 'path', value }); continue; }
			if (name === 'file') { group.push({ neg, kind: 'file', value }); continue; }
			if (name === 'content') { group.push({ neg, kind: 'text', value }); continue; }
			// An unknown op is what Obsidian would treat as plain text.
		}
		group.push({ neg, kind: 'text', value: token.toLowerCase() });
	}
	return { groups: groups.filter((g) => g.length), refused: [...new Set(refused)] };
}

const searchTags = (note) => new Set([
	...noteTags(note),
	...[...note.text.matchAll(/#([\w][\w/-]*)/g)].map((m) => m[1].toLowerCase()),
]);

function termMatches(term, note) {
	const hit = (() => {
		switch (term.kind) {
			case 'text':
			case 'phrase':
				return note.text.toLowerCase().includes(term.value)
					|| note.name.toLowerCase().includes(term.value);
			case 'tag': {
				for (const tag of searchTags(note)) {
					if (tag === term.value || tag.startsWith(term.value + '/')) return true;
				}
				return false;
			}
			case 'path': return note.path.toLowerCase().includes(term.value);
			case 'file': return note.path.split('/').pop().toLowerCase().includes(term.value);
			case 'prop': {
				const v = note.fm[term.key];
				if (term.value === null) return v !== undefined && v !== '';
				const list = Array.isArray(v) ? v : [v];
				return list.some((x) => String(x ?? '').toLowerCase() === term.value);
			}
			default: return false;
		}
	})();
	return hit !== term.neg;
}

/** Matching notes with up to three matching-line excerpts each. Pure. */
export function runSearchQuery(query, notes) {
	const results = [];
	for (const note of notes) {
		if (!query.groups.some((group) => group.every((t) => termMatches(t, note)))) continue;
		const needles = query.groups.flat()
			.filter((t) => !t.neg && (t.kind === 'text' || t.kind === 'phrase'))
			.map((t) => t.value);
		const excerpts = [];
		if (needles.length) {
			for (const line of note.text.split('\n')) {
				const lower = line.toLowerCase();
				if (needles.some((n) => lower.includes(n))) {
					excerpts.push(line.trim().slice(0, 160));
					if (excerpts.length === 3) break;
				}
			}
		}
		results.push({ note, excerpts });
	}
	return results;
}

const SEARCH_RESULT_CAP = 50;

function renderSearchEmbed(body) {
	const query = parseSearchQuery(body);
	if (query.refused.length) {
		return `<div class="clew-query is-unsupported"><div class="clew-query-title">`
			+ `This search embed uses features Clew does not implement</div>`
			+ query.refused.map((r) => `<div class="clew-query-note">${escapeHtml(r)}</div>`).join('')
			+ `</div>\n`;
	}
	if (!query.groups.length) return `<div class="clew-query is-empty">Empty search.</div>\n`;
	const results = runSearchQuery(query, scanNotes());
	if (!results.length) return `<div class="clew-query is-empty">No results.</div>\n`;
	const parts = ['<div class="clew-query clew-search-embed">'];
	for (const { note, excerpts } of results.slice(0, SEARCH_RESULT_CAP)) {
		parts.push(`<div class="clew-search-hit">${noteLink(note)}`
			+ excerpts.map((x) => `<div class="clew-search-match">${escapeHtml(x)}</div>`).join('')
			+ '</div>');
	}
	if (results.length > SEARCH_RESULT_CAP) {
		parts.push(`<div class="clew-query-note">…and ${results.length - SEARCH_RESULT_CAP} more.</div>`);
	}
	parts.push('</div>');
	return parts.join('\n') + '\n';
}

const fieldOf = (note, field) => {
	if (field === 'name') return note.name;
	if (field === 'path') return note.path;
	if (field === 'modified') return new Date(note.modified).toISOString().slice(0, 10);
	return note.fm[field];
};

/** Filter + sort + limit notes per a parsed query. Pure. */
export function runQuery(config, notes) {
	let rows = notes.filter((note) => {
		if (config.from && !note.path.startsWith(config.from + '/') && path.dirname(note.path) !== config.from) return false;
		if (config.tag && !noteTags(note).includes(config.tag)) return false;
		for (const w of config.where) {
			const v = fieldOf(note, w.field);
			if (w.op === 'exists') { if (v === undefined || v === '') return false; continue; }
			if (v === undefined) return false;
			const a = typeof v === 'number' && typeof w.value === 'number' ? v : String(v).toLowerCase();
			const b = typeof v === 'number' && typeof w.value === 'number' ? w.value : String(w.value).toLowerCase();
			switch (w.op) {
				case '=': if (a !== b) return false; break;
				case '!=': if (a === b) return false; break;
				case '>': if (!(a > b)) return false; break;
				case '<': if (!(a < b)) return false; break;
				case '>=': if (!(a >= b)) return false; break;
				case '<=': if (!(a <= b)) return false; break;
				case 'contains': {
					const haystack = Array.isArray(v) ? v.map((x) => String(x).toLowerCase()) : String(v).toLowerCase();
					if (!haystack.includes(String(w.value).toLowerCase())) return false;
					break;
				}
			}
		}
		return true;
	});
	if (config.sort) {
		const { field, dir } = config.sort;
		const sign = dir === 'desc' ? -1 : 1;
		rows = rows.slice().sort((x, y) => {
			const a = fieldOf(x, field);
			const b = fieldOf(y, field);
			if (a === undefined && b === undefined) return 0;
			if (a === undefined) return 1;
			if (b === undefined) return -1;
			if (typeof a === 'number' && typeof b === 'number') return sign * (a - b);
			return sign * String(a).localeCompare(String(b));
		});
	} else {
		rows = rows.slice().sort((x, y) => x.name.localeCompare(y.name));
	}
	if (config.limit) rows = rows.slice(0, config.limit);
	return rows;
}

const noteLink = (note) =>
	`<a class="internal-link" href="#" data-href="${escapeHtml(note.path.replace(NOTE_FILE, ''))}">${escapeHtml(note.name)}</a>`;

export const queryFence = {
	name: 'queryFence',
	level: 'block',
	start(src) { return src.match(/^```query/m)?.index; },
	tokenizer(src) {
		const match = /^```query[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'queryFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		// Two dialects share this fence: Clew's `key: value` lines, and core
		// Obsidian's search expression. The space after the colon decides.
		const lines = token.text.split('\n').map((l) => l.trim()).filter(Boolean);
		if (lines.length && !lines.every((l) => CLEW_QUERY_LINE.test(l))) {
			return renderSearchEmbed(token.text);
		}
		const config = parseQueryConfig(token.text);
		const rows = runQuery(config, scanNotes());
		if (rows.length === 0) return `<div class="clew-query is-empty">No notes match this query.</div>\n`;
		const render = (subset, label) => {
			const caption = label != null
				? `<div class="clew-query-group">${escapeHtml(label)}</div>` : '';
			if (config.mode === 'table') {
				const head = ['Note', ...config.columns].map((c) => `<th>${escapeHtml(c)}</th>`).join('');
				const body = subset.map((note) => {
					const cells = config.columns.map((c) => {
						const v = fieldOf(note, c);
						const shown = v === undefined ? '' : Array.isArray(v) ? v.join(', ') : String(v);
						// Frontmatter fields are editable in the app;
						// built-ins (name, path, modified) are not.
						const source = note.sources?.[c];
						const editable = source
							? ` class="clew-q-cell" data-edit-path="${escapeHtml(note.path)}"`
								+ ` data-edit-field="${escapeHtml(c)}" data-edit-source="${escapeHtml(source)}"`
							: ['name', 'path', 'modified'].includes(c) ? ''
							: ` class="clew-q-cell" data-edit-path="${escapeHtml(note.path)}"`
								+ ` data-edit-field="${escapeHtml(c)}" data-edit-source="fm"`;
						return `<td${editable}>${escapeHtml(shown)}</td>`;
					}).join('');
					return `<tr><td>${noteLink(note)}</td>${cells}</tr>`;
				}).join('\n');
				return `${caption}<table class="clew-query"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
			}
			return `${caption}<ul class="clew-query">\n${subset.map((note) => `<li>${noteLink(note)}</li>`).join('\n')}\n</ul>`;
		};
		if (config.group) {
			const groups = new Map();
			for (const note of rows) {
				const raw = fieldOf(note, config.group);
				const key = raw === undefined || raw === '' ? '—' : Array.isArray(raw) ? raw.join(', ') : String(raw);
				if (!groups.has(key)) groups.set(key, []);
				groups.get(key).push(note);
			}
			return [...groups.keys()].sort().map((k) => render(groups.get(k), k)).join('\n') + '\n';
		}
		return render(rows, null) + '\n';
	},
};

// ---- ```tasks --------------------------------------------------------------

const TASK_RE = /^(\s*)[-*+] \[( |x|X)\] (.+)$/;

// The Tasks PLUGIN's emoji conventions: metadata rides on the task line
// itself. Dates follow their emoji; priority is a bare emoji; 🔁 opens a
// recurrence rule; 🆔/⛔ are identity plumbing. All are stripped from the
// displayed text — the plugin hides them in reading mode too.
const EMOJI_DATES = [['📅', 'due'], ['⏳', 'scheduled'], ['🛫', 'start'], ['✅', 'doneDate'], ['➕', 'created']];
const PRIORITY_EMOJI = [['🔺', 'highest'], ['⏫', 'high'], ['🔼', 'medium'], ['🔽', 'low'], ['⏬', 'lowest']];
// Tasks' own ordering puts an unmarked task between low and medium.
export const PRIORITY_ORDER = { highest: 5, high: 4, medium: 3, none: 2, low: 1, lowest: 0 };

/** The plugin metadata on one task line: parsed fields + the cleaned text. */
export function taskMeta(text) {
	let clean = String(text);
	const meta = { priority: 'none' };
	for (const [emoji, key] of EMOJI_DATES) {
		const m = new RegExp(`${emoji}\\uFE0F?\\s*(\\d{4}-\\d{2}-\\d{2})`).exec(clean);
		if (m) { meta[key] = m[1]; clean = clean.replace(m[0], ''); }
	}
	const rec = /🔁️?\s*([^📅⏳🛫✅➕🔺⏫🔼🔽⏬🆔⛔#]*)/.exec(clean);
	if (rec) { meta.recurring = rec[1].trim() || 'recurring'; clean = clean.replace(rec[0], ''); }
	for (const [emoji, name] of PRIORITY_EMOJI) {
		if (clean.includes(emoji)) { meta.priority = name; clean = clean.replace(emoji, ''); }
	}
	clean = clean.replace(/🆔️?\s*\S+/g, '').replace(/⛔️?\s*\S+/g, '');
	return { meta, clean: clean.replace(/\s{2,}/g, ' ').trim() };
}

/**
 * Checkbox items in a note's text (1-based lines; fenced code masked), each
 * carrying its nearest heading, its #tags, and the Tasks plugin's emoji
 * metadata — Clew's own fence ignores those fields, the plugin dialect
 * filters on them.
 */
export function extractTasks(text) {
	const tasks = [];
	let inFence = false;
	let heading = null;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
		if (inFence) continue;
		const h = /^#{1,6}\s+(.+?)\s*$/.exec(lines[i]);
		if (h) { heading = h[1]; continue; }
		const m = TASK_RE.exec(lines[i]);
		if (!m) continue;
		const raw = m[3].trim();
		const { meta, clean } = taskMeta(raw);
		tasks.push({
			line: i + 1, done: m[2] !== ' ', text: raw,
			clean, heading, meta,
			tags: [...raw.matchAll(/#[\w][\w/-]*/g)].map((t) => t[0]),
		});
	}
	return tasks;
}

export function parseTasksConfig(body) {
	const config = { status: 'todo', from: null, tag: null, group: 'note', limit: null };
	for (const line of body.split('\n')) {
		const bare = line.trim().toLowerCase();
		if (bare === 'not done' || bare === 'todo') config.status = 'todo';
		else if (bare === 'done') config.status = 'done';
		else if (bare === 'all') config.status = 'all';
		const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		if (key === 'from') config.from = m[2].replace(/\/$/, '');
		else if (key === 'tag') config.tag = m[2].replace(/^#/, '').toLowerCase();
		else if (key === 'group') config.group = m[2].toLowerCase() === 'none' ? 'none' : 'note';
		else if (key === 'limit') config.limit = Number(m[2]) || null;
	}
	return config;
}

// ---- the Tasks PLUGIN's dialect ---------------------------------------------
// Obsidian's Tasks plugin uses the SAME ```tasks fence with a different query
// language: instruction lines like `not done`, `path includes Inbox`,
// `due before today`, `sort by priority`. Both dialects are served by one
// fence: a block whose every line is Clew syntax keeps Clew's rendering
// byte-for-byte; a block using a plugin instruction runs the plugin dialect.
// Either way, a line NEITHER dialect knows refuses the block by name —
// silently dropping a filter would show too many tasks, which is worse than
// showing none. `… by function` lines are JavaScript and are refused as such.

const CLEW_TASK_LINE = /^(?:(?:from|tag|group|limit)\s*:.*|not done|todo|done|all)$/i;

const DATE_FIELDS = { due: 'due', scheduled: 'scheduled', start: 'start', starts: 'start', done: 'doneDate', created: 'created' };
const HIDABLE = new Set(['backlink', 'edit button', 'due date', 'scheduled date',
	'start date', 'done date', 'created date', 'recurrence rule', 'priority', 'tags', 'task count', 'postpone button', 'urgency']);

const taskDate = (task, field) => {
	const raw = task.meta[field];
	const date = raw === undefined ? null : coerceDate(raw);
	return date ? date.getTime() : null;
};

/** One instruction line → a mutation of the query, or a named refusal. */
function obsidianTaskLine(query, line) {
	const lower = line.toLowerCase();
	const refuse = (why) => query.refused.push(why ? `“${line}” — ${why}` : `“${line}”`);
	let m;
	if (/\bby function\b/.test(lower)) return refuse('JavaScript is not run in a query');
	if (/\)\s+(and|or)\s+\(/i.test(line)) return refuse('boolean combinations');
	if (lower === 'done') return query.filters.push((t) => t.done);
	if (lower === 'not done') return query.filters.push((t) => !t.done);
	if (lower === 'short mode' || lower === 'short') {
		for (const f of HIDABLE) if (f !== 'task count') query.hide.add(f);
		return;
	}
	if ((m = /^(path|heading|description|filename) (includes|does not include) (.+)$/i.exec(line))) {
		const needle = m[3].toLowerCase();
		const negated = /not/i.test(m[2]);
		const get = {
			path: (t) => t.notePath,
			filename: (t) => t.notePath.split('/').pop(),
			heading: (t) => t.heading ?? '',
			description: (t) => t.clean,
		}[m[1].toLowerCase()];
		return query.filters.push((t) => get(t).toLowerCase().includes(needle) !== negated);
	}
	if ((m = /^tags? (includes?|do(?:es)? not include) (.+)$/i.exec(line))) {
		const needle = m[2].toLowerCase().replace(/^#/, '');
		const negated = /not/i.test(m[1]);
		return query.filters.push((t) =>
			t.tags.some((tag) => tag.slice(1).toLowerCase().includes(needle)) !== negated);
	}
	if ((m = /^(has|no) (due|scheduled|start|done|created) date$/i.exec(line))) {
		const field = DATE_FIELDS[m[2].toLowerCase()];
		const wanted = m[1].toLowerCase() === 'has';
		return query.filters.push((t) => (t.meta[field] !== undefined) === wanted);
	}
	if ((m = /^(due|scheduled|starts?|done|created) (before|after|on)\s+(.+)$/i.exec(line))) {
		const field = DATE_FIELDS[m[1].toLowerCase()];
		const edge = coerceDate(m[3].trim());
		if (!edge) return refuse('a date Clew cannot read');
		const day = 864e5;
		const from = new Date(edge.getFullYear(), edge.getMonth(), edge.getDate()).getTime();
		const op = m[2].toLowerCase();
		return query.filters.push((t) => {
			const time = taskDate(t, field);
			if (time === null) return false;
			if (op === 'before') return time < from;
			if (op === 'after') return time >= from + day;
			return time >= from && time < from + day;
		});
	}
	if ((m = /^(due|scheduled|starts?) (today|tomorrow|yesterday)$/i.exec(line))) {
		return obsidianTaskLine(query, `${m[1]} on ${m[2]}`);
	}
	if ((m = /^priority is (above |below )?(highest|high|medium|none|low|lowest)$/i.exec(line))) {
		const pivot = PRIORITY_ORDER[m[2].toLowerCase()];
		const mode = (m[1] ?? '').trim().toLowerCase();
		return query.filters.push((t) => {
			const level = PRIORITY_ORDER[t.meta.priority];
			return mode === 'above' ? level > pivot : mode === 'below' ? level < pivot : level === pivot;
		});
	}
	if (lower === 'is recurring') return query.filters.push((t) => t.meta.recurring !== undefined);
	if (lower === 'is not recurring') return query.filters.push((t) => t.meta.recurring === undefined);
	if ((m = /^sort by (\w+)( reverse)?$/i.exec(line))) {
		const key = m[1].toLowerCase();
		const keyOf = {
			due: (t) => taskDate(t, 'due'), scheduled: (t) => taskDate(t, 'scheduled'),
			start: (t) => taskDate(t, 'start'), done: (t) => taskDate(t, 'doneDate'),
			created: (t) => taskDate(t, 'created'),
			priority: (t) => -PRIORITY_ORDER[t.meta.priority],
			description: (t) => t.clean.toLowerCase(),
			path: (t) => t.notePath.toLowerCase(),
			status: (t) => (t.done ? 1 : 0),
		}[key];
		if (!keyOf) return refuse('a sort key Clew does not know');
		return query.sorts.push({ keyOf, reverse: Boolean(m[2]) });
	}
	if ((m = /^group by (\w+)$/i.exec(line))) {
		const key = m[1].toLowerCase();
		const groupOf = {
			heading: (t) => t.heading ?? '(no heading)',
			folder: (t) => (t.notePath.includes('/') ? t.notePath.slice(0, t.notePath.lastIndexOf('/') + 1) : '/'),
			filename: (t) => t.notePath.split('/').pop().replace(NOTE_FILE, ''),
			path: (t) => t.notePath.replace(NOTE_FILE, ''),
			status: (t) => (t.done ? 'Done' : 'Todo'),
			priority: (t) => t.meta.priority,
			due: (t) => t.meta.due ?? '(no due date)',
		}[key];
		if (!groupOf) return refuse('a grouping Clew does not know');
		query.group = groupOf;
		return;
	}
	if ((m = /^limit( to)? (\d+)( tasks?)?$/i.exec(line))) { query.limit = Number(m[2]); return; }
	if ((m = /^(hide|show) (.+)$/i.exec(line))) {
		const what = m[2].toLowerCase();
		if (!HIDABLE.has(what)) return refuse('a layout option Clew does not know');
		if (m[1].toLowerCase() === 'hide') query.hide.add(what); else query.hide.delete(what);
		return;
	}
	return refuse(null);
}

export function parseObsidianTasksQuery(body) {
	const query = { filters: [], sorts: [], group: null, limit: null, hide: new Set(), refused: [] };
	for (const raw of body.split('\n')) {
		const line = raw.trim();
		if (!line) continue;
		obsidianTaskLine(query, line);
	}
	return query;
}

const DATE_BADGES = [['due', '📅'], ['scheduled', '⏳'], ['start', '🛫'], ['doneDate', '✅']];
const BADGE_HIDES = { due: 'due date', scheduled: 'scheduled date', start: 'start date', doneDate: 'done date' };

function renderObsidianTasks(body) {
	const query = parseObsidianTasksQuery(body);
	if (query.refused.length) {
		return `<div class="clew-query is-unsupported"><div class="clew-query-title">`
			+ `This tasks query uses instructions Clew does not implement</div>`
			+ query.refused.map((r) => `<div class="clew-query-note">${escapeHtml(r)}</div>`).join('')
			+ `</div>\n`;
	}
	let tasks = [];
	for (const note of scanNotes()) {
		for (const task of extractTasks(note.text)) {
			tasks.push({ ...task, notePath: note.path, noteName: note.name });
		}
	}
	tasks = tasks.filter((t) => query.filters.every((fn) => fn(t)));
	for (const sort of [...query.sorts].reverse()) {
		tasks = tasks.map((t, i) => ({ t, i })).sort((a, b) => {
			const x = sort.keyOf(a.t);
			const y = sort.keyOf(b.t);
			if (x === y) return a.i - b.i;
			if (x === null) return 1;
			if (y === null) return -1;
			const order = x < y ? -1 : 1;
			return sort.reverse ? -order : order;
		}).map((e) => e.t);
	}
	if (query.limit) tasks = tasks.slice(0, query.limit);
	if (!tasks.length) return `<div class="clew-tasks is-empty">No matching tasks.</div>\n`;

	const item = (t) => {
		const badges = DATE_BADGES
			.filter(([field]) => t.meta[field] !== undefined && !query.hide.has(BADGE_HIDES[field]))
			.map(([field, emoji]) => `<span class="clew-task-badge">${emoji} ${escapeHtml(t.meta[field])}</span>`);
		if (t.meta.recurring !== undefined && !query.hide.has('recurrence rule')) {
			badges.push(`<span class="clew-task-badge">🔁 ${escapeHtml(t.meta.recurring)}</span>`);
		}
		if (t.meta.priority !== 'none' && !query.hide.has('priority')) {
			badges.push(`<span class="clew-task-badge">${escapeHtml(t.meta.priority)}</span>`);
		}
		const backlink = query.hide.has('backlink') ? ''
			: ` <a class="internal-link clew-task-backlink" href="#" data-href="${escapeHtml(t.notePath.replace(NOTE_FILE, ''))}">${escapeHtml(t.noteName)}</a>`;
		return `<li data-task-path="${escapeHtml(t.notePath)}" data-task-line="${t.line}">`
			+ `<input type="checkbox" disabled${t.done ? ' checked' : ''}> ${escapeHtml(t.clean)}`
			+ (badges.length ? ' ' + badges.join(' ') : '') + backlink + `</li>`;
	};

	const parts = ['<div class="clew-tasks clew-tasks-plugin">'];
	if (query.group) {
		const groups = new Map();
		for (const t of tasks) {
			const key = String(query.group(t));
			if (!groups.has(key)) groups.set(key, []);
			groups.get(key).push(t);
		}
		for (const key of [...groups.keys()].sort()) {
			parts.push(`<div class="clew-query-group">${escapeHtml(key)}</div>`);
			parts.push(`<ul class="clew-tasks-list">\n${groups.get(key).map(item).join('\n')}\n</ul>`);
		}
	} else {
		parts.push(`<ul class="clew-tasks-list">\n${tasks.map(item).join('\n')}\n</ul>`);
	}
	if (!query.hide.has('task count')) {
		parts.push(`<div class="clew-tasks-count">${tasks.length} task${tasks.length === 1 ? '' : 's'}</div>`);
	}
	parts.push('</div>');
	return parts.join('\n') + '\n';
}

export const tasksFence = {
	name: 'tasksFence',
	level: 'block',
	start(src) { return src.match(/^```tasks/m)?.index; },
	tokenizer(src) {
		const match = /^```tasks[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'tasksFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		// Every nonblank line Clew-shaped → Clew's dialect, byte-for-byte as
		// before; anything else → the Tasks plugin's dialect (which refuses
		// unknown instructions by name rather than half-running).
		const lines = token.text.split('\n').map((l) => l.trim()).filter(Boolean);
		if (!lines.every((l) => CLEW_TASK_LINE.test(l))) return renderObsidianTasks(token.text);
		const config = parseTasksConfig(token.text);
		const groups = [];
		let total = 0;
		for (const note of runQuery({ from: config.from, tag: config.tag, where: [], sort: null, limit: null }, scanNotes())) {
			const tasks = extractTasks(note.text).filter((t) =>
				config.status === 'all' || (config.status === 'done') === t.done);
			if (tasks.length === 0) continue;
			groups.push({ note, tasks });
			total += tasks.length;
		}
		if (total === 0) return `<div class="clew-tasks is-empty">No matching tasks.</div>\n`;
		let remaining = config.limit ?? Infinity;
		const parts = ['<div class="clew-tasks">'];
		for (const { note, tasks } of groups) {
			if (remaining <= 0) break;
			const shown = tasks.slice(0, remaining);
			remaining -= shown.length;
			if (config.group !== 'none') parts.push(`<div class="clew-tasks-note">${noteLink(note)}</div>`);
			parts.push('<ul class="clew-tasks-list">');
			for (const task of shown) {
				// data-task-path/-line route the click back to the SOURCE note
				// (the preview client posts task-toggle with these).
				parts.push(`<li data-task-path="${escapeHtml(note.path)}" data-task-line="${task.line}">`
					+ `<input type="checkbox" disabled${task.done ? ' checked' : ''}> ${escapeHtml(task.text)}</li>`);
			}
			parts.push('</ul>');
		}
		parts.push('</div>');
		return parts.join('\n') + '\n';
	},
};

// ---- ```kanban -------------------------------------------------------------

export function parseKanbanConfig(body) {
	const config = { group: 'status', from: null, tag: null, columns: null, show: [] };
	for (const line of body.split('\n')) {
		const m = /^\s*(\w+)\s*:\s*(.*?)\s*$/.exec(line);
		if (!m) continue;
		const key = m[1].toLowerCase();
		if (key === 'group') config.group = m[2].trim();
		else if (key === 'from') config.from = m[2].replace(/\/$/, '');
		else if (key === 'tag') config.tag = m[2].replace(/^#/, '').toLowerCase();
		else if (key === 'columns') config.columns = m[2].split(',').map((c) => c.trim()).filter(Boolean);
		else if (key === 'show') config.show = m[2].split(',').map((c) => c.trim()).filter(Boolean);
	}
	return config;
}

export const kanbanFence = {
	name: 'kanbanFence',
	level: 'block',
	start(src) { return src.match(/^```kanban/m)?.index; },
	tokenizer(src) {
		const match = /^```kanban[ \t]*\n([\s\S]*?)\n```[ \t]*(?:\n+|$)/.exec(src);
		if (!match) return;
		return { type: 'kanbanFence', raw: match[0], text: match[1] };
	},
	renderer(token) {
		if (global.isLatex) return '';
		const config = parseKanbanConfig(token.text);
		const notes = runQuery({ from: config.from, tag: config.tag, where: [], sort: null, limit: null }, scanNotes());
		const byColumn = new Map();
		for (const col of config.columns ?? []) byColumn.set(col, []);
		for (const note of notes) {
			const raw = note.fm[config.group];
			const value = raw === undefined || raw === '' ? '—' : String(raw);
			if (config.columns && !byColumn.has(value)) continue; // explicit board: off-board notes hidden
			if (!byColumn.has(value)) byColumn.set(value, []);
			byColumn.get(value).push(note);
		}
		const columns = config.columns ?? [...byColumn.keys()].sort();
		const parts = [`<div class="clew-kanban" data-kanban-field="${escapeHtml(config.group)}">`];
		for (const col of columns) {
			const cards = byColumn.get(col) ?? [];
			parts.push(`<div class="kanban-col" data-kanban-value="${escapeHtml(col)}">`);
			parts.push(`<div class="kanban-col-title">${escapeHtml(col)} <span class="kanban-count">${cards.length}</span></div>`);
			for (const note of cards) {
				const meta = config.show
					.map((f) => { const v = fieldOf(note, f); return v === undefined ? null : `${f}: ${Array.isArray(v) ? v.join(', ') : v}`; })
					.filter(Boolean).join(' · ');
				parts.push(`<div class="kanban-card" draggable="true"`
					+ ` data-kanban-path="${escapeHtml(note.path)}"`
					+ ` data-href="${escapeHtml(note.path.replace(NOTE_FILE, ''))}">`
					+ `<div class="kanban-card-title">${escapeHtml(note.name)}</div>`
					+ (meta ? `<div class="kanban-card-meta">${escapeHtml(meta)}</div>` : '')
					+ `</div>`);
			}
			parts.push('</div>');
		}
		parts.push('</div>');
		return parts.join('\n') + '\n';
	},
};

// ---- the `vault` global for jmarkdown script blocks ------------------------
// The programmable tier (Dataview's dataviewjs equivalent): script blocks in
// notes run in this worker, so they can query the vault directly:
//
//   const active = vault.query({ from: 'Projects', where: 'status = active' });
//
// where strings use the same syntax as the fence; query() also takes
// pre-parsed {from, tag, where: [...], sort, limit} objects.
globalThis.vault = {
	notes: () => scanNotes(),
	query: (spec = {}) => {
		const config = typeof spec === 'string' ? parseQueryConfig(spec) : {
			mode: 'list', columns: [], group: null,
			from: spec.from ?? null,
			tag: spec.tag?.replace(/^#/, '').toLowerCase() ?? null,
			sort: spec.sort ?? null,
			limit: spec.limit ?? null,
			where: (Array.isArray(spec.where) ? spec.where : spec.where ? [spec.where] : [])
				.map((w) => typeof w === 'string' ? parseQueryConfig('where: ' + w).where[0] : w)
				.filter(Boolean),
		};
		return runQuery(config, scanNotes());
	},
	tasks: (spec = '') => {
		const config = parseTasksConfig(typeof spec === 'string' ? spec : '');
		const out = [];
		for (const note of runQuery({ from: config.from, tag: config.tag, where: [], sort: null, limit: null }, scanNotes())) {
			for (const task of extractTasks(note.text)) {
				if (config.status !== 'all' && (config.status === 'done') !== task.done) continue;
				out.push({ ...task, path: note.path, note: note.name });
			}
		}
		return out;
	},
};

export default [queryFence, tasksFence, kanbanFence];
