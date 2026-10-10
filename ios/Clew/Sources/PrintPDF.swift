// "Export as PDF (reading view)": the note's own clew-preview:// document,
// loaded in a hidden WKWebView on the app's preview scheme, paginated by
// UIKit's print machinery once the page says it has settled — the iOS
// twin of main/print-pdf.js, whose hidden BrowserWindow + printToPDF this
// replaces. The arm and ready-probe scripts arrive from the JS side
// (src/shim/print-pdf.js), so the two ports cannot drift on what "settled"
// means: MathJax done, fonts loaded, every mermaid block an <svg>, no
// TikZ/MetaPost figure still typesetting.
//
// The web view is a real subview of the app's window (behind the app, at
// the paper's printable width) rather than an orphan: WebKit lays out and
// paints only views that are in a window, and the print formatter draws
// what has been laid out.
//
// "Export as HTML" uses the same settled document: snapshot() runs the
// script src/shim/html-share.js sends, in a content world of its own (the
// note's scripts share the page's DOM with it, never its functions), and
// hands back the page it serialized instead of printing.
import UIKit
import WebKit

final class PdfPrinter: NSObject, WKNavigationDelegate {
	struct Request {
		let url: URL
		let paperSize: String
		let armScript: String
		let readyProbe: String
		let lightThemeScript: String
		/// The session's caller token, for the document's render POSTs (a
		/// canvas scene's cards): a top-level document has no host to ask.
		let callerToken: String
	}

	/// PostScript points: the sizes upstream's printToPDF names.
	private static let papers: [String: CGSize] = [
		"a4": CGSize(width: 595.2, height: 841.8),
		"letter": CGSize(width: 612, height: 792),
		"legal": CGSize(width: 612, height: 1008),
		"tabloid": CGSize(width: 792, height: 1224),
	]
	/// 0.6 in on every edge, as upstream.
	private static let margin: CGFloat = 0.6 * 72
	private static let readyTimeout: TimeInterval = 30
	private static let pollInterval: TimeInterval = 0.15
	/// WebKit keeps painting for a beat after the last promise settles.
	private static let settle: TimeInterval = 0.35

	/// A snapshot's script (an async function body) and its arguments.
	struct Snapshot {
		let script: String
		let arguments: [String: Any]
	}
	/// A reading pane's width, so the page lays out as reading view does.
	private static let snapshotSize = CGSize(width: 820, height: 1180)
	private static let snapshotWorld = WKContentWorld.world(name: "clew-share")

	private var webView: WKWebView?
	private var request: Request?
	private var completion: ((Result<Data, Error>) -> Void)?
	private var snapshot: Snapshot?
	private var snapshotCompletion: ((Result<[String: Any], Error>) -> Void)?
	private var deadline = Date()

	/// One print at a time; a second request while one runs is refused.
	var isBusy: Bool { webView != nil }

	func print(_ request: Request, schemeHandler: WKURLSchemeHandler, in window: UIWindow,
		completion: @escaping (Result<Data, Error>) -> Void) {
		guard !isBusy else { return completion(.failure(ClewError.printBusy)) }
		let paper = Self.papers[request.paperSize.lowercased()] ?? Self.papers["a4"]!
		let printable = CGRect(x: Self.margin, y: Self.margin,
			width: paper.width - 2 * Self.margin, height: paper.height - 2 * Self.margin)
		self.completion = completion
		load(request, size: printable.size, schemeHandler: schemeHandler, in: window)
	}

	/// The settled document serialized by `snapshot.script`, which returns
	/// a dictionary ({ html, stats }); one at a time, with print().
	func snapshot(_ request: Request, _ snapshot: Snapshot, schemeHandler: WKURLSchemeHandler, in window: UIWindow,
		completion: @escaping (Result<[String: Any], Error>) -> Void) {
		guard !isBusy else { return completion(.failure(ClewError.printBusy)) }
		self.snapshot = snapshot
		self.snapshotCompletion = completion
		load(request, size: Self.snapshotSize, schemeHandler: schemeHandler, in: window)
	}

	private func load(_ request: Request, size: CGSize, schemeHandler: WKURLSchemeHandler, in window: UIWindow) {
		// Its own configuration on the SAME preview scheme handler: the
		// document, its assets and its rendered HTML come from the running
		// app exactly as the reading pane's do. No bridge, no console hook.
		let config = WKWebViewConfiguration()
		config.setURLSchemeHandler(schemeHandler, forURLScheme: "clew-preview")
		let view = WKWebView(frame: CGRect(origin: .zero, size: size), configuration: config)
		view.navigationDelegate = self
		view.isOpaque = true
		view.backgroundColor = .white
		// Behind everything the app shows, so it is in the window (laid out
		// and painted) without ever being seen.
		window.insertSubview(view, at: 0)

		self.webView = view
		self.request = request
		self.deadline = Date().addingTimeInterval(Self.readyTimeout)
		view.load(URLRequest(url: request.url))
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		guard let request else { return finish(.failure(ClewError.printFailed("no request"))) }
		webView.evaluateJavaScript(request.armScript) { _, _ in
			webView.evaluateJavaScript(request.lightThemeScript) { _, _ in
				// §1's self-post (Clew-app frame-bridge.md): at the top level
				// `window.parent` is the document itself, which is the only
				// sender its client believes. Hex only, so nothing to escape.
				let token = request.callerToken.allSatisfy(\.isHexDigit) ? request.callerToken : ""
				webView.evaluateJavaScript("window.postMessage({ source: 'clew-preview-host', type: 'caller-token', token: '\(token)' }, 'clew-preview://vault')") { _, _ in
					self.poll()
				}
			}
		}
	}

	/// The note's own document and nothing else in the main frame: a note's
	/// `<meta http-equiv=refresh>`, or a script setting `location`, must not
	/// put another page into the PDF or the share (measured: a refresh to
	/// example.com was shared in the note's place). Frames inside the page
	/// load as they do in reading view; new windows never open.
	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		guard let frame = navigationAction.targetFrame else { return decisionHandler(.cancel) }
		guard frame.isMainFrame else { return decisionHandler(.allow) }
		decisionHandler(Self.isDocument(navigationAction.request.url, of: request?.url) ? .allow : .cancel)
	}

	/// The same document, its fragment aside.
	static func isDocument(_ url: URL?, of wanted: URL?) -> Bool {
		guard let url, let wanted,
			var a = URLComponents(url: url, resolvingAgainstBaseURL: false),
			var b = URLComponents(url: wanted, resolvingAgainstBaseURL: false) else { return false }
		a.fragment = nil
		b.fragment = nil
		return a.url == b.url
	}

	func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
		finish(.failure(error))
	}

	func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
		finish(.failure(error))
	}

	private func poll() {
		guard let webView, let request else { return }
		webView.evaluateJavaScript(request.readyProbe) { result, _ in
			let ready = (result as? Bool) ?? false
			if ready || Date() > self.deadline {
				// Print what there is rather than nothing, after the settle.
				DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle) {
					if self.snapshot != nil { self.serialize() } else { self.render() }
				}
			} else {
				DispatchQueue.main.asyncAfter(deadline: .now() + Self.pollInterval) { self.poll() }
			}
		}
	}

	private func render() {
		guard let webView, let request else { return }
		let paper = Self.papers[request.paperSize.lowercased()] ?? Self.papers["a4"]!
		let paperRect = CGRect(origin: .zero, size: paper)
		let printable = paperRect.insetBy(dx: Self.margin, dy: Self.margin)

		let renderer = UIPrintPageRenderer()
		renderer.setValue(paperRect, forKey: "paperRect")
		renderer.setValue(printable, forKey: "printableRect")
		renderer.addPrintFormatter(webView.viewPrintFormatter(), startingAtPageAt: 0)

		let data = NSMutableData()
		UIGraphicsBeginPDFContextToData(data, paperRect, nil)
		let pages = renderer.numberOfPages
		for page in 0..<pages {
			UIGraphicsBeginPDFPage()
			renderer.drawPage(at: page, in: paperRect)
		}
		UIGraphicsEndPDFContext()
		if pages == 0 || data.length == 0 {
			return finish(.failure(ClewError.printFailed("the printer returned an empty document")))
		}
		finish(.success(data as Data))
	}

	private func serialize() {
		guard let webView, let snapshot else { return }
		guard Self.isDocument(webView.url, of: request?.url) else {
			return finishSnapshot(.failure(ClewError.printFailed("the note's page navigated away")))
		}
		webView.callAsyncJavaScript(snapshot.script, arguments: snapshot.arguments, in: nil, in: Self.snapshotWorld) { result in
			switch result {
			case .success(let value):
				guard let page = value as? [String: Any], page["html"] is String else {
					return self.finishSnapshot(.failure(ClewError.printFailed("the page returned no HTML")))
				}
				self.finishSnapshot(.success(page))
			case .failure(let error):
				self.finishSnapshot(.failure(error))
			}
		}
	}

	private func finish(_ result: Result<Data, Error>) {
		if snapshot != nil {
			// A load failure reaches here in either mode.
			if case .failure(let error) = result { return finishSnapshot(.failure(error)) }
		}
		let done = completion
		teardown()
		done?(result)
	}

	private func finishSnapshot(_ result: Result<[String: Any], Error>) {
		let done = snapshotCompletion
		teardown()
		done?(result)
	}

	private func teardown() {
		webView?.removeFromSuperview()
		webView = nil
		request = nil
		completion = nil
		snapshot = nil
		snapshotCompletion = nil
	}
}
