// The iPad's half of two shared renderer sheets.
//
// 1. iCloud Drive's own conflict versions (conflicts.js, the shim's iOS-only
//    part) are offered through the renderer's conflict sheet
//    (renderer/conflicts.js#openConflictSheet), the one the desktop shows
//    for an editor's refused save, so both look and read alike: Keep mine /
//    Keep theirs / Keep both / Compare, and Later. Both versions are in the
//    note's history before it opens; the versions are marked resolved only
//    after the choice. The palette's "Review conflicting versions…" reopens
//    anything left for later.
//
// 2. Every shared modal sheet — the conflict sheet, the vault-trust prompt,
//    an app's prompt — is fitted to the VISUAL viewport while it is up
//    (frame-bridge.md §4.5: a long note or the keyboard must not hide it);
//    ios.css gives their buttons 44 pt targets.
import { registerCommand } from '../../vendor/clew/renderer/commands/registry.js';
import { openConflictSheet } from '../../vendor/clew/renderer/conflicts.js';
import { notice } from '../../vendor/clew/renderer/plugins.js';

const shim = () => window.__clewShim;
const nameOf = (rel) => rel.split('/').pop().replace(/\.(md|jmd)$/i, '');

// ---- 1. iCloud's conflict versions ------------------------------------------

const waiting = new Set();
let reviewing = false;

async function review(rel) {
	const center = shim()?.conflicts;
	if (!center) return;
	const { current, versions } = await center.cloudVersions(rel);
	const other = versions[0];
	if (!other) { waiting.delete(rel); return; }
	center.keepVersion(rel, current);
	center.keepVersion(rel, other.text);
	const when = other.modifiedMs ? new Date(other.modifiedMs).toLocaleString() : 'earlier';
	const choice = await openConflictSheet({
		title: `“${nameOf(rel)}” changed in two places`,
		explain: `iCloud kept a version from ${other.from} (${when}) beside the one on this iPad. Both versions are in the note’s history.`,
		mine: current,
		theirs: other.text,
		choices: [
			{ id: 'mine', label: 'Keep mine', primary: true },
			{ id: 'theirs', label: 'Keep theirs' },
			{ id: 'both', label: 'Keep both' },
		],
	});
	if (!choice) return; // Later: stays waiting
	try {
		const result = await center.resolveCloud(rel, choice, 0);
		waiting.delete(rel);
		if (typeof result === 'string') notice(`Kept both — the other version is "${nameOf(result)}".`, 5000);
	} catch (err) {
		notice(`Could not resolve the conflict: ${err?.message ?? err}`, 6000);
	}
}

async function reviewAll() {
	if (reviewing) return;
	reviewing = true;
	try {
		for (const rel of [...waiting]) await review(rel);
	} finally {
		reviewing = false;
	}
}

shim()?.conflicts?.on((event) => {
	if (event.kind !== 'cloud') return;
	waiting.add(event.rel);
	setTimeout(reviewAll, 800);
});

registerCommand({
	id: 'vault:review-conflicts',
	name: 'Review conflicting versions…',
	run: () => {
		if (!waiting.size) notice('No conflicting versions to review.', 3000);
		reviewAll();
	},
});

// ---- 2. shared sheets in the visual viewport --------------------------------

const SHEETS = '.clew-conflict-sheet, .clew-trust-sheet, .clew-app-sheet';

function fit() {
	const vv = window.visualViewport;
	for (const sheet of document.querySelectorAll(SHEETS)) {
		sheet.style.top = `${Math.round(vv ? vv.offsetTop : 0)}px`;
		sheet.style.height = `${Math.round(vv ? vv.height : innerHeight)}px`;
		sheet.style.bottom = 'auto';
	}
}

new MutationObserver((records) => {
	for (const r of records) {
		for (const node of r.addedNodes) {
			if (node.nodeType === 1 && node.matches?.(SHEETS)) { fit(); return; }
		}
	}
}).observe(document.body, { childList: true });
window.visualViewport?.addEventListener('resize', fit);
window.visualViewport?.addEventListener('scroll', fit);
