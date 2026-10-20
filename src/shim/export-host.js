// The app page's side of the export host (UPSTREAM-LATEX-EXPORT-PLAN.md §3,
// L1 and L2): the job is built here, from what the render service snapshots
// for its own workers, and handed to native as one string; native runs it in
// the export host's web view (ExportHost.swift) and answers with the folder
// the outputs were written into, and the .tex. The share is decided here
// too (export-references.js): what the .tex names, from the vault's mirror.
// Native stages the folder, copies those vault files into it, and shares the
// .tex alone or a zip of it all; the folder goes when the share sheet closes
// (exportShare), or with discard() when a caller stops before sharing.
import { exportJob } from './export-job.js';
import { texReferences } from './export-references.js';
import { citationLines } from '../../vendor/clew/shared/citation-keys.js';
import { absoluteList, bibliographyList } from '../../vendor/clew/shared/citation-files.js';
import { vfs } from '../worker/shims/vfs.js';

const textOf = (abs) => {
	const data = vfs.files.get(abs)?.data;
	return typeof data === 'string' ? data : '';
};

export function createExportHost({ renderService, bridgeCall, vaultRoot, settings }) {
	const rel = (abs) => (abs.startsWith(`${vaultRoot}/`) ? abs.slice(vaultRoot.length + 1) : null);

	/**
	 * The .bib files a build of `noteRel` could have used, vault-relative, in
	 * the engine's order: the vault's jmarkdown config (the export's cwd, a
	 * trusted vault's note folder), the vault's setting, then the note's own
	 * header's, which adds to them (jmarkdown 909af7a).
	 */
	const bibFilesFor = (noteRel, vaultOptions, trusted) => {
		const noteDir = `${vaultRoot}/${noteRel}`.replace(/\/[^/]*$/, '');
		const out = [];
		if (trusted) {
			try {
				const named = JSON.parse(textOf(`${noteDir}/.jmarkdown/config.json`) || '{}')?.Biblify?.bibliography;
				out.push(...bibliographyList(named).map((p) => (p.startsWith('/') ? p : `${noteDir}/${p}`)));
			} catch { /* no config, or not JSON: none from it */ }
		}
		const vaultBib = String(vaultOptions?.bibliography ?? '').trim();
		if (vaultBib) out.push(vaultBib.startsWith('/') ? vaultBib : `${vaultRoot}/${vaultBib}`);
		const header = citationLines(textOf(`${vaultRoot}/${noteRel}`)).find((line) => line.key === 'bibliography');
		if (header) out.push(...absoluteList(header.value, noteDir));
		return out.map((abs) => rel(abs.replace(/\/\.\//g, '/'))).filter(Boolean);
	};

	const jobFor = async (noteRel, format) => {
		const inputs = await renderService.exportInputs();
		const job = exportJob({
			vaultRoot, noteRel, format, ...inputs,
			settings: { latexExportStyle: settings?.get('latexExportStyle'), latexEngine: settings?.get('latexEngine') },
			locale: Intl.DateTimeFormat().resolvedOptions().locale,
		});
		return { inputs, job };
	};

	return {
		/** The job for one note, as the host will run it (tests, the harness). */
		async job(noteRel, format = 'latex') {
			return (await jobFor(noteRel, format)).job;
		},
		/**
		 * Run one export. Answers native's `{ folder, output, files: [{ rel,
		 * bytes }], warnings, ms, tex }` and the job's `base` and `trusted`;
		 * `folder` names the job's folder for share() or discard().
		 */
		async run(noteRel, format = 'latex') {
			const { inputs, job } = await jobFor(noteRel, format);
			const done = await bridgeCall('exportRun', { job: JSON.stringify(job) });
			return { ...done, base: job.base, trusted: inputs.trusted, vaultOptions: inputs.vaultOptions };
		},
		/**
		 * What run()'s .tex names, and native's share of it: `{ kind: 'tex' |
		 * 'zip', name, bytes, entries }`, with the names the vault lacks and
		 * those it has but the share does not carry.
		 */
		async share(done, noteRel) {
			const refs = texReferences({
				tex: done.tex ?? '', base: done.base,
				exists: (r) => vfs.files.has(`${vaultRoot}/${r}`),
				bibFiles: bibFilesFor(noteRel, done.vaultOptions, done.trusted),
			});
			const shared = await bridgeCall('exportShare', {
				folder: done.folder, name: done.base, output: done.output, include: refs.files, bibs: refs.bibs,
			});
			return { ...shared, missing: refs.missing, refused: refs.refused };
		},
		discard(folder) {
			return bridgeCall('exportDiscard', { folder });
		},
	};
}
