// "Export notes as PDF (reading view)" on the iPad (Clew-app 393d482), in
// the app, through upstream's own sheet: the Essays folder's long-press menu
// (ios-ui.js makes a long press this contextmenu), the sheet with its notes
// ticked, Export, then the report. The picker and the question about PDFs
// already there are answered by the Debug build's smoke defaults
// (ClewSmokeExportDir, ClewSmokeExisting: FSBridge.swift), as Clew-app's
// CLEW_SMOKE_EXPORT_DIR and CLEW_SMOKE_REPLACE answer its dialogs. Last,
// Show in Files. tools/sim-export-notes-checks.mjs reads the PDFs (pdftotext).
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { workspaceStore, vaultStore } = window.__clew;
const log = (s) => console.log('smoke-notes: ' + s);
const until = async (test, ms = 10000) => {
	for (const t0 = Date.now(); Date.now() - t0 < ms; await sleep(100)) if (test()) return true;
	return false;
};
log(`platform ${navigator.platform}`);
workspaceStore.setSidebar('left', { open: true, activeTool: 'files' });
await sleep(1500);
const row = (p) => document.querySelector(`clew-file-explorer .tree-item[data-path="${CSS.escape(p)}"]`);
const box = row('Essays').getBoundingClientRect();
row('Essays').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 20, clientY: box.top + 5 }));
await sleep(300);
const items = [...document.querySelectorAll('.clew-menu .menu-item')];
log(`menu ${JSON.stringify(items.map((b) => b.textContent))}`);
items.find((b) => b.textContent === 'Export notes as PDF (reading view)…')?.click();
await until(() => document.querySelector('.clew-print-sheet'));
await sleep(500);
const sheet = document.querySelector('.clew-print-sheet');
const ticked = [...sheet.querySelectorAll('input[type=checkbox]')].filter((b) => b.checked).map((b) => b.dataset.path);
log(`sheet title=${JSON.stringify(sheet.querySelector('h2')?.textContent)} ticked=${JSON.stringify(ticked)} count=${JSON.stringify(sheet.querySelector('.clew-print-count')?.textContent)}`);
await window.__clewSmokeShot('notes-sheet');
const t0 = Date.now();
sheet.querySelector('[data-print-action="export"]').click();
await until(() => sheet.dataset.state === 'done' || sheet.dataset.state === 'failed', 120000);
log(`report state=${sheet.dataset.state} seconds=${Math.round((Date.now() - t0) / 1000)} text=${JSON.stringify(sheet.querySelector('.clew-sheet-body')?.textContent)}`);
const reveal = sheet.querySelector('[data-print-action="reveal"]');
log(`buttons ${JSON.stringify([...sheet.querySelectorAll('.clew-sheet-buttons button')].map((b) => b.textContent))}`);
await window.__clewSmokeShot('notes-report');
log(`explorer has ${JSON.stringify(['PDFs/Ann.pdf', 'PDFs/Ann 2.pdf', 'PDFs/Bob.pdf', 'PDFs/Week 2/Cy.pdf', 'PDFs/Sketch.pdf'].map((p) => vaultStore.pathExists(p)))}`);
// Show in Files: the Files app opens at the folder (the app goes to the back).
reveal?.click();
await sleep(2500);
await window.__clewSmokeShot('notes-files');
log(`revealed visibility=${document.visibilityState}`);
