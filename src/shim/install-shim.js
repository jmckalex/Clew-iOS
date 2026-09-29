// Installs window.clew (the renderer's whole main-process surface) and
// window.__clewNative (the Swift side's entry points) before the renderer
// module graph evaluates. Must stay synchronous.
import { createClewShim } from './ipc.js';

const shim = createClewShim();
window.clew = shim.clew;
window.__clewNative = shim.native;
window.__clewShim = shim; // dev/debug access to the services

// Desktop flushes editors on window blur/beforeunload; neither fires
// reliably in WKWebView. visibilitychange covers app backgrounding, and the
// Swift side calls __clewNative.flush() from applicationDidEnterBackground.
document.addEventListener('visibilitychange', () => {
	if (document.visibilityState === 'hidden') {
		window.dispatchEvent(new Event('blur')); // editorPool.flushAll listens on blur
		shim.native.flush();
	}
});

// Suspension (ClewApp.swift, scenePhase → background): iOS may freeze the
// app seconds after it leaves the screen, so Swift holds a background task
// until this resolves — every editor flushed, every PDF viewer's unsaved
// annotations saved and landed (upstream pdf-frames.js#flushAllPdf, the
// promise desktop's window-close handshake awaits; a viewer reports clean
// only once its PDF_WRITE has finished natively), and the queued vault
// writes drained. iOS has no window close; this is its closest moment.
window.__clewNative.flushForSuspension = async () => {
	window.dispatchEvent(new Event('blur'));
	try {
		const { flushAllPdf } = await import('../../vendor/clew/renderer/pdf-frames.js');
		await flushAllPdf(8000);
	} catch (err) {
		console.warn('[clew-ios] PDF flush on suspension:', err);
	}
	await shim.native.flush();
	return true;
};
