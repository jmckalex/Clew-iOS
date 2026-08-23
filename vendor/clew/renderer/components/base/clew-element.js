// Base class for Clew's web components (light DOM). Subscriptions are
// declared in subscribe() via this.listen() and are flushed automatically on
// disconnect — safe across the reconnects that tree reconciliation causes.
export class ClewElement extends HTMLElement {
	#subs = [];

	/** Subscribe to a store event for this component's connected lifetime. */
	listen(emitter, event, fn) {
		this.#subs.push(emitter.on(event, fn));
	}

	connectedCallback() {
		this.subscribe?.();
		this.render?.();
	}

	disconnectedCallback() {
		for (const off of this.#subs) off();
		this.#subs = [];
		this.cleanup?.();
	}
}
