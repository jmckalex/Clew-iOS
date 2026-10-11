// The iPad's HTML share (src/shim/html-share.js): the snapshot script's
// shape, and the last check the shim makes on the finished page. What the
// script does to a real drawn page is measured in the simulator (the
// record's results); here, what can be held under plain Node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SNAPSHOT_SCRIPT, SHARE_IMAGE_MAX, SHARE_IMAGES_MAX, shareLeaks } from '../src/shim/html-share.js';

const AsyncFunction = (async () => {}).constructor;

test('the snapshot script is an async function body of (maxImage, maxTotal), safe to send as a string', () => {
	assert.doesNotThrow(() => new AsyncFunction('maxImage', 'maxTotal', SNAPSHOT_SCRIPT));
	assert.ok(!SNAPSHOT_SCRIPT.includes('`') && !SNAPSHOT_SCRIPT.includes('${'), 'no backtick or interpolation to break the template');
	assert.equal(SHARE_IMAGE_MAX, 2 * 1024 * 1024, '2 MB an image');
	assert.equal(SHARE_IMAGES_MAX, 10 * 1024 * 1024, '10 MB of images a page');
	// What it strips and adds, by name, so a later edit cannot quietly drop one.
	for (const piece of ["'script, noscript, template, base", "n.startsWith('on')", '(javascript|vbscript|livescript):',
		"script-src 'none'", 'clew-share-placeholder', "'App'", "'PDF'", "'Presentation'", "'Embedded page'", 'a.replaceWith(...a.childNodes)', "'button, .clew-pdf-status'"]) {
		assert.ok(SNAPSHOT_SCRIPT.includes(piece), piece);
	}
});

const clean = '<!DOCTYPE html>\n<html><head><meta charset="utf-8"><style>p { color: #333; }</style></head>'
	+ '<body><p>Notes on <code>&lt;script&gt;</code> tags, onclick=handler in prose, and file://paths in text.</p>'
	+ '<img src="data:image/png;base64,AAAA" alt="x"><a href="https://example.com/">a site</a></body></html>';

test('shareLeaks: a clean page passes, prose that only mentions the patterns included', () => {
	assert.deepEqual(shareLeaks(clean, { sessionId: 's' + 'ab'.repeat(16), vaultPath: '/private/var/mobile/Containers/Data/Application/X/Documents/Demo Vault' }), []);
});

test('shareLeaks: each script and each internal path is named', () => {
	const sid = 's' + '0'.repeat(31) + '7';
	const cases = [
		['<script>alert(1)</script>', 'a script'],
		['<svg><script href="x"></script></svg>', 'a script'],
		['<img src="data:," onerror="alert(1)">', 'an event handler'],
		['<svg onload=alert(1)></svg>', 'an event handler'],
		['<a href="javascript:alert(1)">x</a>', 'a javascript: URL'],
		['<a href=" JavaScript:alert(1)">x</a>', 'a javascript: URL'],
		['<img src="clew-preview://vault/s1/x.png">', 'a clew-preview: URL'],
		['<style>body { background: url(/__clew_assets__/x.png); }</style>', 'a /__clew_ path'],
		['<img src="file:///var/x.png">', 'a file:// URL'],
		[`<img src="/${sid}/Attachments/x.png">`, 'the session id'],
		['<p data-x="/Users/me/Vault/x.md">x</p>', 'the vault\'s path on this device'],
		['<p>/private/var/mobile/Containers/Data/Application/ABC/tmp</p>', 'an app-container path'],
		['<img src="/vault/Attachments/x.png">', 'a vault-absolute path'],
	];
	for (const [fragment, named] of cases) {
		const page = clean.replace('</body>', fragment + '</body>');
		assert.ok(shareLeaks(page, { sessionId: sid, vaultPath: '/Users/me/Vault' }).includes(named), `${fragment} → ${named}`);
	}
});
