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
// The data model reads three places: frontmatter, Dataview-style inline
// fields (Key:: value on its own line, or [key:: value] in a sentence),
// and built-ins (name, path, modified). Table cells over frontmatter or
// inline fields are EDITABLE in the app — the preview client posts a
// field-edit and the host writes the source note.
//
// Everything scans the live vault at render time (this file runs inside
// the one-shot worker, which has fs); open notes holding these fences
// re-render whenever any note changes. Pure helpers exported for tests.
import fs from 'node:fs';
import path from 'node:path';

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
	const s = String(v).trim().replace(/^["']|["']$/g, '');
	if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s);
	if (s === 'true') return true;
	if (s === 'false') return false;
	return s;
}

// ---- inline fields (Key:: value — Dataview's idiom) ------------------------

const INLINE_LINE_RE = /^([A-Za-z][\w -]{0,40}?)::\s+(.+?)\s*$/;
const INLINE_BRACKET_RE = /\[([A-Za-z][\w -]{0,40}?)::\s+([^\]\n]+)\]/g;

/** Inline fields with their 1-based source lines (for write-back):
 *  { fields: {key: value}, lines: {key: line} }. Fenced code is masked. */
export function readInlineFields(text) {
	const fields = {};
	const lines = {};
	let inFence = false;
	const rows = text.split('\n');
	for (let i = 0; i < rows.length; i++) {
		if (/^\s*(```|~~~)/.test(rows[i])) { inFence = !inFence; continue; }
		if (inFence) continue;
		const own = INLINE_LINE_RE.exec(rows[i]);
		if (own) {
			if (!(own[1] in fields)) { fields[own[1]] = clean(own[2]); lines[own[1]] = i + 1; }
			continue;
		}
		for (const m of rows[i].matchAll(INLINE_BRACKET_RE)) {
			if (!(m[1] in fields)) { fields[m[1]] = clean(m[2]); lines[m[1]] = i + 1; }
		}
	}
	return { fields, lines };
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
			else if (NOTE_FILE.test(entry.name)) {
				try {
					const abs = path.join(dir, entry.name);
					const text = fs.readFileSync(abs, 'utf8');
					const fm = readFrontmatter(text);
					const inline = readInlineFields(text);
					// Frontmatter wins on key collisions; sources drive edits.
					const sources = {};
					for (const key of Object.keys(inline.fields)) sources[key] = `line:${inline.lines[key]}`;
					for (const key of Object.keys(fm)) sources[key] = 'fm';
					notes.push({
						path: childRel,
						name: entry.name.replace(NOTE_FILE, ''),
						modified: fs.statSync(abs).mtimeMs,
						text,
						fm: { ...inline.fields, ...fm },
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
						// Frontmatter / inline fields are editable in the app;
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

/** Checkbox items in a note's text (1-based lines; fenced code masked). */
export function extractTasks(text) {
	const tasks = [];
	let inFence = false;
	const lines = text.split('\n');
	for (let i = 0; i < lines.length; i++) {
		if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue; }
		if (inFence) continue;
		const m = TASK_RE.exec(lines[i]);
		if (m) tasks.push({ line: i + 1, done: m[2] !== ' ', text: m[3].trim() });
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
