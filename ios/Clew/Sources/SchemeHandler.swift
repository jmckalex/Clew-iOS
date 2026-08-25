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
		"pdfjs": "preview-assets/pdfjs",
		"embedpdf": "preview-assets/embedpdf",
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
			let parts = rest.split(separator: "/", maxSplits: 1).map(String.init)
			guard parts.count == 2, let base = Self.assetRoots[parts[0]], let webRoot = webRootURL else {
				return fail(task, "unknown asset root")
			}
			let file = webRoot.appendingPathComponent(base).appendingPathComponent(parts[1]).standardizedFileURL
			guard file.path.hasPrefix(webRoot.standardizedFileURL.path) else { return fail(task, "forbidden") }
			return respondFile(task, fileURL: file, rangeHeader: task.request.value(forHTTPHeaderField: "Range"))
		}

		if rel.hasPrefix("__clew_preview__/") {
			guard let webRoot = webRootURL else { return fail(task, "WebRoot missing") }
			let file = rel.hasSuffix("/api.js") ? "api.js" : "client.js"
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
			guard let plugin = enabledPlugins().first(where: { $0.id == id }),
				let appFile = plugin.surfaces["app"],
				let vault = vaults.currentVaultPath,
				let code = try? String(contentsOf: URL(fileURLWithPath: vault)
					.appendingPathComponent(".clew/plugins/\(id)/\(appFile)"), encoding: .utf8) else {
				return fail(task, "not an enabled plugin", status: 403)
			}
			let idJson = String(data: try! JSONEncoder().encode(id), encoding: .utf8)!
			let wrapped = "(function (clew) {\n'use strict';\n\(code)\n})(window.__clewPluginApi?.[\(idJson)]);"
			return respondData(task, data: Data(wrapped.utf8), mime: "text/javascript")
		}

		// Everything else: /<sid>/<vault path>.
		guard let slash = rel.firstIndex(of: "/") else { return fail(task, "no session segment") }
		let vaultRel = String(rel[rel.index(after: slash)...])
		guard !vaultRel.isEmpty else { return fail(task, "empty path") }

		if vaultRel == "__clew_fragment__", task.request.httpMethod == "POST" {
			let text = task.request.httpBody.flatMap { String(data: $0, encoding: .utf8) } ?? ""
			return renderFragment(task, markdown: text)
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

	private func renderFragment(_ task: WKURLSchemeTask, markdown: String) {
		guard markdown.count <= 100_000 else { return fail(task, "too large", status: 413) }
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
	/// manifest surfaces — the Swift twin of main/plugins.js.
	private func enabledPlugins() -> [(id: String, surfaces: [String: String])] {
		guard let vault = vaults.currentVaultPath else { return [] }
		let base = URL(fileURLWithPath: vault)
		guard let settingsData = try? Data(contentsOf: base.appendingPathComponent(".clew/vault-settings.json")),
			let settings = try? JSONSerialization.jsonObject(with: settingsData) as? [String: Any],
			let enabled = settings["plugins"] as? [String] else { return [] }
		return enabled.compactMap { id in
			guard id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
				let manifestData = try? Data(contentsOf: base.appendingPathComponent(".clew/plugins/\(id)/manifest.json")),
				let manifest = try? JSONSerialization.jsonObject(with: manifestData) as? [String: Any],
				let surfaces = manifest["surfaces"] as? [String: String] else { return nil }
			return (id: id, surfaces: surfaces)
		}
	}

	/// Port of protocol.js script injection: the note API into <head>, the
	/// client bridge + vault scripts + enabled preview-surface plugin
	/// scripts before </body>.
	private func injectClientScripts(into html: String, sid: String) -> String {
		var out = html
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
				tags += "<script src=\"/\(sid)/.clew/plugins/\(plugin.id)/\(previewFile)\"></script>"
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
			"Access-Control-Allow-Origin": "*",
			"Accept-Ranges": "bytes",
		]
		for (key, value) in extra { headers[key] = value }
		return headers
	}

	private func respondFile(_ task: WKURLSchemeTask, fileURL: URL, rangeHeader: String?) {
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
				self.respondData(task, data: data, mime: mime)
			}
		}
	}

	private func respondData(_ task: WKURLSchemeTask, data: Data, mime: String) {
		respond(task, status: 200, data: data, headers: baseHeaders(mime: mime))
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

	private static func escapeHtml(_ text: String) -> String {
		text.replacingOccurrences(of: "&", with: "&amp;")
			.replacingOccurrences(of: "<", with: "&lt;")
	}
}
