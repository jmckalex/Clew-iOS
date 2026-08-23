/*
	Dependency tracking for `jmarkdown watch`.

	A build reads more than its source file: recursive `[[includes]]`,
	configuration files, custom-element templates, `.bib` databases, embedded
	images, and so on. The watch worker is forked with the CJS preload
	`watch-fs-preload.cjs` (-r), which patches the fs read functions before any
	ESM module links 'fs' and records every path read into a global Set. This
	module is the small API the worker uses to read and reset that set, so the
	watcher can watch exactly the files the build actually touched — no guessing,
	no per-feature maintenance.

	NOT captured: modules pulled in by `import()` (the `Load directives/
	extensions/javascript` metadata keys) — those bypass fs, so editing such a
	file currently needs a watcher restart.
*/

export function getDeps() {
	return global.__JMD_DEPS ? [...global.__JMD_DEPS] : [];
}

export function resetDeps() {
	if (global.__JMD_DEPS) global.__JMD_DEPS.clear();
}
