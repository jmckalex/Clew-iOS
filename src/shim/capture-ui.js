// iPad capture (FEATURE-IDEAS #9), the page side: scan a document into the
// note, scan its text to the caret, and the Home Screen quick actions.
//
// "Scan document" (the palette, and a button in the editor toolbar's Insert
// group) runs VisionKit's camera; the pages become one PDF in the
// attachment folder, with an invisible text layer so the PDF viewer can
// search and select its words, and `![[Scan ….pdf]]` goes in at the caret.
// "Scan text" puts the recognised text itself at the caret, the way Live
// Text does. With no note being edited, either makes a new note.
import { registerCommand, runCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { activeEditorView } from '../../vendor/clew/renderer/commands/format.js';
import { addToolbarButton } from '../../vendor/clew/renderer/editor/toolbar/clew-editor-toolbar.js';
import { workspaceStore } from '../../vendor/clew/renderer/state/workspace-store.js';
import { vaultStore } from '../../vendor/clew/renderer/state/vault-store.js';
import { ipc, CH } from '../../vendor/clew/renderer/ipc.js';
import { notice } from '../../vendor/clew/renderer/plugins.js';

const shim = () => window.__clewShim;
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}.${pad(d.getMinutes())}.${pad(d.getSeconds())}`;

/** A viewfinder over a page, for the toolbar. */
const SCAN_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
	+ '<path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/>'
	+ '<path d="M8 8h8M8 12h8M8 16h5"/></svg>';

/** Where the scan goes: the caret of the note being edited (its end, when
 *  the note is in reading mode), or null for a new note. Taken BEFORE the
 *  camera opens, so the scan lands where the user was. */
function target() {
	const tab = workspaceStore.activeTab();
	if (tab?.kind !== 'note') return null;
	const view = activeEditorView();
	if (!view) return null;
	return { view, path: tab.path, reading: tab.view?.mode === 'reading' };
}

/** `block` on lines of its own at the target, the caret after it. */
function insertAt({ view, reading }, block) {
	const doc = view.state.doc;
	const at = reading ? doc.length : view.state.selection.main.head;
	const before = at > 0 && doc.sliceString(at - 1, at) !== '\n' ? '\n' : '';
	const text = `${before}${block}\n`;
	view.dispatch({ changes: { from: at, insert: text }, selection: { anchor: at + text.length }, scrollIntoView: true });
	if (!reading) view.focus();
}

async function intoNewNote(block) {
	const rel = await ipc.invoke(CH.NOTE_CREATE, { path: `Scan ${stamp().slice(0, 16)}.md` });
	await ipc.invoke(CH.NOTE_WRITE, { path: rel, content: `${block}\n` });
	workspaceStore.openNote(rel, { newTab: true });
	return rel;
}

let scanning = false;

/** Scan, then insert. `text`: the recognised text instead of a PDF. */
export async function scanIntoNote({ text = false, newNote = false } = {}) {
	if (scanning || !vaultStore.vault) return null;
	scanning = true;
	const where = newNote ? null : target();
	try {
		const answer = await shim().capture.scan({ pdf: !text, name: `Scan ${stamp()}.pdf` });
		if (!answer) return null; // cancelled
		const words = String(answer.text ?? '').trim();
		if (text && !words) {
			notice('No text was found in the scan.', 5000);
			return null;
		}
		const block = text ? words : `![[${answer.rel.split('/').pop()}]]`;
		// The note may have closed while the camera was up.
		if (where && where.view.dom.isConnected) insertAt(where, block);
		else await intoNewNote(block);
		const pages = `${answer.pages} page${answer.pages === 1 ? '' : 's'}`;
		notice(text
			? `Scanned the text of ${pages}.`
			: `Scanned ${pages} into “${answer.rel.split('/').pop()}”${words ? '; its text is searchable' : ''}.`, 5000);
		return answer;
	} catch (err) {
		notice(`Couldn’t scan: ${String(err?.message ?? err)}`, 8000);
		return null;
	} finally {
		scanning = false;
	}
}

registerCommand({
	id: 'capture:scan', name: 'Scan document into note…',
	when: (ctx) => ctx.vaultOpen,
	run: () => scanIntoNote(),
});
registerCommand({
	id: 'capture:scan-text', name: 'Scan text into note…',
	when: (ctx) => ctx.vaultOpen,
	run: () => scanIntoNote({ text: true }),
});
addToolbarButton({ group: 'insert', icon: SCAN_ICON, label: 'Scan document…', command: 'capture:scan' });

// ---- Home Screen quick actions (QuickActions.swift) -------------------------

async function newNote() {
	const rel = await ipc.invoke(CH.NOTE_CREATE, { path: 'Untitled.md' });
	workspaceStore.openNote(rel, { newTab: true });
}

const ACTIONS = {
	scan: () => scanIntoNote({ newNote: true }),
	'new-note': newNote,
	daily: () => runCommand('nav:daily-note'),
};

let polling = null;
/** Takes the waiting action, once the vault is open, and runs it. */
function poll() {
	polling ??= (async () => {
		for (let i = 0; i < 300 && !vaultStore.vault; i++) await new Promise((r) => setTimeout(r, 100));
		const action = await shim().capture.takeQuickAction().catch(() => null);
		if (action && ACTIONS[action]) await ACTIONS[action]();
	})().catch((err) => console.warn('[clew-ios] quick action:', err)).finally(() => { polling = null; });
	return polling;
}

window.__clewCapture = { poll, scanIntoNote };
poll();
