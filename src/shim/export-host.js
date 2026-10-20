// The app page's side of the export host (UPSTREAM-LATEX-EXPORT-PLAN.md §3,
// L1): the job is built here, from what the render service snapshots for its
// own workers, and handed to native as one string; native runs it in the
// export host's web view (ExportHost.swift) and answers with the folder the
// outputs were written into. Nothing is shared or kept: a caller discards the
// folder when it is done with it (the .tex export, L2, shares it first).
import { exportJob } from './export-job.js';

export function createExportHost({ renderService, bridgeCall, vaultRoot }) {
	return {
		/** The job for one note, as the host will run it (tests, the harness). */
		async job(rel, format = 'latex') {
			const inputs = await renderService.exportInputs();
			return exportJob({ vaultRoot, noteRel: rel, format, ...inputs });
		},
		/**
		 * Run one export. Answers native's `{ folder, output, files: [{ rel,
		 * bytes }], warnings, ms }`; `folder` names the job's folder for
		 * discard().
		 */
		async run(rel, format = 'latex') {
			const job = await this.job(rel, format);
			return bridgeCall('exportRun', { job: JSON.stringify(job) });
		},
		discard(folder) {
			return bridgeCall('exportDiscard', { folder });
		},
	};
}
