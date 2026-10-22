// The export host (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1): a hidden WKWebView
// of its own on the preview scheme, which runs one export in the export
// worker (src/export/) and hands its outputs back through the scheme handler.
//
// Why a web view of its own, not a frame in the app page: WebKit gives it a
// WebContent process of its own, so a TeX run that outgrows what iOS allows
// a page (a LuaLaTeX pass is ~550 MiB on a Mac) is killed THERE, and is
// reported as such, while the editor and its unsaved text carry on. And why
// the preview scheme: WebAssembly runs only in clew-preview documents (their
// CSP has 'wasm-unsafe-eval'); the app page has run none since the 0.8 sync.
//
// The page has no bridge (its configuration adds no message handler) and
// may navigate nowhere but its own document. Its requests under
// /__clew_export__/ are answered only for THIS web view (SchemeHandler.swift
// passes the requesting view): the page, its script and its worker from the
// WebRoot's export/ folder; the job, once, for its token; each output as the
// body of a POST; then `done`. And a trusted vault's export figure cache:
// listed, read, added to and marked used (`cache/`, `cacheused/`). The rules
// live in ExportJobs.swift.
//
// Like PdfPrinter, the view sits behind everything in the app's window, at a
// point's size: in a window, so WebKit runs it as a live page, and never seen.
import Foundation
import UIKit
import WebKit

final class ExportHost: NSObject, WKNavigationDelegate {
	/// As desktop's compilePdf: three minutes, then the export is stopped.
	static let timeout: TimeInterval = 180

	/// The limit this run uses: `timeout`, or — in a Debug build only — the
	/// `ClewExportTimeout` default in seconds, so the simulator can test the
	/// stop without waiting three minutes (UPSTREAM-LATEX-EXPORT-PLAN.md §5).
	static var limit: TimeInterval {
		#if DEBUG
		let override = UserDefaults.standard.double(forKey: "ClewExportTimeout")
		if override > 0 { return override }
		#endif
		return timeout
	}

	/// "3 minutes", or a shorter Debug limit in seconds.
	static func limitWords(_ seconds: TimeInterval) -> String {
		seconds >= 60 && seconds.truncatingRemainder(dividingBy: 60) == 0
			? "\(Int(seconds / 60)) minute\(seconds == 60 ? "" : "s")" : "\(Int(seconds)) seconds"
	}

	/// Every response here carries it: the page runs only its own script and
	/// the worker it starts, and may fetch only its own origin (the job, the
	/// outputs, the engines' files).
	static let csp = [
		"default-src 'none'", "script-src 'self'", "worker-src 'self'",
		"connect-src 'self'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'",
	].joined(separator: "; ")

	/// The worker's own (a worker takes its policy from its script's
	/// response): the engine evaluates strings as code when it loads, as the
	/// render worker's does (measured: "Refused to evaluate a string as
	/// JavaScript" without 'unsafe-eval'), and mp-tikz-wasm compiles
	/// WebAssembly. Its network is its own origin all the same.
	static let workerCsp = [
		"default-src 'none'", "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
		"connect-src 'self'", "base-uri 'none'",
	].joined(separator: "; ")

	let jobs: ExportJobs
	/// A vault file by its vault-relative path, clamped to the vault and
	/// downloaded if evicted (WebHost: VaultStore.materialize), or nil. The
	/// `vault/` route reads through it, never a path of its own.
	var vaultFile: ((String) -> URL?)?
	/// The export figure cache (ExportJobs.swift#ExportCache), when the app
	/// has one: a trusted vault's jobs list, read and add to it.
	var cache: ExportCache?
	private(set) var webView: WKWebView?
	private var completion: ((Result<ExportJobs.Done, Error>) -> Void)?
	private var deadline: DispatchWorkItem?
	private var pageURL: URL?

	init(jobs: ExportJobs) {
		self.jobs = jobs
		super.init()
	}

	var isBusy: Bool { webView != nil }

	/// One export: `job` is the JSON the app page built (src/shim/export-job.js);
	/// `cacheVault` the identity of the trusted vault whose figure cache it may
	/// use, or nil (a restricted vault's figures stay in the worker).
	func run(job: Data, cacheVault: String? = nil, schemeHandler: WKURLSchemeHandler, in window: UIWindow,
		completion: @escaping (Result<ExportJobs.Done, Error>) -> Void) {
		guard !isBusy else { return completion(.failure(ExportJobs.Failure.busy)) }
		// Between exports, never during one (desktop's rule): nothing a build
		// lists is removed while it reads.
		cache?.prune()
		let token: String
		do { token = try jobs.begin(job: job, cacheVault: cache == nil ? nil : cacheVault) } catch { return completion(.failure(error)) }
		let config = WKWebViewConfiguration()
		config.setURLSchemeHandler(schemeHandler, forURLScheme: "clew-preview")
		// Nothing of the page outlives it: no cookies, storage or caches.
		config.websiteDataStore = .nonPersistent()
		let view = WKWebView(frame: CGRect(x: 0, y: 0, width: 1, height: 1), configuration: config)
		view.navigationDelegate = self
		window.insertSubview(view, at: 0)
		let url = URL(string: "clew-preview://vault/__clew_export__/host.html?job=\(token)")!
		self.webView = view
		self.pageURL = url
		self.completion = completion
		let limit = Self.limit
		let deadline = DispatchWorkItem { [weak self] in
			self?.complete(.failure(ClewError.message("The export took too long (more than \(Self.limitWords(limit))) and was stopped")))
		}
		self.deadline = deadline
		DispatchQueue.main.asyncAfter(deadline: .now() + limit, execute: deadline)
		view.load(URLRequest(url: url))
	}

	/// The app is leaving the vault, or the export is no longer wanted.
	func cancel(_ why: String = "The export was cancelled") {
		guard isBusy else { return }
		complete(.failure(ClewError.message(why)))
	}

	// MARK: - The page's requests (SchemeHandler.swift, /__clew_export__/…)

	/// Answers `rel` (the path after `__clew_export__/`) for the export host's
	/// own web view; anything else is refused.
	func serve(_ task: WKURLSchemeTask, rel: String, url: URL, from requester: WKWebView,
		respond: @escaping (WKURLSchemeTask, Int, Data, [String: String]) -> Void) {
		let json = { (status: Int, body: [String: Any]) in
			respond(task, status, (try? JSONSerialization.data(withJSONObject: body)) ?? Data("{}".utf8),
				["Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": Self.csp])
		}
		guard let webView, requester === webView else { return json(403, ["error": "Forbidden"]) }
		let parts = rel.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
		let method = task.request.httpMethod ?? "GET"
		switch (method, parts.first ?? "", parts.count) {
		case ("GET", "host.html", 1), ("GET", "host.js", 1), ("GET", "export-worker.js", 1):
			guard let file = Bundle.main.url(forResource: "WebRoot", withExtension: nil)?
				.appendingPathComponent("export").appendingPathComponent(parts[0]),
				let data = try? Data(contentsOf: file) else { return json(404, ["error": "Not found"]) }
			let mime = parts[0].hasSuffix(".html") ? "text/html" : "text/javascript"
			let csp = parts[0] == "export-worker.js" ? Self.workerCsp : Self.csp
			respond(task, 200, data, ["Content-Type": mime, "Cache-Control": "no-store", "Content-Security-Policy": csp])
		case ("GET", "job", 2):
			do {
				let job = try jobs.takeJob(token: parts[1])
				respond(task, 200, job, ["Content-Type": "application/json", "Cache-Control": "no-store", "Content-Security-Policy": Self.csp])
			} catch {
				json(403, ["error": error.localizedDescription])
			}
		case ("GET", "vault", let n) where n >= 3:
			// PDF via LaTeX: an image the .tex names, for TeX (the worker's
			// vaultFile, src/export/export-worker.js). Only for this job's
			// token and only an image graphicx typesets, nothing hidden
			// (ExportJobs.mayRead), clamped to the vault by vaultFile.
			let rel = parts[2...].joined(separator: "/")
			guard jobs.mayRead(token: parts[1], rel: rel), let vaultFile else { return json(403, ["error": "Forbidden"]) }
			DispatchQueue.global(qos: .userInitiated).async {
				var data: Data?
				if let url = vaultFile(rel) {
					var coordinationError: NSError?
					NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &coordinationError) { data = try? Data(contentsOf: $0) }
				}
				DispatchQueue.main.async {
					guard let data else { return json(404, ["error": "Not found"]) }
					respond(task, 200, data, ["Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": Self.csp])
				}
			}
		case ("GET", "cache", 2):
			// The vault's cached figures, for the worker to install as files it
			// reads only when the figure engine does; none for a restricted
			// vault's job, whose figures stay in the worker.
			guard let identity = jobs.cacheVault(token: parts[1]), let cache else { return json(200, ["files": []]) }
			json(200, ["files": cache.list(identity: identity).map { ["rel": $0.rel, "bytes": $0.bytes] }])
		case ("GET", "cache", 4):
			let rel = parts[2...].joined(separator: "/")
			guard let identity = jobs.cacheVault(token: parts[1]), let cache, let file = cache.url(identity: identity, rel: rel),
				let data = try? Data(contentsOf: file) else { return json(404, ["error": "Not found"]) }
			respond(task, 200, data, ["Content-Type": "application/octet-stream", "Cache-Control": "no-store", "Content-Security-Policy": Self.csp])
		case ("POST", "cache", 2):
			// A figure the build drew, kept for the vault's next export.
			let rel = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?.first { $0.name == "rel" }?.value ?? ""
			let body = task.request.httpBody ?? Self.readStream(task.request.httpBodyStream) ?? Data()
			guard let identity = jobs.cacheVault(token: parts[1]), let cache, body.count <= 64 * 1024 * 1024 else { return json(403, ["error": "Forbidden"]) }
			do {
				try cache.store(identity: identity, rel: rel, data: body)
				json(200, ["ok": true])
			} catch {
				json(400, ["error": error.localizedDescription])
			}
		case ("POST", "cacheused", 2):
			// The cached figures the export used: the prune keeps them longest.
			let body = task.request.httpBody ?? Self.readStream(task.request.httpBodyStream) ?? Data()
			guard let identity = jobs.cacheVault(token: parts[1]), let cache,
				let rels = (try? JSONSerialization.jsonObject(with: body)) as? [String] else { return json(200, ["ok": false]) }
			cache.markUsed(identity: identity, rels: rels)
			json(200, ["ok": true])
		case ("POST", "out", 2):
			let query = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems
			let rel = query?.first { $0.name == "rel" }?.value ?? ""
			let body = task.request.httpBody ?? Self.readStream(task.request.httpBodyStream) ?? Data()
			do {
				try jobs.write(token: parts[1], rel: rel, data: body)
				json(200, ["ok": true])
			} catch {
				json(400, ["error": error.localizedDescription])
				complete(.failure(error))
			}
		case ("POST", "done", 2):
			let body = task.request.httpBody ?? Self.readStream(task.request.httpBodyStream) ?? Data()
			do {
				let done = try jobs.finish(token: parts[1], body: body)
				json(200, ["ok": true])
				complete(.success(done), jobEnded: true)
			} catch {
				json(200, ["ok": false])
				complete(.failure(error))
			}
		default:
			json(404, ["error": "Not found"])
		}
	}

	// MARK: - WKNavigationDelegate

	/// Its own document, and nothing else, ever: no other page, no frame.
	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		guard let frame = navigationAction.targetFrame, frame.isMainFrame else { return decisionHandler(.cancel) }
		decisionHandler(navigationAction.request.url == pageURL ? .allow : .cancel)
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		complete(.failure(error))
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		complete(.failure(error))
	}

	/// iOS ended the page's process: jetsam, most likely, for memory.
	func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
		complete(.failure(ClewError.message("The export stopped: iOS ended its page, most likely because it ran out of memory")))
	}

	// MARK: -

	private func complete(_ result: Result<ExportJobs.Done, Error>, jobEnded: Bool = false) {
		guard let done = completion else { return }
		completion = nil
		deadline?.cancel()
		deadline = nil
		if !jobEnded { jobs.abandon() }
		webView?.navigationDelegate = nil
		webView?.stopLoading()
		webView?.removeFromSuperview()
		webView = nil
		pageURL = nil
		done(result)
	}

	private static func readStream(_ stream: InputStream?) -> Data? {
		guard let stream else { return nil }
		stream.open()
		defer { stream.close() }
		var data = Data()
		var buffer = [UInt8](repeating: 0, count: 1 << 16)
		while stream.hasBytesAvailable {
			let n = stream.read(&buffer, maxLength: buffer.count)
			if n <= 0 { break }
			data.append(buffer, count: n)
		}
		return data
	}
}
