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
