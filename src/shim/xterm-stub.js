// The shell panel's terminal, stubbed. A PTY cannot exist on iOS, so the
// panel is never opened here: `shell:toggle` is dropped from the command
// registry (scripts/build.js), SHELL_OPEN answers with a refusal (ipc.js)
// and WORKSPACE_LOAD forces the panel closed. clew-shell-panel.js still
// imports @xterm/xterm and @xterm/addon-fit at module scope, and the build
// aliases both packages here so the app bundle carries no terminal
// emulator it could never draw into. The shapes below are what the panel
// would call if it ever did open — inert, so that even a stray open is a
// blank panel rather than an exception.
export class Terminal {
	options = {};
	cols = 80;
	rows = 24;
	unicode = { activeVersion: '6', versions: ['6'] };
	constructor(options = {}) { this.options = { ...options }; }
	open() {}
	loadAddon() {}
	write() {}
	onData() { return { dispose() {} }; }
	onResize() { return { dispose() {} }; }
	focus() {}
	clear() {}
	reset() {}
	dispose() {}
}

export class FitAddon {
	activate() {}
	fit() {}
	dispose() {}
}

export class Unicode11Addon {
	activate() {}
	dispose() {}
}
