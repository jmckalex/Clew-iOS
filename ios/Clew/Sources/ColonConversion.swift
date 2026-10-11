// "Convert this vault" (Clew-app main/colon-conversion.js, the colon
// directives' retirement, phase 2), the iPad's native half. The converter
// itself is upstream's, run verbatim in the app page over the vault mirror
// (src/shim/colon-conversion.js); this is what the mirror cannot answer:
//
//   ColonBackupStore    each conversion's notes as they were and its
//                       manifest, in Application Support/colon-conversion/:
//                       the device's, never a vault's (a backup inside the
//                       vault would itself be converted), never in iCloud
//                       Drive. Like desktop's userData under Time Machine, it
//                       stays in the device's backup: the user's own words.
//   ColonVaultFiles     the vault's folder configs (`.jmarkdown/config.json`:
//                       the mirror skips every dot-folder but .clew), and the
//                       raw bytes of a note that is not UTF-8 (the mirror holds
//                       "" for it, so the scan would pass it by where desktop
//                       names it).
//
// Foundation only, so ios/Tests/ColonConversion runs it on the Mac.
import Foundation

final class ColonBackupStore {
	let root: URL

	init(root: URL) { self.root = root }

	static func deviceRoot() -> URL {
		FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
			.appendingPathComponent("colon-conversion", isDirectory: true)
	}

	enum StoreError: Error, LocalizedError {
		case badPath
		var errorDescription: String? { "that path is not inside the conversion backups" }
	}

	/// A path the page names inside the store: relative, every component a
	/// plain name. Nothing else is ever opened.
	func url(_ rel: String) throws -> URL {
		let parts = rel.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
		guard !rel.isEmpty, !rel.hasPrefix("/"), !parts.isEmpty,
			parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.contains("\0") })
		else { throw StoreError.badPath }
		return parts.reduce(root) { $0.appendingPathComponent($1) }
	}

	/// One backup file, atomic and fsynced (AtomicFile), its folders made.
	func write(_ rel: String, data: Data) throws {
		let target = try url(rel)
		try FileManager.default.createDirectory(at: target.deletingLastPathComponent(), withIntermediateDirectories: true)
		try AtomicFile.write(data, to: target)
	}

	/// A vault's conversions: id → its manifest's text. Only manifests:
	/// listing them reads no note (the notes come at Undo, `notes`).
	func manifests(folder: String) throws -> [String: String] {
		let base = try url(folder)
		var out: [String: String] = [:]
		for id in (try? FileManager.default.contentsOfDirectory(atPath: base.path)) ?? [] where !id.hasPrefix(".") {
			let file = base.appendingPathComponent(id).appendingPathComponent("manifest.json")
			if let text = try? String(contentsOf: file, encoding: .utf8) { out[id] = text }
		}
		return out
	}

	/// One conversion's notes as they were, those named (vault-relative
	/// paths, as its manifest lists them): path → bytes. Undo asks a few
	/// hundred at a time. A path that is missing, not a plain file, or names
	/// anything outside the conversion's notes is left out.
	func notes(folder: String, id: String, paths: [String]) throws -> [String: Data] {
		let base = try url("\(folder)/\(id)/notes")
		var out: [String: Data] = [:]
		for rel in paths {
			guard let file = try? url("\(folder)/\(id)/notes/\(rel)"),
				let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey]),
				values.isRegularFile == true, values.isSymbolicLink != true,
				file.standardizedFileURL.path.hasPrefix(base.standardizedFileURL.path + "/"),
				let data = try? Data(contentsOf: file) else { continue }
			out[rel] = data
		}
		return out
	}
}

enum ColonVaultFiles {
	/// Folder configs bigger than this are not configs.
	static let configCap = 1 << 20

	/// Every folder's `.jmarkdown/config.json`, as the engine would find it
	/// beside a note: folder (vault-relative, "" for the root) → its text.
	/// The walk is the mirror's (VaultStore.walk): dot-folders and
	/// node_modules skipped, a folder link followed while it stays inside the
	/// vault and listed by the link's path, never into a folder above it — so
	/// a config is found under every path a note is listed by.
	static func folderConfigs(root: URL, realRoot: String) -> [String: String] {
		var out: [String: String] = [:]
		let fm = FileManager.default
		func visit(_ dir: URL, _ rel: String, _ ancestry: [String]) {
			guard let real = VaultPaths.realPath(dir.path), VaultPaths.isInside(real, root: realRoot),
				!ancestry.contains(real) else { return }
			let config = dir.appendingPathComponent(".jmarkdown").appendingPathComponent("config.json")
			if case .inside(let file) = VaultPaths.check(config.path, root: realRoot),
				let size = (try? fm.attributesOfItem(atPath: file))?[.size] as? Int, size <= configCap,
				let text = try? String(contentsOfFile: file, encoding: .utf8) {
				out[rel] = text
			}
			for name in (try? fm.contentsOfDirectory(atPath: dir.path)) ?? [] {
				if name.hasPrefix(".") || name == "node_modules" { continue }
				let child = dir.appendingPathComponent(name)
				var isDir: ObjCBool = false
				guard fm.fileExists(atPath: child.path, isDirectory: &isDir), isDir.boolValue else { continue }
				visit(child, rel.isEmpty ? name : "\(rel)/\(name)", ancestry + [real])
			}
		}
		visit(root, "", [])
		return out
	}

	/// Of `rels` (the notes the mirror holds as ""), those whose bytes are
	/// not UTF-8, with their bytes. An empty note is not among them.
	static func nonUTF8(root: URL, realRoot: String, rels: [String]) -> [String: Data] {
		var out: [String: Data] = [:]
		for rel in rels {
			let url = root.appendingPathComponent(rel)
			guard case .inside(let real) = VaultPaths.check(url.path, root: realRoot),
				let data = try? Data(contentsOf: URL(fileURLWithPath: real)), !data.isEmpty,
				String(data: data, encoding: .utf8) == nil else { continue }
			out[rel] = data
		}
		return out
	}
}
