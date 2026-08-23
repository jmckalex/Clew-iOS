// The window.webkit.messageHandlers.clew bridge: promise RPC from the JS
// platform layer (src/shim/native-bridge.js documents the method surface).
import Foundation
import WebKit
import UIKit
import UniformTypeIdentifiers

final class FSBridge: NSObject, WKScriptMessageHandlerWithReply {
	private let vaults: VaultStore

	init(vaults: VaultStore) {
		self.vaults = vaults
	}

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void) {
		guard let body = message.body as? [String: Any],
			let method = body["method"] as? String else {
			return replyHandler(nil, "malformed bridge call")
		}
		let params = body["params"] as? [String: Any] ?? [:]
		do {
			try handle(method: method, params: params, webView: message.webView, reply: replyHandler)
		} catch {
			replyHandler(nil, error.localizedDescription)
		}
	}

	private func handle(method: String, params: [String: Any], webView: WKWebView?,
		reply: @escaping (Any?, String?) -> Void) throws {
		switch method {
		case "vaultBootstrap":
			reply(["path": vaults.bootstrapVaultPath()], nil)

		case "vaultOpen":
			guard let path = params["path"] as? String else { throw ClewError.badPayload }
			// The snapshot reads every text file — off the main thread.
			DispatchQueue.global(qos: .userInitiated).async {
				let result = self.vaults.openVault(path: path)
				DispatchQueue.main.async { reply(result, nil) }
			}

		case "write":
			guard let rel = params["rel"] as? String, let text = params["text"] as? String else {
				throw ClewError.badPayload
			}
			try vaults.write(rel: rel, text: text)
			reply(nil, nil)

		case "writeBinary":
			guard let rel = params["rel"] as? String, let base64 = params["base64"] as? String else {
				throw ClewError.badPayload
			}
			reply(try vaults.writeBinary(rel: rel, base64: base64), nil)

		case "mkdir":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			try vaults.mkdir(rel: rel)
			reply(nil, nil)

		case "rename":
			guard let rel = params["rel"] as? String, let newRel = params["newRel"] as? String else {
				throw ClewError.badPayload
			}
			try vaults.rename(rel: rel, newRel: newRel)
			reply(nil, nil)

		case "trash":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			try vaults.trash(rel: rel)
			reply(nil, nil)

		case "rescan":
			vaults.rescan { diff in reply(diff ?? [:], nil) }

		case "openExternal":
			if let urlString = params["url"] as? String, let url = URL(string: urlString),
				["http", "https", "mailto"].contains(url.scheme ?? "") {
				UIApplication.shared.open(url)
			}
			reply(nil, nil)

		case "shareText":
			guard let name = params["name"] as? String, let text = params["text"] as? String else {
				throw ClewError.badPayload
			}
			shareFile(named: name, data: Data(text.utf8), from: webView)
			reply(nil, nil)

		case "shareBase64":
			guard let name = params["name"] as? String, let base64 = params["base64"] as? String,
				let data = Data(base64Encoded: base64) else { throw ClewError.badPayload }
			shareFile(named: name, data: data, from: webView)
			reply(nil, nil)

		case "pickFolder":
			// External vault folders (Files app / iCloud) — follow-up work:
			// UIDocumentPicker + security-scoped bookmarks. Until then the
			// picker reports "not available" and vaults live in Documents.
			reply(nil, nil)

		default:
			throw ClewError.unknownMethod(method)
		}
	}

	private func shareFile(named name: String, data: Data, from webView: WKWebView?) {
		let sanitized = name.replacingOccurrences(of: "/", with: "-")
		let url = FileManager.default.temporaryDirectory.appendingPathComponent(sanitized)
		try? data.write(to: url)
		let controller = UIActivityViewController(activityItems: [url], applicationActivities: nil)
		guard let root = webView?.window?.rootViewController else { return }
		controller.popoverPresentationController?.sourceView = webView
		root.present(controller, animated: true)
	}
}
