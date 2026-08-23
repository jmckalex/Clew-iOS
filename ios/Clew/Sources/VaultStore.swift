// Vault registry and filesystem state on the Swift side.
//
// Vaults live in the app's Documents directory (visible in the Files app —
// UIFileSharingEnabled + LSSupportsOpeningDocumentsInPlace) with the demo
// vault seeded on first launch. The JS layer mirrors the open vault's text
// files in memory; this class does the real IO: the bulk snapshot at open,
// write-through persistence, and mtime-diff rescans for external changes
// (Files app, iCloud sync) that replace the desktop's chokidar watcher.
import Foundation

final class VaultStore {
	/// Absolute path of the currently open vault (set by vaultOpen).
	private(set) var currentVaultPath: String?
	/// rel path -> mtimeMs at last snapshot/rescan, text files only.
	private var knownMtimes: [String: Double] = [:]

	private let ioQueue = DispatchQueue(label: "org.jmckalex.clew.vault-io", qos: .userInitiated)

	static let textExtensions: Set<String> = [
		"md", "jmd", "bib", "canvas", "json", "css", "js", "mjs", "txt", "csl",
		"xml", "yaml", "yml", "svg", "html", "gpx", "geojson", "tex", "org", "csv",
	]

	static let ignoredNames: Set<String> = [".DS_Store", ".git", "node_modules"]

	var documentsURL: URL {
		FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
	}

	// MARK: - Bootstrap

	/// The vault to auto-open at launch: the last-open one if it still
	/// exists, else the seeded demo vault (copied from the bundle on first
	/// run).
	func bootstrapVaultPath() -> String {
		let fm = FileManager.default
		let demo = documentsURL.appendingPathComponent("Demo Vault", isDirectory: true)
		if !fm.fileExists(atPath: demo.path),
			let seed = Bundle.main.url(forResource: "SeedVault", withExtension: nil) {
			try? fm.copyItem(at: seed, to: demo)
		}
		if let last = UserDefaults.standard.string(forKey: "lastVaultPath"),
			fm.fileExists(atPath: last) {
			return last
		}
		return demo.path
	}

	// MARK: - Snapshot

	func openVault(path: String) -> [String: Any] {
		currentVaultPath = path
		UserDefaults.standard.set(path, forKey: "lastVaultPath")
		knownMtimes = [:]
		var files: [String: Any] = [:]
		let root = URL(fileURLWithPath: path, isDirectory: true)
		walk(root, rel: "") { rel, url, mtimeMs, size in
			if Self.isText(rel) {
				let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
				files[rel] = ["text": text, "size": size, "mtimeMs": mtimeMs]
				self.knownMtimes[rel] = mtimeMs
			} else {
				files[rel] = ["size": size, "mtimeMs": mtimeMs]
			}
		}
		return [
			"name": root.lastPathComponent,
			"path": path,
			"files": files,
		]
	}

	static func isText(_ rel: String) -> Bool {
		textExtensions.contains((rel as NSString).pathExtension.lowercased())
	}

	private func walk(_ dir: URL, rel: String, visit: (String, URL, Double, Int) -> Void) {
		let fm = FileManager.default
		guard let entries = try? fm.contentsOfDirectory(
			at: dir, includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey, .fileSizeKey],
			options: []) else { return }
		for url in entries {
			let name = url.lastPathComponent
			if Self.ignoredNames.contains(name) { continue }
			let childRel = rel.isEmpty ? name : "\(rel)/\(name)"
			let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .contentModificationDateKey, .fileSizeKey])
			if values?.isDirectory == true {
				walk(url, rel: childRel, visit: visit)
			} else {
				let mtimeMs = (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
				visit(childRel, url, mtimeMs, values?.fileSize ?? 0)
			}
		}
	}

	// MARK: - File operations (bridge write-through)

	func resolve(_ rel: String) throws -> URL {
		guard let vault = currentVaultPath else { throw ClewError.noVault }
		let base = URL(fileURLWithPath: vault, isDirectory: true).standardizedFileURL
		let target = base.appendingPathComponent(rel).standardizedFileURL
		guard target.path == base.path || target.path.hasPrefix(base.path + "/") else {
			throw ClewError.pathEscape(rel)
		}
		return target
	}

	func write(rel: String, text: String) throws {
		let url = try resolve(rel)
		try FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try text.write(to: url, atomically: true, encoding: .utf8)
		knownMtimes[rel] = currentMtimeMs(url)
	}

	/// Attachment bytes; dedupes the name and converts HEIC to JPEG (the
	/// vault only ever receives web-displayable formats, like desktop's sips
	/// conversion). Returns the final vault-relative path.
	func writeBinary(rel: String, base64: String) throws -> [String: Any] {
		guard var data = Data(base64Encoded: base64) else { throw ClewError.badPayload }
		var targetRel = rel
		let ext = (rel as NSString).pathExtension.lowercased()
		if ext == "heic" || ext == "heif", let jpeg = HEICConverter.jpegData(from: data) {
			data = jpeg
			targetRel = (rel as NSString).deletingPathExtension + ".jpg"
		}
		let dir = try resolve((targetRel as NSString).deletingLastPathComponent)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let base = ((targetRel as NSString).lastPathComponent as NSString).deletingPathExtension
		let finalExt = (targetRel as NSString).pathExtension
		var candidate = dir.appendingPathComponent("\(base).\(finalExt)")
		var counter = 1
		while FileManager.default.fileExists(atPath: candidate.path) {
			candidate = dir.appendingPathComponent("\(base) \(counter).\(finalExt)")
			counter += 1
		}
		try data.write(to: candidate)
		let vaultBase = URL(fileURLWithPath: currentVaultPath!, isDirectory: true).standardizedFileURL.path
		let outRel = String(candidate.standardizedFileURL.path.dropFirst(vaultBase.count + 1))
		return ["rel": outRel, "size": data.count]
	}

	func mkdir(rel: String) throws {
		try FileManager.default.createDirectory(at: try resolve(rel), withIntermediateDirectories: true)
	}

	func rename(rel: String, newRel: String) throws {
		let to = try resolve(newRel)
		try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
		try FileManager.default.moveItem(at: try resolve(rel), to: to)
	}

	func trash(rel: String) throws {
		let url = try resolve(rel)
		do {
			try FileManager.default.trashItem(at: url, resultingItemURL: nil)
		} catch {
			try FileManager.default.removeItem(at: url)
		}
	}

	private func currentMtimeMs(_ url: URL) -> Double {
		let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
		return (date?.timeIntervalSince1970 ?? 0) * 1000
	}

	// MARK: - Rescan (external-change detection)

	/// Diff current on-disk state against the last snapshot; async on the IO
	/// queue, completion on main. Returns nil when nothing changed.
	func rescan(_ completion: @escaping ([String: Any]?) -> Void) {
		guard let vault = currentVaultPath else { return completion(nil) }
		let previous = knownMtimes
		ioQueue.async {
			var changed: [String: Any] = [:]
			var seen = Set<String>()
			var next: [String: Double] = [:]
			let root = URL(fileURLWithPath: vault, isDirectory: true)
			self.walk(root, rel: "") { rel, url, mtimeMs, size in
				guard Self.isText(rel) else { return }
				seen.insert(rel)
				next[rel] = mtimeMs
				if abs((previous[rel] ?? -1) - mtimeMs) > 0.5 {
					let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
					changed[rel] = ["text": text, "size": size, "mtimeMs": mtimeMs]
				}
			}
			let removed = previous.keys.filter { !seen.contains($0) }
			DispatchQueue.main.async {
				self.knownMtimes = next
				if changed.isEmpty && removed.isEmpty { return completion(nil) }
				completion(["changed": changed, "removed": Array(removed)])
			}
		}
	}
}

enum ClewError: Error, LocalizedError {
	case noVault
	case pathEscape(String)
	case badPayload
	case unknownMethod(String)

	var errorDescription: String? {
		switch self {
		case .noVault: return "No vault open"
		case .pathEscape(let rel): return "Path escapes vault: \(rel)"
		case .badPayload: return "Bad payload"
		case .unknownMethod(let name): return "Unknown bridge method: \(name)"
		}
	}
}
