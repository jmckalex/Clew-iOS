// The export host's page script (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1). It
// runs in a hidden WKWebView of its own (ExportHost.swift), on the preview
// scheme, so in a WebContent process of its own: an export that runs out of
// memory ends there, and the editor is untouched.
//
// One job per page: fetch it by the token in the page's URL, run it in the
// export worker, hand each output file back as the body of a POST, then say
// done. Nothing large crosses evaluateJavaScript, and the page keeps no
// state of its own: native holds the job until it is fetched once, and
// writes what comes back into the job's folder.
import { isSafeExportPath } from './outputs.js';

const token = new URLSearchParams(location.search).get('job') ?? '';
const base = `/__clew_export__`;
const MPTIKZ = new URL('/__clew_assets__/mptikz/index.js', location.href).href;

const post = (what, body, type = 'application/octet-stream') => fetch(`${base}/${what}/${encodeURIComponent(token)}`
	+ (what === 'out' ? `?rel=${encodeURIComponent(body.rel)}` : ''), {
	method: 'POST',
	headers: { 'Content-Type': type },
	body: what === 'out' ? body.data : body,
}).then((res) => {
	if (!res.ok) throw new Error(`${what} refused (${res.status})`);
});

const done = (answer) => post('done', JSON.stringify(answer), 'application/json');

/** The worker's next message of `type` (or its error). */
const next = (worker, type) => new Promise((resolve, reject) => {
	worker.onmessage = (event) => {
		const msg = event.data;
		if (msg?.type === type) resolve(msg);
		else if (msg?.type === 'error') reject(Object.assign(new Error(msg.message), { stack: msg.stack }));
	};
	worker.onerror = (event) => reject(new Error(`export worker failed: ${event.message ?? 'did not start'}`));
});

async function run() {
	const res = await fetch(`${base}/job/${encodeURIComponent(token)}`);
	if (!res.ok) throw new Error(`no job (${res.status})`);
	const job = await res.json();
	const worker = new Worker(`${base}/export-worker.js`, { type: 'module' });
	const started = performance.now();
	try {
		const ready = next(worker, 'ready');
		worker.postMessage({ type: 'init', ...job.init });
		await ready;
		const built = next(worker, 'done');
		worker.postMessage({ type: 'build', ...job.build, mptikzUrl: MPTIKZ });
		const result = await built;
		const files = [];
		for (const out of result.outputs) {
			if (!isSafeExportPath(out.rel)) throw new Error(`an output names a path outside its folder: ${out.rel}`);
			await post('out', out);
			files.push(out.rel);
		}
		const output = result.output.slice(result.output.lastIndexOf('/') + 1);
		await done({ output, files, warnings: result.warnings ?? [], ms: Math.round(performance.now() - started) });
	} finally {
		worker.terminate();
	}
}

run().catch((err) => done({ error: String(err?.message ?? err) }).catch(() => {}));
