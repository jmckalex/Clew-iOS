// Sync the upstream Clew sources this port builds from. Mirrors the pattern
// Clew itself uses for jmarkdown: ../Clew-app is the golden master and the
// ONLY place app/engine code is edited; vendor/ here is a committed dumb
// mirror, overwritten wholesale by this script. iOS-specific code lives in
// src/ and ios/ only.
//
// Copied:
//   ../Clew-app/vendor/jmarkdown/{src,package.json}  -> vendor/jmarkdown/
//   ../Clew-app/src/{renderer,shared,preview-client,engine} -> vendor/clew/
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

for (const dir of ['renderer', 'shared', 'preview-client', 'engine']) {
	copyDir(path.join(upstream, 'src', dir), path.join(root, 'vendor', 'clew', dir));
}

// The starter vault seeded into Documents on first launch. .clew caches and
// state stay behind — the app regenerates them.
copyDir(path.join(upstream, 'demo-vault'), path.join(root, 'seed-vault'),
	(src) => !src.includes(`${path.sep}.clew`));

console.log('Synced vendor/jmarkdown, vendor/clew, and seed-vault from', upstream);
