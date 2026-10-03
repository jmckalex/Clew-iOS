// The window.webkit.messageHandlers.clew bridge: promise RPC from the JS
// platform layer (src/shim/native-bridge.js documents the method surface).
import Foundation
import WebKit
import UIKit
import UniformTypeIdentifiers

final class FSBridge: NSObject, WKScriptMessageHandlerWithReply {
	private let vaults: VaultStore
	private let folderPicker = FolderPicker()
	private let quickLook = QuickLookPresenter()
	private let printer = PdfPrinter()
	private let scanner = DocumentScanner()

	init(vaults: VaultStore) {
		self.vaults = vaults
	}

	func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage,
		replyHandler: @escaping (Any?, String?) -> Void) {
		// Only the app page may call the bridge. WebKit defines
		// window.webkit.messageHandlers.clew in EVERY frame — the note
		// previews, and any iframe a note embeds, sandboxed or remote — so
		// without this guard an embedded page could write, trash or open
		// anything (measured: a sandbox="allow-scripts" srcdoc frame inside a
		// note got replies). Desktop's preload only reaches the main frame.
		guard message.frameInfo.isMainFrame,
			message.frameInfo.securityOrigin.protocol == "clew-app" else {
			return replyHandler(nil, "the bridge answers the app page only")
		}
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
			// Every opening is a new session (a random sid and caller token),
			// minted here on the main thread, where the scheme handler reads
			// them. The reply is the only way out: the bridge answers the app
			// page alone.
			vaults.newSession()
			let session: [String: Any] = ["sessionId": vaults.sessionId, "callerToken": vaults.callerToken]
			// The snapshot reads every text file — off the main thread.
			performIO(reply) { try self.vaults.openVault(path: path).merging(session) { _, minted in minted } }

		case "write":
			guard let rel = params["rel"] as? String, let text = params["text"] as? String else {
				throw ClewError.badPayload
			}
			// A refused write (the file changed elsewhere since last seen)
			// answers {conflict, disk, mtimeMs}; `force` is "keep mine".
			let force = params["force"] as? Bool ?? false
			performIO(reply) { try self.vaults.write(rel: rel, text: text, force: force) }

		case "cloudConflictVersions":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			performIO(reply) { try self.vaults.cloudConflictVersions(rel: rel) }

		case "resolveCloudConflict":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			let other = params["keepOther"] as? Int
			performIO(reply) { try self.vaults.resolveCloudConflict(rel: rel, keepOther: other); return nil }

		case "writeBinary":
			guard let rel = params["rel"] as? String, let base64 = params["base64"] as? String else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.writeBinary(rel: rel, base64: base64) }

		case "updateBinary":
			// Overwrite-in-place for existing vault files (PDF annotation
			// saves) — writeBinary's dedupe would fork "name 1.pdf" copies.
			guard let rel = params["rel"] as? String, let base64 = params["base64"] as? String else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.updateBinary(rel: rel, base64: base64); return nil }

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

		case "setMtime":
			guard let rel = params["rel"] as? String, let mtimeMs = params["mtimeMs"] as? Double else {
				throw ClewError.badPayload
			}
			performIO(reply) { try self.vaults.setMtime(rel: rel, mtimeMs: mtimeMs); return nil }

		case "remove":
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			performIO(reply) { try self.vaults.remove(rel: rel); return nil }

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

		case "printPdf":
			// "Export as PDF (reading view)": the note's preview document,
			// printed once it has settled (PrintPDF.swift), into the share
			// sheet. The scripts that say what "settled" means come from the
			// JS side, so they are upstream's.
			guard let urlString = params["url"] as? String, let url = URL(string: urlString),
				url.scheme == "clew-preview",
				let name = params["name"] as? String,
				let arm = params["arm"] as? String, let probe = params["probe"] as? String,
				let lightTheme = params["lightTheme"] as? String else { throw ClewError.badPayload }
			guard let webView, let window = webView.window,
				let handler = webView.configuration.urlSchemeHandler(forURLScheme: "clew-preview") else {
				return reply(nil, "no window to print from")
			}
			let request = PdfPrinter.Request(url: url, paperSize: params["paperSize"] as? String ?? "a4",
				armScript: arm, readyProbe: probe, lightThemeScript: lightTheme, callerToken: vaults.callerToken)
			printer.print(request, schemeHandler: handler, in: window) { result in
				switch result {
				case .success(let data):
					self.shareFile(named: name, data: data, from: webView)
					reply(["bytes": data.count], nil)
				case .failure(let error):
					reply(nil, error.localizedDescription)
				}
			}

		case "shareBase64":
			guard let name = params["name"] as? String, let base64 = params["base64"] as? String,
				let data = Data(base64Encoded: base64) else { throw ClewError.badPayload }
			shareFile(named: name, data: data, from: webView)
			reply(nil, nil)

		case "quickLook":
			// The system viewer for vault files WebKit renders poorly inline
			// (PDFs especially). Materialize handles evicted iCloud items.
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			vaults.ioQueue.async {
				let url = self.vaults.materialize(rel: rel, timeout: 15)
				DispatchQueue.main.async {
					guard let url, let root = webView?.window?.rootViewController else {
						return reply(nil, "file not available")
					}
					self.quickLook.present(url: url, from: root)
					reply(nil, nil)
				}
			}

		case "demoVaultPath":
			performIO(reply) { ["path": self.vaults.demoVaultPath()] }

		// ---- switching vaults (the shim's vault switcher) -----------------
		// A switch is a fresh page: the shim settles the open vault, names
		// the next one, and reloads; the boot opens it like any launch.

		case "vaultStatus":
			// Remembered vaults' standing, for the switcher's list.
			guard let paths = params["paths"] as? [String] else { throw ClewError.badPayload }
			performIO(reply) { paths.prefix(50).map { self.vaults.vaultStatus($0) } }

		case "setNextVault":
			guard let path = params["path"] as? String else { throw ClewError.badPayload }
			performIO(reply) { self.vaults.setNextVault(path) }

		case "removeEmptyVault":
			// A vault created for a switch the user then cancelled.
			guard let path = params["path"] as? String else { throw ClewError.badPayload }
			performIO(reply) { ["removed": self.vaults.removeEmptyVault(path)] }

		case "forgetVault":
			guard let path = params["path"] as? String else { throw ClewError.badPayload }
			performIO(reply) { self.vaults.forgetVault(path); return nil }

		case "noteFonts":
			// The face → file map behind `font=note` figures, built from
			// CoreText on first call (NoteFonts.swift) and served under
			// __clew_assets__/notefonts/. The JS side puts it in the engine
			// worker's env before the first standby spawns.
			performIO(reply) {
				let p = NoteFonts.shared.ensure()
				return ["family": p.family, "faces": p.faces, "dir": p.dir.path]
			}

		case "revealGlobalPlugins":
			// "Open global plugin folder": Documents/Plugins in the Files app —
			// the iOS reveal (shell.openPath upstream), created on the way as
			// upstream does. The Files app's own URL scheme opens a folder.
			let folder = try vaults.ensureGlobalPluginsFolder()
			let encoded = folder.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? folder
			if let url = URL(string: "shareddocuments://" + encoded) {
				UIApplication.shared.open(url)
			}
			reply(["path": folder], nil)

		case "createVault":
			// The welcome screen's "Create new vault…". A native sheet asks
			// the name (WKWebView has no prompt() without a UI delegate for
			// it); the folder lands in Documents, like desktop's default of
			// ~/Documents/My Vault.
			guard let root = webView?.window?.rootViewController else {
				return reply(nil, "no view controller to present from")
			}
			let alert = UIAlertController(title: "Create a new vault",
				message: "A folder in this app's Documents, visible in the Files app.", preferredStyle: .alert)
			alert.addTextField { field in
				field.placeholder = "Vault name"
				field.text = "My Vault"
				field.clearButtonMode = .whileEditing
			}
			alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in reply(nil, nil) })
			alert.addAction(UIAlertAction(title: "Create Vault", style: .default) { _ in
				let name = alert.textFields?.first?.text ?? ""
				do {
					reply(["path": try self.vaults.createVault(named: name)], nil)
				} catch {
					reply(nil, error.localizedDescription)
				}
			})
			root.present(alert, animated: true)

		case "officeThumbnail":
			// Quick Look renders the thumbnail; may wait on an evicted iCloud
			// document first, so off main; QL completes on its own queue.
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			vaults.ioQueue.async {
				OfficeThumbs.thumbnail(rel: rel, in: self.vaults) { result in
					DispatchQueue.main.async { reply(result, nil) }
				}
			}

		case "pdfThumbnail":
			// A PDF's first page, from Quick Look, cached like office thumbs at
			// the mirrored .clew/cache/pdf-thumbs/<rel>.png (pdf-unification §2).
			guard let rel = params["rel"] as? String else { throw ClewError.badPayload }
			vaults.ioQueue.async {
				OfficeThumbs.pdfThumbnail(rel: rel, in: self.vaults) { result in
					DispatchQueue.main.async { reply(result, nil) }
				}
			}

		// ---- web PDFs (RemotePdfStore; pdf-unification §4, §8) ----------
		// Only the app page reaches these (the bridge refuses every other
		// frame), so only a render can register a URL.
		case "registerRemotePdfs":
			guard let urls = params["urls"] as? [String] else { throw ClewError.badPayload }
			reply(RemotePdfStore.shared.register(Array(urls.prefix(200))), nil)

		case "openRemotePdf":
			// Open in browser (the viewer's strip and its failure box, via the
			// app page's pdf-save.js): the viewer names the HASH; the URL is
			// this session's own registration, never taken from a message
			// (Clew-app ipc.js REMOTE_PDF_OPEN).
			guard let hash = params["hash"] as? String else { throw ClewError.badPayload }
			guard let url = RemotePdfStore.shared.url(for: hash), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
				throw ClewError.message("Not a web PDF open in this window")
			}
			UIApplication.shared.open(url)
			reply(["url": url.absoluteString], nil)

		case "saveRemotePdfCopy":
			guard let hash = params["hash"] as? String else { throw ClewError.badPayload }
			let folder = params["folder"] as? String ?? "Attachments"
			performIO(reply) { try RemotePdfStore.shared.saveCopy(hash, folder: folder, into: self.vaults) }

		// ---- vault trust (VaultTrust.swift; the interim guard) -----------
		// The CURRENT vault's standing, for Settings → This vault and the
		// "Trust this vault" banner. Only the app page reaches these.
		case "vaultTrustGet":
			guard let path = vaults.currentVaultPath else { return reply(["open": false, "trusted": false], nil) }
			let root = URL(fileURLWithPath: path, isDirectory: true)
			reply(["open": true, "trusted": vaults.trust.isTrusted(root), "identity": vaults.trust.identity(root)], nil)

		case "vaultTrustSet":
			guard let trusted = params["trusted"] as? Bool, let path = vaults.currentVaultPath else { throw ClewError.badPayload }
			let root = URL(fileURLWithPath: path, isDirectory: true)
			if trusted { vaults.trust.trust(root) } else { vaults.trust.revoke(root) }
			reply(["open": true, "trusted": vaults.trust.isTrusted(root), "identity": vaults.trust.identity(root)], nil)

		case "pdfLeakCount":
			// PDFs that reached a frame directly and were cancelled
			// (WebHost's navigation-response check) — the sweep asserts zero.
			reply(PdfLeaks.count, nil)

		case "takeQuickAction":
			reply(["action": QuickActions.shared.take() as Any? ?? NSNull()], nil)

		case "scanDocument":
			// Scan into a note: the document camera, then OCR and (unless
			// `pdf` is false) one PDF written as a NEW file at `rel`, deduped.
			// Answers {rel?, size?, pages, text} or {cancelled: true}.
			let rel = params["rel"] as? String
			let wantPdf = params["pdf"] as? Bool ?? true
			if wantPdf, rel == nil { throw ClewError.badPayload }
			let process: ([UIImage]) -> Void = { images in
				DispatchQueue.global(qos: .userInitiated).async {
					let pages = images.map { (image: $0, lines: ScanPDF.recognize($0)) }
					let text = pages.map { ScanPDF.text(of: $0.lines) }.joined(separator: "\n\n")
					var result: [String: Any] = ["pages": pages.count, "text": text]
					guard wantPdf, let rel else { return DispatchQueue.main.async { reply(result, nil) } }
					let data = ScanPDF.pdf(pages: pages)
					self.performIO(reply) {
						let written = try self.vaults.writeNewBinary(data, rel: rel)
						result.merge(written) { _, new in new }
						return result
					}
				}
			}
			#if DEBUG
			if let fixture = UserDefaults.standard.string(forKey: "ClewScanFixture") {
				return process(ScanPDF.fixturePages(fixture))
			}
			#endif
			guard DocumentScanner.isSupported else {
				throw ClewError.message("Scanning needs a camera, and this device has none Clew can use.")
			}
			guard var top = webView?.window?.rootViewController else {
				return reply(nil, "no view controller to present from")
			}
			while let presented = top.presentedViewController { top = presented }
			scanner.present(from: top) { outcome in
				switch outcome {
				case .failure(let error): reply(nil, error.localizedDescription)
				case .success(nil): reply(["cancelled": true], nil)
				case .success(let images?): process(images)
				}
			}

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
		guard let webView, let root = webView.window?.rootViewController else { return }
		// On iPad the share sheet is a popover and needs somewhere to point:
		// anchored to the WHOLE web view (the old sourceView-only setup) it had
		// nowhere to go and was never shown — measured. A point in the middle
		// with no arrow presents it centred, the way a sheet would be.
		if let popover = controller.popoverPresentationController {
			popover.sourceView = webView
			popover.sourceRect = CGRect(x: webView.bounds.midX, y: webView.bounds.midY, width: 1, height: 1)
			popover.permittedArrowDirections = []
		}
		root.present(controller, animated: true)
		#if DEBUG
		DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
			NSLog("CLEWJS share sheet presented=%d (%@)", root.presentedViewController != nil ? 1 : 0, sanitized)
		}
		#endif
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
