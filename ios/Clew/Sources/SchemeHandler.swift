// The custom scheme server — Swift port of src/main/protocol.js plus the
// clew-app:// origin that serves the app itself from the bundled WebRoot.
//
// URL space (mirrors desktop exactly so renderer + preview client run
// unmodified):
//   clew-app://app/<path>                            WebRoot file
//   clew-preview://vault/__clew_assets__/<root>/…    preview iframe assets
//   clew-preview://vault/__clew_preview__/…          preview client / note API
//   clew-preview://vault/<sid>/<note>.md.html        rendered note (via JS)
//   clew-preview://vault/<sid>/__clew_fragment__     POST md → body html
//   clew-preview://vault/<sid>/__clew_block__        POST {text, sourcePath} → {hash}
//   clew-preview://vault/<sid>/__clew_block__/<hash> GET  a live-edit block document
//   clew-preview://vault/<sid>/__clew_remote_pdf__/<hash> GET  a registered web PDF
//   clew-preview://vault/<sid>/<any path>            real file from the vault
//
// Rendered notes come from the JS RenderService (window.__clewNative) —
// the reverse of desktop, where main owned rendering; here the engine
// worker lives in the web context and Swift asks it.
import Foundation
import WebKit

final class SchemeHandler: NSObject, WKURLSchemeHandler {
	private let vaults: VaultStore
	weak var webView: WKWebView?
	private var stoppedTasks = Set<ObjectIdentifier>()

	init(vaults: VaultStore) {
		self.vaults = vaults
	}

	static let mimeTypes: [String: String] = [
		"html": "text/html", "css": "text/css", "js": "text/javascript",
		"mjs": "text/javascript", "json": "application/json",
		"svg": "image/svg+xml", "png": "image/png", "jpg": "image/jpeg",
		"jpeg": "image/jpeg", "gif": "image/gif", "webp": "image/webp",
		"avif": "image/avif", "pdf": "application/pdf", "woff": "font/woff",
		"woff2": "font/woff2", "ttf": "font/ttf", "otf": "font/otf",
		"mp4": "video/mp4", "webm": "video/webm", "mp3": "audio/mpeg",
		"m4a": "audio/mp4", "wav": "audio/wav", "txt": "text/plain",
		"md": "text/plain", "jmd": "text/plain", "mov": "video/quicktime",
		"heic": "image/heic", "wasm": "application/wasm",
	]

	// Desktop protocol.js assetRoots, mapped onto the staged WebRoot.
	static let assetRoots: [String: String] = [
		"mathjax": "preview-assets/mathjax/es5",
		"mermaid": "preview-assets/mermaid/dist",
		"highlight": "preview-assets/highlight.js/styles",
		"fontawesome": "preview-assets/@fortawesome/fontawesome-free/js",
		"jquery": "preview-assets/jquery/dist",
		"leaflet": "preview-assets/leaflet/dist",
		"preview": "engine-assets",
		// The EmbedPDF bundle + pdfium.wasm (the only PDF stack in the app).
		"embedpdf": "preview-assets/embedpdf",
		// mp-tikz-wasm: the MetaPost/TeX engines and their TeX bundles, staged
		// by scripts/stage-mptikz.js. A first figure reads ~90 of these files
		// through kpathsea, so the whole tree is servable — read-only app
		// payload, like embedpdf. Served `immutable` (below): the one exception
		// to no-store, as in upstream's protocol.js.
		"mptikz": "preview-assets/mptikz",
		// Our own PDF viewer page + its bundle (pdf-page.html/.js), which the
		// file tab, canvas PDF nodes and canvas-embed scenes load in an iframe.
		"clewpdf": "preview-client",
		// The Excalidraw editor page + its bundle (React lives only here).
		"clewex": "preview-assets/clewex",
		// Excalidraw's own fonts and locale data — window.EXCALIDRAW_ASSET_PATH
		// points here so the editor never calls unpkg.
		"excalidraw": "preview-assets/excalidraw",
	]

	private var webRootURL: URL? {
		Bundle.main.url(forResource: "WebRoot", withExtension: nil)
	}

	// MARK: - WKURLSchemeHandler

	func webView(_ webView: WKWebView, start task: WKURLSchemeTask) {
		guard let url = task.request.url else { return fail(task, "no url") }
		switch url.scheme {
		case "clew-app":
			serveAppFile(task, url: url)
		case "clew-preview":
			servePreview(task, url: url)
		default:
			fail(task, "unknown scheme")
		}
	}

	func webView(_ webView: WKWebView, stop task: WKURLSchemeTask) {
		stoppedTasks.insert(ObjectIdentifier(task))
	}

	private func isStopped(_ task: WKURLSchemeTask) -> Bool {
		stoppedTasks.contains(ObjectIdentifier(task))
	}

	// MARK: - clew-app (the application itself)

	private func serveAppFile(_ task: WKURLSchemeTask, url: URL) {
		guard let webRoot = webRootURL else { return fail(task, "WebRoot missing from bundle") }
		var rel = url.path.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		if rel.isEmpty { rel = "index.html" }
		let file = webRoot.appendingPathComponent(rel).standardizedFileURL
		guard file.path.hasPrefix(webRoot.standardizedFileURL.path) else { return fail(task, "forbidden") }
		respondFile(task, fileURL: file, rangeHeader: nil)
	}

	// MARK: - clew-preview (rendered notes, vault files, iframe assets)

	private func servePreview(_ task: WKURLSchemeTask, url: URL) {
		let pathname = url.path.removingPercentEncoding ?? url.path
		let rel = pathname.trimmingCharacters(in: CharacterSet(charactersIn: "/"))

		if rel.hasPrefix("__clew_assets__/") {
			let rest = String(rel.dropFirst("__clew_assets__/".count))
			// Every EmbedPDF viewer asks for CJK fallback fonts on open.
			// Desktop answers with a font config when the user has downloaded
			// the 139 MB Noto pack, and the literal `null` when they have not.
			// iOS has no downloader, so the answer is always `null` — EmbedPDF's
			// "no fallback, and no CDN either". Answering explicitly (rather
			// than 404ing into pdf-core's catch) keeps the viewer's happy path.
			if rest == "pdffonts/fallback.json" {
				return respondData(task, data: Data("null".utf8), mime: "application/json")
			}
			// The note's typeface as font files, for `font=note` figures
			// (NoteFonts.swift): index.json naming the faces, then one sfnt
			// per face, built from CoreText on first use and cached in
			// Application Support — outside the WebRoot, hence before the
			// asset-root lookup. Same URL shape as desktop's protocol.js.
			if rest.hasPrefix("notefonts/") {
				let name = String(rest.dropFirst("notefonts/".count))
				guard let file = NoteFonts.shared.file(named: name) else {
					return fail(task, "no such note font", status: 404)
				}
				return respondFile(task, fileURL: file, rangeHeader: nil)
			}
			let parts = rest.split(separator: "/", maxSplits: 1).map(String.init)
			guard parts.count == 2, let base = Self.assetRoots[parts[0]], let webRoot = webRootURL else {
				return fail(task, "unknown asset root")
			}
			let file = webRoot.appendingPathComponent(base).appendingPathComponent(parts[1]).standardizedFileURL
			guard file.path.hasPrefix(webRoot.standardizedFileURL.path) else { return fail(task, "forbidden") }
			// Everything else is no-store, which is right for anything that can
			// change under the app. The TeX engines are a pinned, read-only
			// build whose bundles a figure re-reads by the dozen, and whose
			// wasm WebKit may only code-cache if it is allowed to store it.
			let extra = parts[0] == "mptikz" ? ["Cache-Control": "public, max-age=31536000, immutable"] : [:]
			return respondFile(task, fileURL: file, rangeHeader: task.request.value(forHTTPHeaderField: "Range"), extra: extra)
		}

		if rel.hasPrefix("__clew_preview__/") {
			guard let webRoot = webRootURL else { return fail(task, "WebRoot missing") }
			// A closed set, as upstream's protocol.js: nothing else under
			// dist/preview-client is servable here. wa.{js,css} are the Web
			// Awesome widgets, fetched lazily by meta-bind.js.
			let known: Set<String> = ["api.js", "client.js", "wa.js", "wa.css"]
			let name = rel.split(separator: "/").last.map(String.init) ?? ""
			let file = known.contains(name) ? name : "client.js"
			return respondFile(task, fileURL: webRoot.appendingPathComponent("preview-client/\(file)"), rangeHeader: nil)
		}

		if rel.hasPrefix("__clew_plugin_app__/") {
			// App-surface plugin code, wrapped so the body receives its API
			// object as `clew` (port of protocol.js — the app CSP has no
			// unsafe-eval, so plugin code must load as a real script). Served
			// only for plugins currently enabled in vault-settings.json.
			let parts = rel.split(separator: "/").map(String.init)
			guard parts.count == 3, parts[2].hasSuffix(".js") else {
				return fail(task, "bad plugin path", status: 404)
			}
			let id = String(parts[2].dropLast(3))
			// plugin.dir is the plugin's own folder, vault-local or global.
			guard let plugin = enabledPlugins().first(where: { $0.id == id }),
				let appFile = plugin.surfaces["app"],
				let code = try? String(contentsOf: plugin.dir.appendingPathComponent(appFile), encoding: .utf8) else {
				return fail(task, "not an enabled plugin", status: 403)
			}
			let idJson = String(data: try! JSONEncoder().encode(id), encoding: .utf8)!
			let wrapped = "(function (clew) {\n'use strict';\n\(code)\n})(window.__clewPluginApi?.[\(idJson)]);"
			return respondData(task, data: Data(wrapped.utf8), mime: "text/javascript")
		}

		if rel.hasPrefix("__clew_plugin_file__/") {
			// Files inside a GLOBAL plugin's folder: /__clew_plugin_file__/<sid>/
			// <id>/<path>. A vault plugin's files are ordinary vault content; a
			// global plugin lives outside every vault, so its preview surface —
			// and any sibling it fetches — is served from here, gated on the
			// plugin being enabled in this vault and clamped inside its own
			// folder (port of protocol.js).
			let parts = rel.split(separator: "/", omittingEmptySubsequences: true).map(String.init)
			guard parts.count >= 4 else { return fail(task, "bad plugin file path", status: 404) }
			guard isCurrentSession(parts[1]) else { return fail(task, "Not found", status: 404) }
			let id = parts[2]
			guard let plugin = enabledPlugins().first(where: { $0.id == id && $0.scope == "global" }) else {
				return fail(task, "not an enabled global plugin", status: 403)
			}
			let file = plugin.dir.appendingPathComponent(parts[3...].joined(separator: "/")).standardizedFileURL
			guard file.path.hasPrefix(plugin.dir.standardizedFileURL.path + "/") else {
				return fail(task, "path escapes plugin", status: 403)
			}
			return respondFile(task, fileURL: file, rangeHeader: nil)
		}

		// Everything else: /<sid>/<vault path> — THIS session's sid only (a
		// random one per vault open), so a frame not handed a URL cannot
		// build one (Clew-app b561983).
		guard let slash = rel.firstIndex(of: "/") else { return fail(task, "no session segment") }
		guard isCurrentSession(String(rel[..<slash])) else { return fail(task, "Not found", status: 404) }
		let vaultRel = String(rel[rel.index(after: slash)...])
		guard !vaultRel.isEmpty else { return fail(task, "empty path") }

		// A web PDF this session's render registered (RemotePdfStore; Clew-app
		// docs/dev/pdf-unification.md §4, §8) — desktop protocol.js's route,
		// contract for contract: GET only; only a 64-hex hash this session
		// registered (404 otherwise), so no page can name a URL for Clew to
		// fetch; `?reload=1` refetches now; a failure with no copy is a 502
		// whose JSON body names it ({error, message} — the viewer's FAILURES
		// words it); X-Clew-Remote-Fetched dates the copy, and a copy served
		// after a failed refetch says why in X-Clew-Remote-Error.
		if vaultRel.hasPrefix("__clew_remote_pdf__/") {
			guard task.request.httpMethod == "GET" else { return fail(task, "GET only", status: 405) }
			let hash = String(vaultRel.dropFirst("__clew_remote_pdf__/".count))
			guard hash.range(of: #"^[0-9a-f]{64}$"#, options: .regularExpression) != nil else {
				return fail(task, "Not found", status: 404)
			}
			let range = task.request.value(forHTTPHeaderField: "Range")
			let reload = URLComponents(url: url, resolvingAgainstBaseURL: false)?
				.queryItems?.contains { $0.name == "reload" && $0.value == "1" } ?? false
			let answer: (RemotePdfStore.Served) -> Void = { [weak self] served in
				DispatchQueue.main.async {
					guard let self, !self.isStopped(task) else { return }
					switch served {
					case .file(let file, let meta):
						let stamp = ISO8601DateFormatter()
						stamp.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
						var extra = ["Content-Type": "application/pdf",
							"X-Clew-Remote-Fetched": stamp.string(from: Date(timeIntervalSince1970: meta.fetchedAt)),
							"Access-Control-Expose-Headers": "X-Clew-Remote-Fetched, X-Clew-Remote-Error"]
						if let stale = meta.staleReason { extra["X-Clew-Remote-Error"] = Self.encodeURIComponent(stale) }
						self.respondFile(task, fileURL: file, rangeHeader: range, extra: extra)
					case .failure(let error):
						let body = (try? JSONSerialization.data(withJSONObject: ["error": error.code, "message": error.detail])) ?? Data()
						self.respond(task, status: 502, data: body, headers: self.baseHeaders(mime: "application/json"))
					}
				}
			}
			let known = reload ? RemotePdfStore.shared.refresh(hash, completion: answer)
				: RemotePdfStore.shared.serve(hash, completion: answer)
			if !known { fail(task, "Not registered in this session", status: 404) }
			return
		}

		// The render POSTs, in two layers. iOS's own first: WebKit delivers a
		// real Origin — the app page sends clew-app://app, a same-origin
		// preview document none, a sandboxed frame "null" (measured) — so
		// anything but those is refused outright. Then the rule both
		// platforms share: the session's caller token (readRenderBody).
		if task.request.httpMethod == "POST" {
			if let origin = task.request.value(forHTTPHeaderField: "Origin"),
				!Self.renderOrigins.contains(origin) {
				return fail(task, "Forbidden", status: 403)
			}
		}

		if vaultRel == "__clew_fragment__", task.request.httpMethod == "POST" {
			guard let body = readRenderBody(task) else { return }
			return renderFragment(task, markdown: body.text)
		}

		// Live edit's block frames (docs/dev/live-edit.md §7.2, protocol.js).
		// POST `{text, sourcePath}` renders the snippet as a FULL preview
		// document through the JS render service and answers `{hash}`; GET
		// `__clew_block__/<hash>` serves that document with the same client
		// injection a note gets, marked `data-clew-block` so the client
		// reports its size instead of its scroll. Same size limit as
		// fragments; an evicted hash is a 404 and the frame layer POSTs again.
		if vaultRel == "__clew_block__", task.request.httpMethod == "POST" {
			guard let body = readRenderBody(task) else { return }
			return renderBlock(task, text: body.text, sourcePath: body.sourcePath)
		}
		if vaultRel.hasPrefix("__clew_block__/"), task.request.httpMethod == "GET" {
			let hash = String(vaultRel.dropFirst("__clew_block__/".count))
			return serveBlock(task, hash: hash, sid: String(rel[..<slash]))
		}

		if vaultRel.range(of: #"\.(md|jmd)\.html$"#, options: [.regularExpression, .caseInsensitive]) != nil {
			let noteRel = String(vaultRel.dropLast(5)) // strip ".html"
			return renderNote(task, noteRel: noteRel, sid: String(rel[..<slash]))
		}

		// A raw vault file (images, media, canvas JSON, PDFs …). Evicted
		// iCloud items are downloaded on demand before serving.
		let rangeHeader = task.request.value(forHTTPHeaderField: "Range")
		vaults.ioQueue.async { [weak self] in
			guard let self else { return }
			if let file = self.vaults.materialize(rel: vaultRel, timeout: 15) {
				DispatchQueue.main.async {
					self.respondFile(task, fileURL: file, rangeHeader: rangeHeader)
				}
			} else {
				DispatchQueue.main.async { self.fail(task, "Not found", status: 404) }
			}
		}
	}

	// MARK: - Rendering through the JS engine worker

	private func renderNote(_ task: WKURLSchemeTask, noteRel: String, sid: String) {
		callNative("return await window.__clewNative.renderNote(rel);", args: ["rel": noteRel]) { [weak self] result in
			guard let self, !self.isStopped(task) else { return }
			var html: String
			switch result {
			case .success(let value):
				html = (value as? String) ?? ""
			case .failure(let error):
				// Same shape as desktop: an error document that still loads
				// the client so the pane recovers on rebuild.
				let message = Self.escapeHtml(error.localizedDescription)
				html = "<!DOCTYPE html><html><head><meta charset=\"utf-8\">"
					+ "<link rel=\"stylesheet\" href=\"/__clew_assets__/preview/preview.css\"></head>"
					+ "<body><div id=\"__clew_err\">\(message)</div></body></html>"
			}
			html = self.injectClientScripts(into: html, sid: sid)
			self.respondData(task, data: Data(html.utf8), mime: "text/html")
		}
	}

	// MARK: - The caller token

	/// The Origins a render POST may carry (none at all is fine too).
	private static let renderOrigins: Set<String> = ["clew-app://app", "clew-preview://vault"]

	private func isCurrentSession(_ sid: String) -> Bool {
		!vaults.sessionId.isEmpty && sid == vaults.sessionId
	}

	/// Port of Clew-app main/caller-token.js#readRenderBody, in its order:
	/// over 100,000 characters (UTF-16, as JavaScript counts) → 413; not JSON,
	/// or not an object → 400; the token does not match → 403, compared in
	/// constant time; `text` not a string, or `sourcePath` neither null nor
	/// a string → 400. The body is JSON whatever its Content-Type (callers
	/// send none: a JSON type would make the request non-simple, and a
	/// preflight is an OPTIONS request this handler does not answer).
	/// Fails the task and returns nil when refused.
	private func readRenderBody(_ task: WKURLSchemeTask) -> (text: String, sourcePath: String?)? {
		// Decoded as desktop reads it: text, invalid bytes replaced.
		let body = String(decoding: task.request.httpBody ?? Data(), as: UTF8.self)
		guard body.utf16.count <= 100_000 else { fail(task, "Too large", status: 413); return nil }
		let parsed = try? JSONSerialization.jsonObject(with: Data(body.utf8), options: [.fragmentsAllowed])
		// JavaScript's `typeof x === 'object'` holds for arrays too: an array
		// has no token, so it is refused as desktop refuses it — 403.
		if parsed is [Any] { fail(task, "Forbidden", status: 403); return nil }
		guard let object = parsed as? [String: Any] else { fail(task, "Bad request", status: 400); return nil }
		guard Self.tokenMatches(vaults.callerToken, object["token"] as? String) else {
			fail(task, "Forbidden", status: 403)
			return nil
		}
		guard let text = object["text"] as? String else { fail(task, "Bad request", status: 400); return nil }
		switch object["sourcePath"] {
		case nil, is NSNull: return (text, nil)
		case let path as String: return (text, path)
		default: fail(task, "Bad request", status: 400); return nil
		}
	}

	/// Constant-time: a wrong token takes as long to refuse as a nearly right one.
	private static func tokenMatches(_ expected: String, _ given: String?) -> Bool {
		guard !expected.isEmpty, let given else { return false }
		let a = Array(expected.utf8), b = Array(given.utf8)
		guard a.count == b.count else { return false }
		var diff: UInt8 = 0
		for i in 0..<a.count { diff |= a[i] ^ b[i] }
		return diff == 0
	}

	private func renderFragment(_ task: WKURLSchemeTask, markdown: String) {
		callNative("return await window.__clewNative.renderFragment(text);", args: ["text": markdown]) { [weak self] result in
			guard let self, !self.isStopped(task) else { return }
			switch result {
			case .success(let value):
				self.respondData(task, data: Data(((value as? String) ?? "").utf8), mime: "text/html")
			case .failure(let error):
				self.fail(task, error.localizedDescription, status: 500)
			}
		}
	}

	private func renderBlock(_ task: WKURLSchemeTask, text: String, sourcePath: String?) {
		// Every key becomes a parameter of the async function callNative
		// builds, so the argument must be present even when there is no
		// source note: an empty string, which the script reads as null.
		let args: [String: Any] = ["text": text, "sourcePath": sourcePath ?? ""]
		callNative("return await window.__clewNative.renderBlock(text, sourcePath || null);", args: args) { [weak self] result in
			guard let self, !self.isStopped(task) else { return }
			switch result {
			case .success(let value):
				guard let hash = value as? String else { return self.fail(task, "no hash", status: 500) }
				let payload = try! JSONSerialization.data(withJSONObject: ["hash": hash])
				self.respondData(task, data: payload, mime: "application/json")
			case .failure(let error):
				// vaults.resolve() refused the sourcePath: outside the vault.
				// WebKit wraps a thrown JS error as WKErrorDomain 4 with the
				// message in userInfo, not in localizedDescription.
				let message = Self.jsErrorMessage(error)
				let forbidden = message.contains("escapes vault") || message.contains("No vault open")
				self.fail(task, message, status: forbidden ? 403 : 500)
			}
		}
	}

	private func serveBlock(_ task: WKURLSchemeTask, hash: String, sid: String) {
		guard hash.range(of: #"^[0-9a-f]{1,40}$"#, options: .regularExpression) != nil else {
			return fail(task, "Not found", status: 404)
		}
		callNative("return await window.__clewNative.blockDocument(hash);", args: ["hash": hash]) { [weak self] result in
			guard let self, !self.isStopped(task) else { return }
			switch result {
			case .success(let value):
				guard let html = value as? String else { return self.fail(task, "Not found", status: 404) }
				let injected = self.injectClientScripts(into: html, sid: sid, block: true)
				self.respondData(task, data: Data(injected.utf8), mime: "text/html")
			case .failure(let error):
				self.fail(task, error.localizedDescription, status: 500)
			}
		}
	}

	private func callNative(_ script: String, args: [String: Any],
		completion: @escaping (Result<Any?, Error>) -> Void) {
		DispatchQueue.main.async {
			guard let webView = self.webView else {
				return completion(.failure(ClewError.noVault))
			}
			webView.callAsyncJavaScript(script, arguments: args, in: nil, in: .page) { result in
				completion(result.map { $0 as Any? })
			}
		}
	}

	/// Enabled plugins (vault-settings.json `plugins` array) with their
	/// folder and manifest surfaces — the Swift twin of main/plugins.js,
	/// including its two roots: the vault's .clew/plugins/<id>/ first, then
	/// the global Documents/Plugins/<id>/ (a vault plugin SHADOWS a global
	/// one of the same id). Installing is global; enabling is per vault.
	private func enabledPlugins() -> [(id: String, scope: String, dir: URL, surfaces: [String: String])] {
		guard let vault = vaults.currentVaultPath else { return [] }
		let base = URL(fileURLWithPath: vault)
		guard let settingsData = try? Data(contentsOf: base.appendingPathComponent(".clew/vault-settings.json")),
			let settings = try? JSONSerialization.jsonObject(with: settingsData) as? [String: Any],
			let enabled = settings["plugins"] as? [String] else { return [] }
		return enabled.compactMap { id in
			guard id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil else { return nil }
			let roots: [(scope: String, dir: URL)] = [
				("vault", base.appendingPathComponent(".clew/plugins/\(id)", isDirectory: true)),
				("global", vaults.globalPluginsURL.appendingPathComponent(id, isDirectory: true)),
			]
			for root in roots {
				guard let surfaces = Self.manifestSurfaces(at: root.dir), !surfaces.isEmpty else { continue }
				return (id: id, scope: root.scope, dir: root.dir, surfaces: surfaces)
			}
			return nil
		}
	}

	/// A plugin folder's manifest surfaces as {surface: file}, or nil when
	/// there is no readable manifest there. A surface is either "file.js" or
	/// { "file": "file.js", … } — the engine surface uses the dict form
	/// (plugins.js accepts both for any surface), so a per-key cast is
	/// required: a whole-dictionary [String: String] cast dies on the FIRST
	/// dict-form surface and silently drops every surface the plugin has.
	/// Files with a path in them are refused, as plugins.js refuses them.
	private static func manifestSurfaces(at dir: URL) -> [String: String]? {
		guard let manifestData = try? Data(contentsOf: dir.appendingPathComponent("manifest.json")),
			let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
			let rawSurfaces = manifest["surfaces"] as? [String: Any] else { return nil }
		var surfaces: [String: String] = [:]
		for (key, value) in rawSurfaces {
			let file: String?
			if let name = value as? String {
				file = name
			} else if let spec = value as? [String: Any], let name = spec["file"] as? String {
				file = name
			} else {
				file = nil
			}
			if let file, !file.contains("/"), !file.contains("..") { surfaces[key] = file }
		}
		return surfaces
	}

	/// Port of protocol.js script injection (wrapPreviewDocument): the note
	/// API into <head>, the client bridge + vault scripts + enabled
	/// preview-surface plugin scripts before </body>. One function for notes
	/// and live edit's block documents, so the two cannot drift; a block is
	/// marked `data-clew-block` on its <html>, which is what makes the client
	/// report its height instead of its scroll.
	private func injectClientScripts(into html: String, sid: String, block: Bool = false) -> String {
		var out = html
		if block, let htmlRange = out.range(of: "<html[^>]*>", options: [.regularExpression, .caseInsensitive]) {
			let tag = String(out[htmlRange])
			out.replaceSubrange(htmlRange, with: String(tag.dropLast()) + " data-clew-block=\"1\">")
		}
		if let headRange = out.range(of: "<head[^>]*>", options: [.regularExpression, .caseInsensitive]) {
			out.replaceSubrange(headRange, with: out[headRange] + "<script src=\"/__clew_preview__/api.js\"></script>")
		}
		var tags = "<script src=\"/__clew_preview__/client.js\"></script>"
		if let vault = vaults.currentVaultPath {
			let scriptsDir = URL(fileURLWithPath: vault).appendingPathComponent(".clew/scripts")
			if let names = try? FileManager.default.contentsOfDirectory(atPath: scriptsDir.path) {
				for name in names.filter({ $0.hasSuffix(".js") }).sorted() {
					let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
					tags += "<script src=\"/\(sid)/.clew/scripts/\(encoded)\"></script>"
				}
			}
		}
		for plugin in enabledPlugins() {
			if let previewFile = plugin.surfaces["preview"] {
				// A vault plugin loads as ordinary vault content; a global one
				// from the __clew_plugin_file__ namespace. Either way the
				// script's own URL sits in its plugin folder, so a sibling
				// loaded relative to document.currentScript.src works in both.
				tags += plugin.scope == "global"
					? "<script src=\"/__clew_plugin_file__/\(sid)/\(plugin.id)/\(previewFile)\"></script>"
					: "<script src=\"/\(sid)/.clew/plugins/\(plugin.id)/\(previewFile)\"></script>"
			}
		}
		if let bodyRange = out.range(of: "</body>", options: [.caseInsensitive, .backwards]) {
			out.replaceSubrange(bodyRange, with: tags + "</body>")
		} else {
			out += tags
		}
		return out
	}

	// MARK: - Responses

	private func baseHeaders(mime: String, extra: [String: String] = [:]) -> [String: String] {
		var headers = [
			"Content-Type": mime,
			"Cache-Control": "no-store",
			// Cross-origin reads for the app page alone (agreed with Clew-app,
			// frame-bridge.md §2.6; measured: every consumer still works, and a
			// sandboxed frame reads nothing). Same-origin preview reads need
			// none; a constant, so no Vary.
			"Access-Control-Allow-Origin": "clew-app://app",
			"Accept-Ranges": "bytes",
		]
		for (key, value) in extra { headers[key] = value }
		return headers
	}

	private func respondFile(_ task: WKURLSchemeTask, fileURL: URL, rangeHeader: String?, extra: [String: String] = [:]) {
		DispatchQueue.global(qos: .userInitiated).async {
			guard let data = try? Data(contentsOf: fileURL, options: .mappedIfSafe) else {
				return DispatchQueue.main.async { self.fail(task, "Not found", status: 404) }
			}
			let mime = Self.mimeTypes[fileURL.pathExtension.lowercased()] ?? "application/octet-stream"
			DispatchQueue.main.async {
				// Byte ranges: WebKit's media stack needs 206s to scrub
				// audio/video, exactly like Chromium (protocol.js).
				if let range = rangeHeader,
					let match = range.range(of: #"^bytes=(\d*)-(\d*)$"#, options: .regularExpression) {
					let spec = String(range[match]).dropFirst("bytes=".count)
					let parts = spec.split(separator: "-", maxSplits: 1, omittingEmptySubsequences: false)
					let size = data.count
					var start = parts.count > 0 && !parts[0].isEmpty ? Int(parts[0]) ?? 0 : -1
					var end = parts.count > 1 && !parts[1].isEmpty ? Int(parts[1]) ?? size - 1 : size - 1
					if start == -1 { // suffix form bytes=-N
						start = max(0, size - (Int(parts[1]) ?? 0))
						end = size - 1
					}
					guard start <= end, start < size else {
						return self.respond(task, status: 416, data: Data(),
							headers: self.baseHeaders(mime: mime, extra: ["Content-Range": "bytes */\(size)"]))
					}
					end = min(end, size - 1)
					let chunk = data.subdata(in: start..<(end + 1))
					return self.respond(task, status: 206, data: chunk, headers: self.baseHeaders(mime: mime, extra: [
						"Content-Range": "bytes \(start)-\(end)/\(size)",
						"Content-Length": String(chunk.count),
					]))
				}
				self.respondData(task, data: data, mime: mime, extra: extra)
			}
		}
	}

	private func respondData(_ task: WKURLSchemeTask, data: Data, mime: String, extra: [String: String] = [:]) {
		respond(task, status: 200, data: data, headers: baseHeaders(mime: mime, extra: extra))
	}

	private func respond(_ task: WKURLSchemeTask, status: Int, data: Data, headers: [String: String]) {
		guard !isStopped(task), let url = task.request.url else { return }
		let response = HTTPURLResponse(url: url, statusCode: status, httpVersion: "HTTP/1.1", headerFields: headers)!
		task.didReceive(response)
		task.didReceive(data)
		task.didFinish()
		stoppedTasks.remove(ObjectIdentifier(task))
	}

	private func fail(_ task: WKURLSchemeTask, _ message: String, status: Int = 500) {
		respond(task, status: status, data: Data(message.utf8),
			headers: baseHeaders(mime: "text/plain"))
	}

	/// The JavaScript error's own message, when callAsyncJavaScript fails
	/// on a thrown exception (WKErrorDomain code 4 carries it in userInfo).
	private static func jsErrorMessage(_ error: Error) -> String {
		let ns = error as NSError
		if let message = ns.userInfo["WKJavaScriptExceptionMessage"] as? String, !message.isEmpty {
			return message
		}
		return ns.localizedDescription
	}

	/// JavaScript's encodeURIComponent: everything but A–Z a–z 0–9 and
	/// `-_.!~*'()` percent-encoded as UTF-8 (the viewer decodes the header
	/// with decodeURIComponent, as desktop's route encodes it).
	static func encodeURIComponent(_ text: String) -> String {
		var allowed = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789")
		allowed.insert(charactersIn: "-_.!~*'()")
		return text.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
	}

	private static func escapeHtml(_ text: String) -> String {
		text.replacingOccurrences(of: "&", with: "&amp;")
			.replacingOccurrences(of: "<", with: "&lt;")
	}
}
