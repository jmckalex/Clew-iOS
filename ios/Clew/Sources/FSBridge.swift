// The window.webkit.messageHandlers.clew bridge: promise RPC from the JS
// platform layer (src/shim/native-bridge.js documents the method surface).
import Foundation
import WebKit
import UIKit
import UniformTypeIdentifiers

final class FSBridge: NSObject, WKScriptMessageHandlerWithReply {
	private let vaults: VaultStore
	private let folderPicker = FolderPicker()

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

	/// Run a file operation off the main thread (coordinated writes can
	/// block on file providers) and reply on main with its result or error.
	private func performIO(_ reply: @escaping (Any?, String?) -> Void, _ work: @escaping () throws -> Any?) {
		vaults.ioQueue.async {
			do {
				let result = try work()
				DispatchQueue.main.async { reply(result, nil) }
			} catch {
				DispatchQueue.main.async { reply(nil, error.localizedDescription) }
			}
		}
	}

	private func handle(method: String, params: [String: Any], webView: WKWebView?,
		reply: @escaping (Any?, String?) -> Void) throws {
		switch method {
		case "vaultBootstrap":
			performIO(reply) { ["path": self.vaults.bootstrapVaultPath()] }

		case "vaultOpen":
			guard let path = params["path"] as? String else { throw ClewError.badPayload }
			// The snapshot reads every text file — off the main thread.
			performIO(reply) { try self.vaults.openVault(path: path) }

		case "write":
			guard let rel = params["rel"] as? String, let text = params["text"] as? String else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.write(rel: rel, text: text); return nil }

		case "writeBinary":
			guard let rel = params["rel"] as? String, let base64 = params["base64"] as? String else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.writeBinary(rel: rel, base64: base64) }

		case "mkdir":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			performIO(reply) { try self.vaults.mkdir(rel: rel); return nil }

		case "rename":
			guard let rel = params["rel"] as? String, let newRel = params["newRel"] as? String else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.rename(rel: rel, newRel: newRel); return nil }

		case "trash":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			performIO(reply) { try self.vaults.trash(rel: rel); return nil }

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
			// Anywhere Files can reach: iCloud Drive, Working Copy, other
			// providers, or the app's own Documents. External folders get a
			// security-scoped bookmark so relaunches reopen them in place.
			guard let root = webView?.window?.rootViewController else {
				return reply(nil, "no view controller to present from")
			}
			folderPicker.present(from: root) { url in
				guard let url else { return reply(nil, nil) }
				reply(["path": self.vaults.registerExternalVault(url)], nil)
			}

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

/// Presents the system folder picker and hands back the chosen URL.
/// Retained by FSBridge; the delegate must outlive the presentation.
final class FolderPicker: NSObject, UIDocumentPickerDelegate {
	private var completion: ((URL?) -> Void)?

	func present(from controller: UIViewController, completion: @escaping (URL?) -> Void) {
		// A second pick while one is open cancels the first cleanly.
		self.completion?(nil)
		self.completion = completion
		let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.folder])
		picker.delegate = self
		picker.allowsMultipleSelection = false
		controller.present(picker, animated: true)
	}

	func documentPicker(_ picker: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
		completion?(urls.first)
		completion = nil
	}

	func documentPickerWasCancelled(_ picker: UIDocumentPickerViewController) {
		completion?(nil)
		completion = nil
	}
}
