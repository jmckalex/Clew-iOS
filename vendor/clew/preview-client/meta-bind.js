// Clew — an Obsidian-style note app built on the jmarkdown engine.
// Copyright © 2026 J. McKenzie Alexander <jmckalex@gmail.com> · https://jmckalex.org
//
// This file is part of Clew, free software released under the GNU General
// Public License, version 3 or later. Clew is distributed in the hope that it
// will be useful, but WITHOUT ANY WARRANTY. See LICENSE at the repository
// root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: GPL-3.0-or-later

// Meta Bind widgets, client side. The engine renders Web Awesome elements
// carrying the same data-edit-* contract the editable query cells use, so a
// change becomes the same field-edit message and the same write path. The
// file change then re-renders the note, which is what brings every OTHER
// view of that property (tables, kanban, the properties panel) into line —
// a widget never updates anything but the file.
//
// The component library itself (wa.js + wa.css, ~200 KB) loads LAZILY, only
// when a rendered document actually contains a widget: a note without them
// never pays. Until the definitions arrive, custom elements are inert but
// present; they upgrade in place when the script lands.
import { parentOrigin, postTo } from '../shared/message-guard.js';
const post = (msg) => postTo(window.parent, { source: 'clew-preview', ...msg }, parentOrigin());

const WA_TAGS = 'wa-switch, wa-slider, wa-select, wa-input, wa-number-input, '
	+ 'wa-time-input, wa-textarea, wa-rating, wa-color-picker, wa-progress-bar, '
	+ 'wa-relative-time, wa-format-date, wa-format-number, wa-format-bytes, wa-badge, wa-qr-code';

let waLoaded = false;
function ensureWebAwesome() {
	if (waLoaded || !document.querySelector(WA_TAGS)) return;
	waLoaded = true;
	const link = document.createElement('link');
	link.rel = 'stylesheet';
	link.href = '/__clew_preview__/wa.css';
	const script = document.createElement('script');
	script.src = '/__clew_preview__/wa.js';
	document.head.append(link, script);
}

// `INPUT[…(locked)…]` (engine/meta-bind.js): the widget arrives `inert`
// beside a padlock — no click, focus or keystroke reaches it, shadow DOM
// included. The padlock unlocks it for ONE edit; it locks again on commit
// (Enter in a text or number field, leaving it, or the widget's own
// `change`), when focus
// leaves the group, and on every re-render, since the engine emits it
// locked and a morph syncs attributes. No state is kept anywhere, so nothing
// can be left unlocked by accident. `inert` rather than `disabled` because
// it leaves the component's own state alone.
const lockGroup = (el) => el?.closest?.('.clew-mb-lockable') ?? null;

function setLocked(group, locked) {
	const widget = group.querySelector('.clew-mb');
	const button = group.querySelector('.clew-mb-lock');
	if (!widget || !button) return;
	widget.inert = locked;
	button.setAttribute('aria-pressed', String(locked));
	const name = widget.dataset.editField ?? '';
	button.setAttribute('aria-label', `${locked ? 'Unlock' : 'Lock'} ${name}`);
	button.title = locked ? 'Locked — click to edit' : 'Editing — click to lock';
}

function installLocks() {
	document.addEventListener('click', (event) => {
		const button = event.target.closest?.('.clew-mb-lock');
		const group = lockGroup(button);
		if (!group) return;
		const unlocking = button.getAttribute('aria-pressed') === 'true';
		setLocked(group, !unlocking);
		// Straight into the widget, so the edit is one click and a keystroke.
		if (unlocking) requestAnimationFrame(() => group.querySelector('.clew-mb')?.focus?.());
	});
	// Focus leaving the group (the widget AND its padlock) locks it again.
	document.addEventListener('focusout', (event) => {
		const group = lockGroup(event.target);
		if (!group || group.querySelector('.clew-mb-lock')?.getAttribute('aria-pressed') === 'true') return;
		if (event.relatedTarget && group.contains(event.relatedTarget)) return;
		setTimeout(() => {
			if (!group.contains(document.activeElement)) setLocked(group, true);
		}, 0);
	});
}

const widgetValue = (el) => ((el.tagName === 'WA-SWITCH' || el.type === 'checkbox')
	? String(el.checked) : String(el.value ?? ''));

/** A widget's value, written: the field-edit every commit path posts. */
function commit(el) {
	post({
		type: 'field-edit',
		path: el.dataset.editPath,
		field: el.dataset.editField,
		fieldSource: el.dataset.editSource,
		value: widgetValue(el),
	});
	// Committed: a lockable widget locks again at once, not only when the
	// write's re-render arrives.
	const group = lockGroup(el);
	if (group) setLocked(group, true);
}

export function initMetaBind() {
	ensureWebAwesome();
	installLocks();
	document.addEventListener('clew:render', ensureWebAwesome);

	document.addEventListener('change', (event) => {
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		// Enter already committed exactly this; leaving the field afterwards
		// (or the relock that follows) must not write it a second time.
		if (el.__clewEnterCommitted !== undefined && el.__clewEnterCommitted === widgetValue(el)) {
			delete el.__clewEnterCommitted;
			return;
		}
		commit(el);
	});
	// ENTER commits a text or number field, as leaving it does (the owner's
	// decision, 2026-09-30 — Web Awesome's inputs commit on leaving alone).
	// A textArea keeps Enter for its new lines; the other widgets commit on
	// their own gesture. Nothing reaches the host: a bare Enter is not among
	// the keys this document forwards (client.js), so an engaged canvas card
	// or live edit around it never sees one.
	document.addEventListener('keydown', (event) => {
		if (event.key !== 'Enter' || event.isComposing || event.shiftKey || event.altKey || event.metaKey || event.ctrlKey) return;
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		if (el.tagName !== 'WA-INPUT' && el.tagName !== 'WA-NUMBER-INPUT') return;
		event.preventDefault();
		el.__clewEnterCommitted = widgetValue(el);
		commit(el);
	});
	// Sliders show their number live while dragging; the write waits for
	// 'change' (release), so a drag is one edit, not forty.
	document.addEventListener('input', (event) => {
		const el = event.target;
		if (!el.classList?.contains('clew-mb')) return;
		delete el.__clewEnterCommitted;   // typed again since Enter: a new value
		if (el.tagName !== 'WA-SLIDER' && el.type !== 'range') return;
		const bubble = el.parentElement?.querySelector('.clew-mb-value');
		if (bubble) bubble.textContent = el.value;
	});
}
