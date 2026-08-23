// The diary calendar panel (left sidebar): a month grid with entry dots —
// click any day to open or create it (a per-day note, or a section of the
// single log, per the diary mode setting) — plus view controls for
// composed day/interval/whole-diary views.
import { ClewElement } from '../base/clew-element.js';
import { vaultStore } from '../../state/vault-store.js';
import { settingsStore } from '../../state/settings-store.js';
import { debounce } from '../../lib/debounce.js';
import { icon } from '../../lib/icons.js';
import {
	openDiaryDay, openDiaryRange, openDiaryAll, diaryDaysWithEntries, dayKey,
} from '../../commands/diary.js';

const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
	'August', 'September', 'October', 'November', 'December'];

export class ClewDiary extends ClewElement {
	#year = new Date().getFullYear();
	#month = new Date().getMonth();
	#entries = new Set();
	#refresh = debounce(() => this.#loadEntries(), 200);

	subscribe() {
		this.listen(vaultStore, 'tree-changed', () => this.#refresh());
		this.listen(vaultStore, 'index-changed', () => this.#refresh());
		this.listen(settingsStore, 'settings-changed', () => this.#refresh());
	}

	render() {
		this.classList.add('panel-scroll', 'diary-panel');
		this.#build();
		this.#loadEntries();
	}

	async #loadEntries() {
		const year = this.#year;
		const month = this.#month;
		const entries = await diaryDaysWithEntries(year, month).catch(() => new Set());
		if (year !== this.#year || month !== this.#month || !this.isConnected) return;
		this.#entries = entries;
		this.#paintDots();
	}

	#shift(delta) {
		const date = new Date(this.#year, this.#month + delta, 1);
		this.#year = date.getFullYear();
		this.#month = date.getMonth();
		this.#build();
		this.#loadEntries();
	}

	#build() {
		const frag = document.createDocumentFragment();

		// Header: ‹ Month Year › · today
		const header = document.createElement('div');
		header.className = 'diary-header';
		const prev = navButton('chevron-left', 'Previous month', () => this.#shift(-1));
		const next = navButton('chevron-right', 'Next month', () => this.#shift(1));
		const label = document.createElement('button');
		label.className = 'diary-month';
		label.textContent = `${MONTHS[this.#month]} ${this.#year}`;
		label.title = 'Jump to the current month';
		label.addEventListener('click', () => {
			const now = new Date();
			this.#year = now.getFullYear();
			this.#month = now.getMonth();
			this.#build();
			this.#loadEntries();
		});
		header.append(prev, label, next);
		frag.append(header);

		// Weekday row + day grid (Monday first).
		const grid = document.createElement('div');
		grid.className = 'diary-grid';
		for (const day of WEEKDAYS) {
			const el = document.createElement('div');
			el.className = 'diary-weekday';
			el.textContent = day;
			grid.append(el);
		}
		const first = new Date(this.#year, this.#month, 1);
		const offset = (first.getDay() + 6) % 7;
		const todayKey = dayKey(new Date());
		for (let cell = 0; cell < 42; cell++) {
			const date = new Date(this.#year, this.#month, 1 - offset + cell);
			const key = dayKey(date);
			const el = document.createElement('button');
			el.className = 'diary-day';
			el.dataset.key = key;
			el.textContent = date.getDate();
			el.classList.toggle('is-other-month', date.getMonth() !== this.#month);
			el.classList.toggle('is-today', key === todayKey);
			el.title = key;
			el.addEventListener('click', () => openDiaryDay(date));
			grid.append(el);
		}
		frag.append(grid);

		// Composed views: quick ranges + a custom interval.
		const views = document.createElement('div');
		views.className = 'diary-views';
		views.append(
			sectionLabel('View'),
			viewButton('Today', () => {
				const key = dayKey(new Date());
				openDiaryRange(key, key);
			}),
			viewButton('This week', () => {
				const now = new Date();
				const monday = new Date(now);
				monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
				openDiaryRange(dayKey(monday), dayKey(now), 'this week');
			}),
			viewButton('This month', () => {
				const start = new Date(this.#year, this.#month, 1);
				const end = new Date(this.#year, this.#month + 1, 0);
				openDiaryRange(dayKey(start), dayKey(end), `${MONTHS[this.#month]} ${this.#year}`);
			}),
			viewButton('Everything', () => openDiaryAll()),
		);

		const range = document.createElement('div');
		range.className = 'diary-range';
		const from = dateInput(dayKey(new Date(this.#year, this.#month, 1)));
		const to = dateInput(dayKey(new Date()));
		const go = document.createElement('button');
		go.className = 'diary-view-button';
		go.textContent = 'Open interval';
		go.addEventListener('click', () => {
			if (!from.value || !to.value) return;
			const [a, b] = [from.value, to.value].sort();
			openDiaryRange(a, b);
		});
		range.append(from, to, go);
		views.append(range);
		frag.append(views);

		this.replaceChildren(frag);
		this.#paintDots();
	}

	#paintDots() {
		for (const el of this.querySelectorAll('.diary-day')) {
			el.classList.toggle('has-entry', this.#entries.has(el.dataset.key));
		}
	}
}

function navButton(name, title, onClick) {
	const button = document.createElement('button');
	button.className = 'icon-button';
	button.title = title;
	button.append(icon(name));
	button.addEventListener('click', onClick);
	return button;
}

function viewButton(label, onClick) {
	const button = document.createElement('button');
	button.className = 'diary-view-button';
	button.textContent = label;
	button.addEventListener('click', onClick);
	return button;
}

function dateInput(value) {
	const input = document.createElement('input');
	input.type = 'date';
	input.className = 'diary-date-input';
	input.value = value;
	return input;
}

function sectionLabel(text) {
	const el = document.createElement('div');
	el.className = 'diary-section-label';
	el.textContent = text;
	return el;
}

customElements.define('clew-diary', ClewDiary);
