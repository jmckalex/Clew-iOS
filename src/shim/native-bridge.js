// The JS↔native RPC. On iOS, calls go to the Swift FSBridge through
// WKScriptMessageHandlerWithReply (window.webkit.messageHandlers.clew
// returns a real promise). Under Node tests and the dev server, a plain JS
// implementation is injected as globalThis.__clewBridgeImpl instead.
//
// Methods the native side implements (all params/results JSON-safe):
//   vaultBootstrap()                 -> { path } of the vault to auto-open
//   vaultOpen({path})                -> { name, path, files } where files
//                                       maps rel path -> {text?, size, mtimeMs}
//                                       (text present for text files only)
//   pickFolder()                     -> { path } | null (document picker)
//   createVault()                    -> { path } | null (name sheet; folder in Documents)
//   demoVaultPath()                  -> { path } of the seeded demo vault (seeds it if missing)
//   officeThumbnail({rel})           -> { ok, path, stamp } | { ok: false, reason } (Quick Look)
//   quickLook({rel})                 -> null (system viewer for a vault file)
//   write({vault, rel, text})        -> null
//   writeBinary({vault, rel, base64})-> {rel, size} (attachments; dedupes name)
//   updateBinary({rel, base64})      -> null (overwrite existing file in place)
//   mkdir({vault, rel})              -> null
//   rename({vault, rel, newRel})     -> null
//   trash({vault, rel})              -> null
//   setMtime({vault, rel, mtimeMs})  -> null (history snapshots carry their content time)
//   remove({vault, rel})             -> null (hard delete; .clew/history/ only — pruning)
//   openExternal({url})              -> null
//   shareText({name, text})         -> null (share sheet)
//   shareBase64({name, base64})     -> null
//   rescan({vault})                  -> { changed: {rel: {text?, size, mtimeMs}},
//                                        removed: [rel] }
//   pdfThumbnail({rel})              -> { ok, path, stamp } | { ok: false, reason } (Quick Look)
//   registerRemotePdfs({urls})       -> { registered: {url: hash}, refused: {url: reason} }
//   saveRemotePdfCopy({hash, folder})-> {rel, size} (never overwrites)
//   openRemotePdf({hash})            -> {url} (this session's registration only)
//   pdfLeakCount()                   -> number (raw PDFs cancelled in frames)
//   vaultTrustGet()                  -> { open, trusted, identity }
//   vaultTrustSet({trusted})         -> { open, trusted, identity }
//   vaultOpen also answers `trusted` (this device's trust in the vault).
//   scanDocument({rel?, pdf?})       -> { rel?, size?, pages, text } | { cancelled: true }
//                                       (the document camera; OCR; a NEW PDF at rel, deduped)
//   takeQuickAction()                -> { action: 'scan'|'new-note'|'daily'|null } (Home Screen)

export async function bridgeCall(method, params = {}) {
	const impl = globalThis.__clewBridgeImpl;
	if (impl) return impl.call(method, params);
	const handler = globalThis.webkit?.messageHandlers?.clew;
	if (!handler) throw new Error(`[clew-ios] no native bridge for ${method}`);
	return handler.postMessage({ method, params });
}

/** Uint8Array → base64 (chunked; String.fromCharCode has an argv limit). */
export function toBase64(bytes) {
	let binary = '';
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
	}
	return btoa(binary);
}
