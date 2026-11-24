// @begin(clew-only) on the iPad (Clew-app 50c2e2e, c37ce1c), in the app:
// drawn in reading view and live edit, and then each way a note leaves the
// iPad that draws reading view — the reading-view PDF, a book's print, the
// HTML share — run for real, each writing its file into tmp/ for the share
// sheet. tools/sim-clew-only-checks.mjs reads those files on the Mac
// (pdftotext) and runs this through tools/sim-smoke.mjs.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { workspaceStore, ipc } = window.__clew;
const log = (s) => console.log('smoke-clewonly: ' + s);
const SCREEN = ['SCREEN-BLOCK', 'SCREEN-BUTTON', 'SCREEN-INLINE', 'SCREEN-PLUS'];

// Reading view's document, as the app serves it.
const html = await window.__clewNative.renderNote('Note.md');
log(`reading boxes=${(html.match(/class="clew-only"/g) || []).length} drawn=${SCREEN.every((s) => html.includes(s))}`);
const tab = workspaceStore.openNote('Note.md', { newTab: true, defaultMode: 'reading' });
workspaceStore.setTabMode(tab.id, 'reading');
await sleep(3000);
await window.__clewSmokeShot('clew-only-reading');

// Live edit: the block's head says "Clew only".
workspaceStore.setTabMode(tab.id, 'live');
await sleep(2500);
const editor = document.querySelector('.cm-editor.cm-live');
const text = editor?.textContent ?? '';
log(`live head=${text.includes('Clew only')} drawn=${SCREEN.every((s) => text.includes(s))}`);
await window.__clewSmokeShot('clew-only-live');

// Out of the app: each run as the app's own commands run them.
const runs = [
	['pdf', () => ipc.invoke('clew:export-note', { path: 'Note.md', format: 'print-pdf' })],
	['book', () => ipc.invoke('clew:export-book', { master: 'Book/Book.md', format: 'print' })],
	['html', () => ipc.invoke('clew:export-note', { path: 'Note.md', format: 'html' })],
];
for (const [what, run] of runs) {
	try {
		const r = await run();
		log(`${what} ok ${JSON.stringify(r).slice(0, 300)}`);
	} catch (err) {
		log(`${what} failed ${String(err?.message ?? err)}`);
	}
	await sleep(1500);
}
