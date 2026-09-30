// The WKWebView owner: configuration, delegates, and lifecycle entry
// points. One web view = the whole app (single vault session, id "s1" —
// the session-id URL shape is kept so preview URLs match the desktop
// protocol exactly).
import SwiftUI
import WebKit

final class WebHost: NSObject, ObservableObject {
	let vaults = VaultStore()
	private(set) var webView: WKWebView!
	private var schemeHandler: SchemeHandler!
	/// Pins the web view's scroll view at the top (see init).
	private var offsetPin: NSKeyValueObservation?
	/// The window a JavaScript alert() is shown in: its own, above everything
	/// (see runJavaScriptAlertPanelWithMessage), alive until OK.
	fileprivate var alertWindow: UIWindow?

	override init() {
		super.init()

		let config = WKWebViewConfiguration()
		schemeHandler = SchemeHandler(vaults: vaults)
		// Create the trust store here, on main, before any I/O-queue open
		// can race to (and migrate the device's known vaults on first use).
		_ = vaults.trust
		config.setURLSchemeHandler(schemeHandler, forURLScheme: "clew-app")
		config.setURLSchemeHandler(schemeHandler, forURLScheme: "clew-preview")

		let bridge = FSBridge(vaults: vaults)
		config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: "clew")

		#if DEBUG
		// JS console/error forwarding into the system log (all frames, so
		// preview iframes report too):  log stream --predicate 'eventMessage
		// CONTAINS "CLEWJS"'.
		config.userContentController.add(ConsoleSink(), name: "clewlog")
		let consoleForwarder = """
		(function () {
			const post = (level, args) => {
				try {
					window.webkit.messageHandlers.clewlog.postMessage(level + ' [' + location.pathname + '] ' + args.map((a) => {
						try { return typeof a === 'string' ? a : (a && a.stack) ? a.stack : JSON.stringify(a); }
						catch { return String(a); }
					}).join(' '));
				} catch {}
			};
			for (const level of ['error', 'warn']) {
				const orig = console[level];
				console[level] = (...args) => { post(level, args); orig.apply(console, args); };
			}
			window.addEventListener('error', (e) => post('uncaught', [e.message, (e.filename || '') + ':' + e.lineno]));
			window.addEventListener('unhandledrejection', (e) =>
				post('unhandledrejection', [String((e.reason && e.reason.message) || e.reason), String((e.reason && e.reason.stack) || '')]));
		})();
		"""
		config.userContentController.addUserScript(WKUserScript(
			source: consoleForwarder, injectionTime: .atDocumentStart, forMainFrameOnly: false))
		#endif

		config.allowsInlineMediaPlayback = true
		config.mediaTypesRequiringUserActionForPlayback = []
		config.preferences.isElementFullscreenEnabled = true

		let webView = WKWebView(frame: .zero, configuration: config)
		#if DEBUG
		webView.isInspectable = true
		#endif
		webView.scrollView.isScrollEnabled = false // the app manages its own scrolling
		webView.scrollView.contentInsetAdjustmentBehavior = .never
		// The app page never scrolls as a whole — every scroller is an element
		// inside it — but isScrollEnabled only stops the USER: WebKit still
		// moves the scroll view itself to reveal a focused field above a
		// keyboard, which slid the whole fixed layout up (toolbars under the
		// status bar). Whatever moves it, it goes straight back.
		offsetPin = webView.scrollView.observe(\.contentOffset, options: [.new]) { scrollView, _ in
			if scrollView.contentOffset != .zero { scrollView.contentOffset = .zero }
		}
		webView.uiDelegate = self
		webView.navigationDelegate = self
		webView.isOpaque = false
		webView.backgroundColor = UIColor(red: 0.08, green: 0.09, blue: 0.11, alpha: 1)
		self.webView = webView
		schemeHandler.webView = webView

		webView.load(URLRequest(url: URL(string: "clew-app://app/index.html")!))

		// External writers (iCloud sync landing, Working Copy pulls, Files
		// app edits) surface mid-session, not just on foregrounding. The
		// rescan is a cheap mtime walk; timers stop while suspended.
		Timer.scheduledTimer(withTimeInterval: 20, repeats: true) { [weak self] _ in
			self?.rescanVault()
		}
	}

	func flushEditors() {
		webView.evaluateJavaScript(
			"window.dispatchEvent(new Event('blur')); window.__clewNative?.flush?.();",
			completionHandler: nil)
	}

	/// Backgrounding: iOS may suspend the app seconds after it leaves the
	/// screen, mid-save. Hold a background task until the page reports every
	/// editor, PDF annotation and queued write flushed
	/// (install-shim.js#flushForSuspension) — or 10 s, or iOS's own expiry.
	func flushForSuspension() {
		var task = UIBackgroundTaskIdentifier.invalid
		let end = {
			guard task != .invalid else { return }
			UIApplication.shared.endBackgroundTask(task)
			task = .invalid
		}
		task = UIApplication.shared.beginBackgroundTask(withName: "clew-flush", expirationHandler: end)
		DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: end)
		webView.callAsyncJavaScript("await window.__clewNative?.flushForSuspension?.(); return true;",
			arguments: [:], in: nil, in: .page) { _ in end() }
	}

	func rescanVault() {
		vaults.rescan { [weak self] diff in
			guard let diff, let data = try? JSONSerialization.data(withJSONObject: diff),
				let json = String(data: data, encoding: .utf8) else { return }
			self?.webView.evaluateJavaScript(
				"window.__clewNative?.externalDiff?.(\(json));",
				completionHandler: nil)
		}
	}
}

// MARK: - Navigation and popup guards (Electron's setWindowOpenHandler /
// will-navigate equivalents; the unsandboxed preview iframe depends on them)

#if DEBUG
/// Receives the console forwarder's messages; NSLog makes them visible via
/// `xcrun simctl spawn booted log stream`.
final class ConsoleSink: NSObject, WKScriptMessageHandler {
	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
		NSLog("CLEWJS %@", String(describing: message.body))
	}
}
#endif

extension WebHost: WKUIDelegate, WKNavigationDelegate {
	func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
		#if DEBUG
		// Smoke hook (the iOS cousin of desktop's CLEW_SMOKE): launch with
		//   xcrun simctl launch booted org.jmckalex.clew.ios -ClewSmokeJS '<js>'
		// and the script runs in the app page once it has settled.
		if let smoke = UserDefaults.standard.string(forKey: "ClewSmokeJS") {
			DispatchQueue.main.asyncAfter(deadline: .now() + 2.0) {
				webView.callAsyncJavaScript(smoke, arguments: [:], in: nil, in: .page) { result in
					if case .failure(let error) = result { NSLog("CLEWJS smoke error: %@", String(describing: error)) }
					if case .success(let value) = result { NSLog("CLEWJS smoke ok: %@", String(describing: value)) }
				}
			}
		}
		#endif
	}

	// alert() from the renderer (builtin.js's export-failure message) was
	// silent: WKWebView shows no JavaScript dialogs without a UI delegate
	// method for each. Nothing in the renderer calls confirm() or prompt().
	func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String,
		initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
		// In a window of its own, above everything, on the app's scene rather
		// than the web view's window: while Quick Look (or any full-screen
		// presentation) covers the app, UIKit detaches the covered view
		// hierarchy and webView.window is NIL — measured — so anything routed
		// through it would swallow the alert and leave the page's JavaScript
		// blocked in alert() until the dialog it never showed was dismissed.
		let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
		let scene = webView.window?.windowScene
			?? scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
		guard alertWindow == nil, let scene else { return completionHandler() }
		let window = UIWindow(windowScene: scene)
		window.windowLevel = .alert + 1
		window.rootViewController = UIViewController()
		window.makeKeyAndVisible()
		alertWindow = window
		let alert = UIAlertController(title: nil, message: message, preferredStyle: .alert)
		alert.addAction(UIAlertAction(title: "OK", style: .default) { [weak self] _ in
			self?.alertWindow?.isHidden = true
			self?.alertWindow = nil
			completionHandler()
		})
		window.rootViewController?.present(alert, animated: true)
	}

	func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
		for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
		if let url = navigationAction.request.url, ["http", "https", "mailto"].contains(url.scheme ?? "") {
			UIApplication.shared.open(url)
		}
		return nil // all popups denied
	}

	func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
		decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
		guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
		let scheme = url.scheme ?? ""
		if navigationAction.targetFrame?.isMainFrame ?? true {
			// The app frame is pinned to its own origin.
			decisionHandler(scheme == "clew-app" ? .allow : .cancel)
			if ["http", "https", "mailto"].contains(scheme) { UIApplication.shared.open(url) }
			return
		}
		// Iframes: previews and canvas web nodes may load clew-preview and
		// (sandboxed canvas web nodes) http(s). Never the app origin: no frame
		// may host the app page (the owner's call, frame-bridge §2.7 — the
		// same rule as desktop's frame guard and frame-ancestors).
		decisionHandler(["clew-preview", "http", "https", "about", "blob"].contains(scheme) ? .allow : .cancel)
	}

	/// A PDF that answers a FRAME's navigation directly is cancelled and
	/// counted: every PDF is meant to open in pdf-page.html, which fetches
	/// its bytes rather than navigating to them, so one arriving here is a
	/// leak (pdf-unification §6 — desktop's `will-download` twin; WebKit has
	/// no plugin to turn off, and would show one still page). Main-frame
	/// responses are the app page's own.
	func webView(_ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
		decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
		if !navigationResponse.isForMainFrame,
			navigationResponse.response.mimeType?.lowercased() == "application/pdf" {
			PdfLeaks.count += 1
			NSLog("CLEW pdf-leak: a PDF reached a frame directly: %@", navigationResponse.response.url?.absoluteString ?? "?")
			return decisionHandler(.cancel)
		}
		decisionHandler(.allow)
	}
}

/// PDFs cancelled by the navigation-response check (the sweep asserts none).
enum PdfLeaks {
	static var count = 0
}

struct WebContainerView: UIViewRepresentable {
	let host: WebHost

	func makeUIView(context: Context) -> WKWebView { host.webView }
	func updateUIView(_ uiView: WKWebView, context: Context) {}
}
