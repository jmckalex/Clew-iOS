// Session-scoped clew-preview:// URLs. Every vault URL carries the window's
// session id (multi-window: the protocol handler can't see which window is
// asking, so the URL says which vault it means). main.js sets the id from
// the vault-opened event before any preview renders.
let sessionId = 'none';

export function setPreviewSession(id) {
	sessionId = id ?? 'none';
}

const encode = (path) => path.split('/').map(encodeURIComponent).join('/');

/** Rendered-note URL (reading mode, canvas note embeds). */
export function previewUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}.html`;
}

/** Raw vault file URL (images, PDFs, media). */
export function vaultFileUrl(path) {
	return `clew-preview://vault/${sessionId}/${encode(path)}`;
}

/** Engine fragment-render endpoint (canvas cards; POST markdown → HTML). */
export function fragmentUrl() {
	return `clew-preview://vault/${sessionId}/__clew_fragment__`;
}

/** Base URL of the preview origin (rewrites root-relative asset paths). */
export function previewOrigin() {
	return 'clew-preview://vault';
}
