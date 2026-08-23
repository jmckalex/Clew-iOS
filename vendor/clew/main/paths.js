// Dev-vs-packaged filesystem locations, decided once. The critical
// constraint: the engine worker is a PLAIN NODE child process — it cannot
// read inside app.asar — so in the packaged app the engine (vendored
// jmarkdown + its staged node_modules), the engine assets it loads
// (template, extensions), and the preview assets served to iframes all live
// unpacked under process.resourcesPath (see the electron-builder
// extraResources config in package.json).
import { app } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const distDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const rootDir = path.dirname(distDir);

export const paths = app.isPackaged
	? {
		engineWorker: path.join(process.resourcesPath, 'engine', 'jmarkdown', 'src', 'watch-worker.js'),
		engineAssets: path.join(process.resourcesPath, 'engine-assets'),
		previewAssets: path.join(process.resourcesPath, 'preview-assets'),
	}
	: {
		engineWorker: require.resolve('jmarkdown/src/watch-worker.js'),
		engineAssets: path.join(distDir, 'engine'),
		previewAssets: path.join(rootDir, 'node_modules'),
	};
