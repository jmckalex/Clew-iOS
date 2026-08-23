// Live sync between canvas views of the same file (e.g. two splits): the
// view that mutates broadcasts its serialized doc immediately; sibling views
// adopt it without waiting for the file watcher round trip.
import { Emitter } from '../lib/emitter.js';

/** emits 'doc-changed' { path, text, source } */
export const canvasSyncBus = new Emitter();
