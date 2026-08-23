// Build-time stubs for engine modules that are dead in the worker bundle:
// commander (only under the CLI-entry guard) and watch.js (the watch-mode
// server — the iOS host replaces it entirely). Stubbing removes chokidar,
// http, and commander's load-time node:* requires from the bundle.
export class Command {
	constructor() { throw new Error('[clew-ios] the jmarkdown CLI is not available in the render worker'); }
}
export function startWatch() {
	throw new Error('[clew-ios] jmarkdown watch is not available in the render worker');
}
export default { Command, startWatch };
