// Sync the upstream Clew sources this port builds from. Mirrors the pattern
// Clew itself uses for jmarkdown: ../Clew-app is the golden master and the
// ONLY place app/engine code is edited; vendor/ here is a committed dumb
// mirror, overwritten wholesale by this script. iOS-specific code lives in
// src/ and ios/ only.
//
// Copied:
//   ../Clew-app/vendor/jmarkdown/{src,package.json}  -> vendor/jmarkdown/
//   ../Clew-app/vendor/embedpdf -> vendor/embedpdf/  (the owner's OCG viewer build)
//   ../Clew-app/src/{renderer,shared,preview-client,engine,main,excalidraw} -> vendor/clew/
//   ../Clew-app/demo-vault -> seed-vault/   (the bundled starter vault)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const upstream = path.resolve(root, '..', 'Clew-app');

if (!fs.existsSync(upstream)) {
	console.log(`Upstream not found at ${upstream}; building from the committed vendor/ mirror.`);
	process.exit(0);
}

const copyDir = (from, to, filter = () => true) => {
	fs.rmSync(to, { recursive: true, force: true });
	fs.mkdirSync(to, { recursive: true });
	fs.cpSync(from, to, {
		recursive: true,
		filter: (src) => {
			const base = path.basename(src);
			if (base === '.DS_Store' || base === 'node_modules' || base === '.git') return false;
			return filter(src);
		},
	});
};

copyDir(path.join(upstream, 'vendor', 'jmarkdown', 'src'), path.join(root, 'vendor', 'jmarkdown', 'src'));
fs.copyFileSync(
	path.join(upstream, 'vendor', 'jmarkdown', 'package.json'),
	path.join(root, 'vendor', 'jmarkdown', 'package.json'));

// The owner's EmbedPDF OCG build (layers fork; wasm carries FPDF*OCG*).
// Upstream's vendor/embedpdf is itself a dumb mirror of the built viewer
// from ~/Source/EmbedPDF/v2 — this hop just extends the chain. .gitignore
// carries !vendor/embedpdf/dist/ exceptions: the blanket dist/ and *.map
// rules silently eat the mirror otherwise.
copyDir(path.join(upstream, 'vendor', 'embedpdf'), path.join(root, 'vendor', 'embedpdf'));

for (const dir of ['renderer', 'shared', 'preview-client', 'engine', 'main', 'excalidraw']) {
	copyDir(path.join(upstream, 'src', dir), path.join(root, 'vendor', 'clew', dir));
}

// The starter vault seeded into Documents on first launch. The demo vault's
// DURABLE .clew state ships with it — vault-settings.json (the noteApi gate
// and enabled plugins) and the sample plugins/scripts/snippets are part of
// what the vault documents. Device-local state (caches, engine dir,
// workspace layout) stays behind — the app regenerates those. The Excalidraw
// shape library is per-user state too, not vault documentation, and so are
// the note-history snapshots the owner's live sessions leave behind.
const CLEW_STATE_EXCLUDED = new Set([
	'cache', 'cache.json', 'engine', 'workspace.json', 'excalidraw-library.json', 'history',
]);
copyDir(path.join(upstream, 'demo-vault'), path.join(root, 'seed-vault'), (src) => {
	const marker = `${path.sep}.clew${path.sep}`;
	const at = src.indexOf(marker);
	if (at === -1) return true;
	const inside = src.slice(at + marker.length).split(path.sep)[0];
	return !CLEW_STATE_EXCLUDED.has(inside);
});

console.log('Synced vendor/jmarkdown, vendor/clew, and seed-vault from', upstream);

// The iOS app icon derives from upstream's macOS icon (a squircle floating
// on transparency): flatten over the squircle's own gradient and crop
// full-bleed — iOS masks its own corners and rejects icons with alpha.
// Regenerated only when ImageMagick is available; the committed asset is
// the fallback.
import { execFileSync } from 'node:child_process';
const upstreamIcon = path.join(upstream, 'build-resources', 'icon.png');
const iosIcon = path.join(root, 'ios', 'Clew', 'Assets.xcassets', 'AppIcon.appiconset', 'AppIcon.png');
if (fs.existsSync(upstreamIcon) && fs.existsSync(path.dirname(iosIcon))) {
	try {
		execFileSync('magick', [
			'-size', '2048x2048', 'gradient:#2b2440-#171321',
			upstreamIcon, '-composite',
			'-gravity', 'center', '-crop', '1500x1500+0+0', '+repage',
			'-resize', '1024x1024', '-alpha', 'off', iosIcon,
		]);
		console.log('Regenerated the iOS app icon from', upstreamIcon);
	} catch {
		console.log('ImageMagick not available — keeping the committed AppIcon.png.');
	}
}
