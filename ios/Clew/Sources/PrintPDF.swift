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
import UIKit
import WebKit

final class PdfPrinter: NSObject, WKNavigationDelegate {
	struct Request {
		let url: URL
		let paperSize: String
		let armScript: String
		let readyProbe: String
		let lightThemeScript: String
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

	private var webView: WKWebView?
	private var request: Request?
	private var completion: ((Result<Data, Error>) -> Void)?
	private var deadline = Date()

	/// One print at a time; a second request while one runs is refused.
	var isBusy: Bool { webView != nil }

	func print(_ request: Request, schemeHandler: WKURLSchemeHandler, in window: UIWindow,
		completion: @escaping (Result<Data, Error>) -> Void) {
		guard !isBusy else { return completion(.failure(ClewError.printBusy)) }
		let paper = Self.papers[request.paperSize.lowercased()] ?? Self.papers["a4"]!
		let printable = CGRect(x: Self.margin, y: Self.margin,
			width: paper.width - 2 * Self.margin, height: paper.height - 2 * Self.margin)

		// Its own configuration on the SAME preview scheme handler: the
		// document, its assets and its rendered HTML come from the running
		// app exactly as the reading pane's do. No bridge, no console hook.
		let config = WKWebViewConfiguration()
		config.setURLSchemeHandler(schemeHandler, forURLScheme: "clew-preview")
		let view = WKWebView(frame: CGRect(origin: .zero, size: CGSize(width: printable.width, height: printable.height)),
			configuration: config)
		view.navigationDelegate = self
		view.isOpaque = true
		view.backgroundColor = .white
		// Behind everything the app shows, so it is in the window (laid out
		// and painted) without ever being seen.
		window.insertSubview(view, at: 0)

		self.webView = view
		self.request = request
		self.completion = completion
		self.deadline = Date().addingTimeInterval(Self.readyTimeout)
		view.load(URLRequest(url: request.url))
	}

	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		guard let request else { return finish(.failure(ClewError.printFailed("no request"))) }
		webView.evaluateJavaScript(request.armScript) { _, _ in
			webView.evaluateJavaScript(request.lightThemeScript) { _, _ in
				self.poll()
			}
		}
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
				DispatchQueue.main.asyncAfter(deadline: .now() + Self.settle) { self.render() }
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

	private func finish(_ result: Result<Data, Error>) {
		let done = completion
		webView?.removeFromSuperview()
		webView = nil
		request = nil
		completion = nil
		done?(result)
	}
}
