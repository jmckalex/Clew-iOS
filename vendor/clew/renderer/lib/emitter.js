// Minimal event emitter: on() returns an unsubscribe function.
export class Emitter {
	#listeners = new Map();

	on(event, fn) {
		let set = this.#listeners.get(event);
		if (!set) this.#listeners.set(event, (set = new Set()));
		set.add(fn);
		return () => set.delete(fn);
	}

	emit(event, payload) {
		const set = this.#listeners.get(event);
		if (set) for (const fn of [...set]) fn(payload);
		if (event !== 'change') {
			const all = this.#listeners.get('change');
			if (all) for (const fn of [...all]) fn({ event, payload });
		}
	}
}
