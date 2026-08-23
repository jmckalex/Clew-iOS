// The only module that touches window.clew (the preload bridge).
// Everything else goes through these wrappers or the stores.
import { CH } from '../shared/channels.js';

const bridge = window.clew;

export const ipc = {
	invoke: (channel, payload) => bridge.invoke(channel, payload),
	on: (channel, fn) => bridge.on(channel, fn),
};

export { CH };
