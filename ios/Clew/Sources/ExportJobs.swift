// The export host's jobs (UPSTREAM-LATEX-EXPORT-PLAN.md §3, L1), WebKit
// aside so the rules are tested on the Mac (ios/Tests/ExportJobs):
//
//   - one job at a time, under a single-use token: the host page fetches the
//     job once, and every later request for it is refused;
//   - its outputs land in a folder of the job's own, at paths that must stay
//     inside it (relative, no `..`, no link followed), each written once,
//     within a count and a size;
//   - the page's last word must name exactly the files it wrote;
//   - a job that fails, times out or is cancelled leaves nothing behind, and
//     a finished one's folder lives until its caller discards it, or the
//     next job begins;
//   - a finished job's share (L2) is staged inside its folder: the outputs
//     moved under a folder named for the note, the vault files and
//     bibliographies the .tex names copied in beside them (each at a path
//     inside the stage, never over an output), then the .tex alone or the
//     stage zipped.
//
// ExportHost.swift drives it from the web view; SchemeHandler.swift routes
// the host page's requests to it.
//
// And the export figure cache (ExportCache, below): what a trusted vault's
// exports drew, kept between them.
import CryptoKit
import Foundation

final class ExportJobs {
	enum Failure: Error, LocalizedError, Equatable {
		case busy
		case unknownToken
		case alreadyServed
		case badPath(String)
		case duplicate(String)
		case tooMuch(String)
		case malformed(String)
		case noSuchFolder
		/// The page's own report of a failed export.
		case reported(String)

		var errorDescription: String? {
			switch self {
			case .busy: return "An export is already running"
			case .unknownToken: return "No such export job"
			case .alreadyServed: return "That export job was already taken"
			case .badPath(let rel): return "An export output names a path outside its folder: \(rel)"
			case .duplicate(let rel): return "An export output was written twice: \(rel)"
			case .tooMuch(let what): return "The export wrote too much (\(what))"
			case .malformed(let why): return "The export's answer is malformed: \(why)"
			case .noSuchFolder: return "That export is no longer there to share"
			case .reported(let message): return message
			}
		}
	}

	struct Done: Equatable {
		let folder: URL
		let output: String
		let files: [String: Int]
		let warnings: [String]
		let ms: Int
	}

	static let maxFiles = 2_000
	static let maxBytes = 512 * 1024 * 1024
	static let folderPrefix = "clew-export-"

	let root: URL
	private(set) var token: String?
	private var job: Data?
	/// The vault identity whose export figure cache this job may use (a
	/// trusted vault's, decided by the bridge), or nil: the figures stay in
	/// the worker for this export alone.
	private var cacheVault: String?
	private var served = false
	private(set) var folder: URL?
	private var written: [String: Int] = [:]
	private var total = 0

	init(root: URL) {
		self.root = root
	}

	var isRunning: Bool { token != nil }

	/// A new job: every earlier job's folder goes, this one's is made, and its
	/// token (32 random hex digits) is returned. Refused while one runs.
	func begin(job: Data, cacheVault: String? = nil) throws -> String {
		guard token == nil else { throw Failure.busy }
		sweep()
		let id = Self.randomHex(16)
		let dir = root.appendingPathComponent(Self.folderPrefix + id, isDirectory: true)
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let token = Self.randomHex(16)
		self.token = token
		self.job = job
		self.cacheVault = cacheVault
		self.served = false
		self.folder = dir
		self.written = [:]
		self.total = 0
		return token
	}

	/// The job's body, once, for its own token.
	func takeJob(token: String) throws -> Data {
		try check(token)
		guard !served, let job else { throw Failure.alreadyServed }
		served = true
		self.job = nil
		return job
	}

	/// One output file, written into the job's folder at `rel`.
	func write(token: String, rel: String, data: Data) throws {
		try check(token)
		guard served, let folder else { throw Failure.unknownToken }
		guard Self.isSafeRelativePath(rel) else { throw Failure.badPath(rel) }
		guard written[rel] == nil else { throw Failure.duplicate(rel) }
		guard written.count < Self.maxFiles else { throw Failure.tooMuch("more than \(Self.maxFiles) files") }
		guard total + data.count <= Self.maxBytes else { throw Failure.tooMuch("more than \(Self.maxBytes / 1024 / 1024) MB") }
		let file = folder.appendingPathComponent(rel)
		// Inside the folder by real path too: nothing in it is a link, but the
		// check costs nothing and holds whatever comes later.
		let dir = file.deletingLastPathComponent()
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let realFolder = folder.resolvingSymlinksInPath().path
		let realDir = dir.resolvingSymlinksInPath().path
		guard realDir == realFolder || realDir.hasPrefix(realFolder + "/") else { throw Failure.badPath(rel) }
		try data.write(to: file, options: .withoutOverwriting)
		written[rel] = data.count
		total += data.count
	}

	/// The page's last word, `{output, files, warnings, ms}` or `{error}`. The
	/// job ends either way; a success keeps its folder for the caller.
	func finish(token: String, body: Data) throws -> Done {
		try check(token)
		guard let folder else { throw Failure.unknownToken }
		let answer = (try? JSONSerialization.jsonObject(with: body)) as? [String: Any]
		guard let answer else {
			abandon()
			throw Failure.malformed("not a JSON object")
		}
		if let error = answer["error"] as? String {
			abandon()
			throw Failure.reported(error)
		}
		guard let output = answer["output"] as? String, let files = answer["files"] as? [String] else {
			abandon()
			throw Failure.malformed("no output or files")
		}
		guard Set(files) == Set(written.keys), files.count == written.count else {
			abandon()
			throw Failure.malformed("the files named are not the files written")
		}
		guard written[output] != nil else {
			abandon()
			throw Failure.malformed("the output \(output) was never written")
		}
		let warnings = (answer["warnings"] as? [Any] ?? []).map { "\($0)" }
		let ms = (answer["ms"] as? NSNumber)?.intValue ?? 0
		let done = Done(folder: folder, output: output, files: written, warnings: warnings, ms: ms)
		end(removing: false)
		return done
	}

	/// The current job ends without a result (a failure, a timeout, a
	/// cancel): its folder goes.
	func abandon() {
		end(removing: true)
	}

	/// A finished job's folder, by its name, removed. Only a folder this
	/// store makes is ever named here.
	@discardableResult
	func discard(folderName: String) -> Bool {
		guard let dir = finishedFolder(named: folderName) else { return false }
		return (try? FileManager.default.removeItem(at: dir)) != nil
	}

	/// A finished job's folder by its name: one this store makes, there, and
	/// not the running job's.
	func finishedFolder(named folderName: String) -> URL? {
		guard folderName.hasPrefix(Self.folderPrefix),
			folderName.dropFirst(Self.folderPrefix.count).allSatisfy(\.isHexDigit),
			folderName.count == Self.folderPrefix.count + 32,
			folder?.lastPathComponent != folderName || token == nil else { return nil }
		let dir = root.appendingPathComponent(folderName, isDirectory: true)
		var isDir: ObjCBool = false
		guard FileManager.default.fileExists(atPath: dir.path, isDirectory: &isDir), isDir.boolValue else { return nil }
		return dir
	}

	// MARK: - The share (L2)

	struct Shared: Equatable {
		/// The file to share: the .tex, or `<name>.zip`.
		let url: URL
		let kind: String
		let bytes: Int
		/// Files in it.
		let entries: Int
		/// Named vault paths not carried: not in the vault, or a path an
		/// output already has.
		let skipped: [String]
	}

	/// A finished job's outputs (`folder`, finishedFolder's answer), shared
	/// as `name`: the .tex alone when that is all there is, else a zip of a
	/// folder `name` holding the outputs, the vault files `include` names at
	/// their paths, and each bibliography in `bibs` at its `as` (beside the
	/// .tex). `copy(rel, to)` copies the vault file `rel` to `to` and says
	/// whether it could: the caller clamps `rel` to the vault
	/// (VaultStore.resolve) and reads it coordinated. Static, and touching
	/// nothing but the folder, so it runs off the main thread.
	static func share(in folder: URL, name: String, output: String, include: [String],
		bibs: [(rel: String, as: String)], copy: (String, URL) throws -> Bool) throws -> Shared {
		let fm = FileManager.default
		let name = Self.shareName(name)
		let isPdf = output.lowercased().hasSuffix(".pdf")
		guard Self.isSafeRelativePath(output), !output.contains("/"), output.lowercased().hasSuffix(".tex") || isPdf,
			fm.fileExists(atPath: folder.appendingPathComponent(output).path) else {
			throw Failure.malformed("no .tex or .pdf named \(output)")
		}
		// PDF via LaTeX: the PDF alone, whatever else was named (the Mac's
		// rule since 2026-10-04: no .aux, .log or figures beside it).
		if isPdf {
			let url = folder.appendingPathComponent(output)
			return Shared(url: url, kind: "pdf", bytes: Self.size(of: url), entries: 1, skipped: [])
		}
		let outputs = try fm.contentsOfDirectory(atPath: folder.path).filter { !$0.hasPrefix(".") }
		if include.isEmpty && bibs.isEmpty && outputs == [output] {
			let url = folder.appendingPathComponent(output)
			return Shared(url: url, kind: "tex", bytes: Self.size(of: url), entries: 1, skipped: [])
		}
		let stage = folder.appendingPathComponent(".share", isDirectory: true).appendingPathComponent(name, isDirectory: true)
		try fm.createDirectory(at: stage, withIntermediateDirectories: true)
		for entry in outputs {
			try fm.moveItem(at: folder.appendingPathComponent(entry), to: stage.appendingPathComponent(entry))
		}
		let realStage = stage.resolvingSymlinksInPath().path
		var skipped: [String] = []
		// One vault file into the stage at `at`: a safe path, nothing hidden
		// (the app page refuses those too: export-references.js), never over
		// what is there (an output, or a file placed already), inside by real
		// path.
		func place(_ rel: String, at: String) throws {
			let dest = Self.isHiddenPath(rel) || Self.isHiddenPath(at) ? nil : stage.appendingPathComponent(at)
			guard let dest, Self.isSafeRelativePath(rel), Self.isSafeRelativePath(at), !fm.fileExists(atPath: dest.path) else {
				return skipped.append(at)
			}
			let dir = dest.deletingLastPathComponent()
			try fm.createDirectory(at: dir, withIntermediateDirectories: true)
			let realDir = dir.resolvingSymlinksInPath().path
			guard realDir == realStage || realDir.hasPrefix(realStage + "/") else { return skipped.append(at) }
			if try !copy(rel, dest) { skipped.append(at) }
		}
		for rel in include { try place(rel, at: rel) }
		for bib in bibs {
			if bib.as.lowercased().hasSuffix(".bib") { try place(bib.rel, at: bib.as) } else { skipped.append(bib.as) }
		}
		var entries = 0
		var total = 0
		for case let url as URL in fm.enumerator(at: stage, includingPropertiesForKeys: [.isRegularFileKey, .fileSizeKey]) ?? NSEnumerator() {
			let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
			guard values?.isRegularFile == true else { continue }
			entries += 1
			total += values?.fileSize ?? 0
		}
		guard entries <= Self.maxFiles else { throw Failure.tooMuch("more than \(Self.maxFiles) files") }
		guard total <= Self.maxBytes else { throw Failure.tooMuch("more than \(Self.maxBytes / 1024 / 1024) MB") }
		let zip = folder.appendingPathComponent(name + ".zip")
		var coordinationError: NSError?
		var zipError: Error?
		// The system's own archive of a folder (a zip whose one top folder is
		// the stage's name), handed over for the block's length only.
		NSFileCoordinator().coordinate(readingItemAt: stage, options: .forUploading, error: &coordinationError) { archive in
			do { try fm.copyItem(at: archive, to: zip) } catch { zipError = error }
		}
		if let error = coordinationError ?? zipError { throw error }
		return Shared(url: zip, kind: "zip", bytes: Self.size(of: zip), entries: entries, skipped: skipped)
	}

	private static func size(of url: URL) -> Int {
		((try? FileManager.default.attributesOfItem(atPath: url.path))?[.size] as? NSNumber)?.intValue ?? 0
	}

	/// What graphicx typesets, and so the only vault files a PDF via LaTeX's
	/// TeX is handed (src/shim/export-references.js's GRAPHIC_EXTS).
	static let graphicExtensions: Set<String> = ["pdf", "png", "jpg", "jpeg", "jbig2", "jb2", "eps", "mps"]

	/// May the running job's page read the vault file `rel` — an image its
	/// .tex names, for TeX (PDF via LaTeX, ExportHost's `vault/` route)? Its
	/// own token, once the job is taken; a safe path, nothing hidden, and only
	/// an image graphicx typesets. The caller still clamps it to the vault.
	func mayRead(token: String, rel: String) -> Bool {
		guard (try? check(token)) != nil, served, Self.isSafeRelativePath(rel), !Self.isHiddenPath(rel) else { return false }
		return Self.graphicExtensions.contains((rel as NSString).pathExtension.lowercased())
	}

	/// A path through a hidden folder or to a hidden file (`.git/config`,
	/// `.obsidian/…`, `.clew/…`): never copied into a share.
	static func isHiddenPath(_ rel: String) -> Bool {
		rel.split(separator: "/").contains { $0.hasPrefix(".") }
	}

	/// A note's name as a file's: no folder separators or colons, no leading
	/// dot, never empty, at most 200 characters.
	static func shareName(_ name: String) -> String {
		var out = name.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
			.replacingOccurrences(of: "\0", with: "")
		while out.hasPrefix(".") { out.removeFirst() }
		out = String(out.prefix(200)).trimmingCharacters(in: .whitespaces)
		return out.isEmpty ? "Export" : out
	}

	/// Every job folder under the root removed (a launch; before a new job).
	func sweep() {
		let names = (try? FileManager.default.contentsOfDirectory(atPath: root.path)) ?? []
		for name in names where name.hasPrefix(Self.folderPrefix) {
			try? FileManager.default.removeItem(at: root.appendingPathComponent(name))
		}
	}

	/// Relative, no `..`, no empty or `.` segment, no backslash or NUL, at
	/// most 512 characters: src/export/outputs.js#isSafeExportPath's rule.
	static func isSafeRelativePath(_ rel: String) -> Bool {
		guard !rel.isEmpty, rel.count <= 512, !rel.hasPrefix("/"),
			!rel.contains("\\"), !rel.contains("\0") else { return false }
		return rel.split(separator: "/", omittingEmptySubsequences: false)
			.allSatisfy { $0 != "" && $0 != "." && $0 != ".." }
	}

	/// The vault whose figure cache the running job's page may read and add
	/// to: its own token, once the job is taken, and only a trusted vault's.
	func cacheVault(token: String) -> String? {
		guard (try? check(token)) != nil, served else { return nil }
		return cacheVault
	}

	private func check(_ given: String) throws {
		guard let token, Self.constantTimeEqual(token, given) else { throw Failure.unknownToken }
	}

	private func end(removing: Bool) {
		if removing, let folder { try? FileManager.default.removeItem(at: folder) }
		token = nil
		job = nil
		cacheVault = nil
		served = false
		if removing { folder = nil }
		written = [:]
		total = 0
	}

	private static func constantTimeEqual(_ a: String, _ b: String) -> Bool {
		let x = Array(a.utf8), y = Array(b.utf8)
		guard x.count == y.count else { return false }
		return zip(x, y).reduce(0) { $0 | ($1.0 ^ $1.1) } == 0
	}

	private static func randomHex(_ bytes: Int) -> String {
		var rng = SystemRandomNumberGenerator()
		return (0..<bytes).map { _ in String(format: "%02x", UInt8.random(in: 0...255, using: &rng)) }.joined()
	}
}

/// The export figure cache, as desktop's main/export-cache.js keeps it (the
/// owner's "Outside", 2026-10-06): the figures a TRUSTED vault's exports drew,
/// kept between them in the app's Caches, so a re-export draws only the
/// figures that changed. jmarkdown's figure engine names each by its source
/// (`<kind>/<md5>-<n>.<ext>`) and looks for it in the build's cache folder
/// before drawing; the export worker lists this vault's (`GET cache/<token>`),
/// reads a file only when the engine does, and hands back what it drew. A
/// RESTRICTED vault's exports keep theirs in the worker, for the export alone,
/// as desktop's keep theirs in a temporary folder removed when it ends.
///
/// - Each vault has a folder of its own, named as desktop names it: the first
///   16 hex digits of the SHA-256 of its identity (vaultCacheDir).
/// - Everything sits under the staged mp-tikz-wasm's stamp: on the iPad the
///   figure engine cannot fingerprint the library (it has no dist folder to
///   read), so a new release would otherwise reuse the old one's figures. A
///   folder for another stamp is removed at the next prune.
/// - Pruned before each export, never during one, as desktop's: least
///   recently used first (an export marks the files it used), to `limit`.
struct ExportCache {
	/// Every vault's together. Desktop's is 500 MB; an iPad's storage is
	/// smaller, the figures are small (the 40-figure note's are 1.3 MB), and
	/// iOS may purge Caches when it needs the room anyway.
	static let limit = 100 * 1024 * 1024

	/// …/Caches/export-cache
	let root: URL
	/// The staged mp-tikz-wasm's stamp (its archive's SHA-256, shortened).
	let library: String

	var base: URL { root.appendingPathComponent(library, isDirectory: true) }

	/// A vault's folder name: desktop's vaultCacheDir.
	static func vaultKey(_ identity: String) -> String {
		SHA256.hash(data: Data(identity.utf8)).map { String(format: "%02x", $0) }.joined().prefix(16).description
	}

	func dir(identity: String) -> URL {
		base.appendingPathComponent(Self.vaultKey(identity), isDirectory: true)
	}

	/// A cached figure's path: `<kind>/<file>`, exactly two plain segments,
	/// neither hidden (a compile's `.run-*` folder is the engine's own).
	static func isFigurePath(_ rel: String) -> Bool {
		let parts = rel.split(separator: "/", omittingEmptySubsequences: false)
		let plain = { (s: Substring) in
			!s.isEmpty && s.count <= 200 && !s.hasPrefix(".")
				&& s.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "-_.".contains($0)) }
		}
		return parts.count == 2 && parts.allSatisfy(plain)
	}

	/// The vault's cached figures, `<kind>/<file>` with their sizes.
	func list(identity: String) -> [(rel: String, bytes: Int)] {
		let fm = FileManager.default
		let vault = dir(identity: identity)
		var out: [(rel: String, bytes: Int)] = []
		for kind in (try? fm.contentsOfDirectory(atPath: vault.path)) ?? [] {
			for file in (try? fm.contentsOfDirectory(atPath: vault.appendingPathComponent(kind).path)) ?? [] {
				let rel = "\(kind)/\(file)"
				guard Self.isFigurePath(rel),
					let attrs = try? fm.attributesOfItem(atPath: vault.appendingPathComponent(rel).path),
					attrs[.type] as? FileAttributeType == .typeRegular else { continue }
				out.append((rel: rel, bytes: (attrs[.size] as? NSNumber)?.intValue ?? 0))
			}
		}
		return out.sorted { $0.rel < $1.rel }
	}

	/// A cached figure's file, or nil.
	func url(identity: String, rel: String) -> URL? {
		guard Self.isFigurePath(rel) else { return nil }
		let url = dir(identity: identity).appendingPathComponent(rel)
		return FileManager.default.fileExists(atPath: url.path) ? url : nil
	}

	/// A figure the export drew, kept for the vault's next.
	func store(identity: String, rel: String, data: Data) throws {
		guard Self.isFigurePath(rel) else { throw ExportJobs.Failure.badPath(rel) }
		let url = dir(identity: identity).appendingPathComponent(rel)
		try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		try data.write(to: url, options: .atomic)
	}

	/// The figures an export used, used now: the prune keeps them longest.
	func markUsed(identity: String, rels: [String], now: Date = Date()) {
		for rel in rels where Self.isFigurePath(rel) {
			try? FileManager.default.setAttributes([.modificationDate: now], ofItemAtPath: dir(identity: identity).appendingPathComponent(rel).path)
		}
	}

	/// Keep the cache under `limit`: another library's folder goes whole, then
	/// the least recently used files, then any folder left empty.
	@discardableResult
	func prune(limit: Int = ExportCache.limit) -> (removed: Int, bytes: Int) {
		let fm = FileManager.default
		for stamp in (try? fm.contentsOfDirectory(atPath: root.path)) ?? [] where stamp != library {
			try? fm.removeItem(at: root.appendingPathComponent(stamp))
		}
		var files: [(url: URL, bytes: Int, modified: Date)] = []
		var dirs: [URL] = []
		if let walker = fm.enumerator(at: base, includingPropertiesForKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey]) {
			for case let url as URL in walker {
				let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .fileSizeKey, .contentModificationDateKey])
				if values?.isDirectory == true { dirs.append(url); continue }
				files.append((url: url, bytes: values?.fileSize ?? 0, modified: values?.contentModificationDate ?? .distantPast))
			}
		}
		var bytes = files.reduce(0) { $0 + $1.bytes }
		var removed = 0
		if bytes > limit {
			for file in files.sorted(by: { $0.modified < $1.modified }) {
				if bytes <= limit { break }
				if (try? fm.removeItem(at: file.url)) != nil { bytes -= file.bytes; removed += 1 }
			}
		}
		for dir in dirs.sorted(by: { $0.path.count > $1.path.count }) {
			if ((try? fm.contentsOfDirectory(atPath: dir.path)) ?? ["x"]).isEmpty { try? fm.removeItem(at: dir) }
		}
		return (removed, bytes)
	}
}
