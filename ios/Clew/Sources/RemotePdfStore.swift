// Web PDFs, the store (Clew-app docs/dev/pdf-unification.md §4, §8).
//
// - REGISTRATION, not a proxy: the app page's render registers the remote
//   PDF URLs it found (over the bridge, which answers the app page alone);
//   each is kept for THIS session under sha256(url), and SchemeHandler's
//   `__clew_remote_pdf__/<hash>` serves a registered hash and nothing else.
//   No page, script or frame can name a URL for Clew to fetch.
// - The cache lives on the DEVICE (Library/Caches/remote-pdfs, purgeable),
//   never in the vault: `.clew/` travels with a vault, so a shared vault
//   could otherwise arrive with a planted copy served as that URL's bytes.
//   Keyed by sha256(url) alone — no path, nothing absolute — and shared by
//   every vault on the device. 1 GB, least recently used evicted first.
// - A cached copy is served at once; a registration revalidates it
//   (conditional GET) at most once a day; "Reload from the web" refetches.
import CryptoKit
import Foundation

final class RemotePdfStore {
	static let shared = RemotePdfStore()

	static let cacheCap: Int64 = 1_000_000_000
	static let revalidateAfter: TimeInterval = 24 * 60 * 60

	struct Meta: Codable {
		var url: String
		var finalURL: String?
		var fetchedAt: Double
		var etag: String?
		var lastModified: String?
		var size: Int
		var lastUsed: Double
		/// The last revalidation's failure, if the copy is now older than it
		/// should be (the viewer marks it "saved copy from <date>").
		var staleReason: String?
	}

	enum Served {
		case file(URL, meta: Meta)
		case failure(RemotePdfError)
	}

	let dir: URL
	private let work = DispatchQueue(label: "org.jmckalex.clew.remote-pdf.work", attributes: .concurrent)
	private let state = DispatchQueue(label: "org.jmckalex.clew.remote-pdf.state")
	// Guarded by `state`.
	private var session: [String: URL] = [:]
	private var waiting: [String: [(Served) -> Void]] = [:]

	private init() {
		let caches = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
		dir = caches.appendingPathComponent("remote-pdfs", isDirectory: true)
		try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
	}

	static func hash(_ url: String) -> String {
		SHA256.hash(data: Data(url.utf8)).map { String(format: "%02x", $0) }.joined()
	}

	private func pdfURL(_ hash: String) -> URL { dir.appendingPathComponent("\(hash).pdf") }
	private func metaURL(_ hash: String) -> URL { dir.appendingPathComponent("\(hash).json") }

	private func readMeta(_ hash: String) -> Meta? {
		guard let data = try? Data(contentsOf: metaURL(hash)) else { return nil }
		return try? JSONDecoder().decode(Meta.self, from: data)
	}

	private func writeMeta(_ meta: Meta, _ hash: String) {
		if let data = try? JSONEncoder().encode(meta) { try? AtomicFile.write(data, to: metaURL(hash)) }
	}

	// MARK: - The session

	/// A new vault opening is a new session (VaultStore.newSession): the old
	/// registrations die with its sid and token.
	func resetSession() {
		state.sync { session.removeAll() }
	}

	/// Registers the URLs a render found; answers `registered` {url: hash}
	/// and `refused` {url: reason}. Prefetches what is not cached and
	/// revalidates what is older than a day, in the background.
	///
	/// Every http(s) URL is registered, as desktop's registerRemotePdf does:
	/// the policy (https only, the address guard) is the FETCH's, applied
	/// before any connection, so a refused one still opens the viewer, which
	/// names the refusal and offers Open in browser (§8: "insecure address —
	/// open in browser"). Refused here: only what is not a web URL at all.
	/// The hash is of the URL exactly as the render met it — the shared
	/// rewrite looks it up by that string.
	func register(_ urls: [String]) -> [String: [String: String]] {
		var registered: [String: String] = [:]
		var refused: [String: String] = [:]
		for text in urls {
			guard let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
				refused[text] = "bad-url"; continue
			}
			let hash = Self.hash(text)
			state.sync { session[hash] = url }
			registered[text] = hash
			let meta = readMeta(hash)
			let cached = meta != nil && FileManager.default.fileExists(atPath: pdfURL(hash).path)
			if !cached {
				fetch(hash, url: url, conditional: nil) { _ in }
			} else if let meta, Date().timeIntervalSince1970 - meta.fetchedAt > Self.revalidateAfter {
				fetch(hash, url: url, conditional: meta) { _ in }
			}
		}
		return ["registered": registered, "refused": refused]
	}

	func isRegistered(_ hash: String) -> Bool { state.sync { session[hash] != nil } }

	/// The URL this session registered under `hash` (Open in browser): the
	/// viewer names only the hash, never a URL.
	func url(for hash: String) -> URL? { state.sync { session[hash] } }

	// MARK: - Serving

	/// For SchemeHandler: nil for a hash this session did not register;
	/// otherwise the cached copy at once, or — still downloading — the
	/// download's outcome when it lands.
	func serve(_ hash: String, completion: @escaping (Served) -> Void) -> Bool {
		guard let url = state.sync(execute: { session[hash] }) else { return false }
		if var meta = readMeta(hash), FileManager.default.fileExists(atPath: pdfURL(hash).path) {
			meta.lastUsed = Date().timeIntervalSince1970
			writeMeta(meta, hash)
			completion(.file(pdfURL(hash), meta: meta))
			return true
		}
		fetch(hash, url: url, conditional: nil, completion: completion)
		return true
	}

	/// "Reload from the web": refetch now, keeping the old copy on failure.
	func refresh(_ hash: String, completion: @escaping (Served) -> Void) -> Bool {
		guard let url = state.sync(execute: { session[hash] }) else { return false }
		fetch(hash, url: url, conditional: nil, completion: completion)
		return true
	}

	// MARK: - Fetching (one download per hash, whoever is waiting)

	private func fetch(_ hash: String, url: URL, conditional: Meta?, completion: @escaping (Served) -> Void) {
		let first: Bool = state.sync {
			let isFirst = waiting[hash] == nil
			waiting[hash, default: []].append(completion)
			return isFirst
		}
		guard first else { return }
		work.async { [self] in
			let result = download(hash, url: url, conditional: conditional)
			let callbacks = state.sync { waiting.removeValue(forKey: hash) ?? [] }
			for callback in callbacks { callback(result) }
		}
	}

	private func download(_ hash: String, url: URL, conditional: Meta?) -> Served {
		let fetch = RemotePdfFetch(resolver: SystemResolver(), transport: NetworkTransport(scratchDir: dir),
			userAgent: "Clew/\(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?")")
		let now = Date().timeIntervalSince1970
		do {
			switch try fetch.run(url, etag: conditional?.etag, lastModified: conditional?.lastModified) {
			case .notModified:
				guard var meta = conditional else { throw RemotePdfError.network("not modified, but nothing cached") }
				meta.fetchedAt = now
				meta.lastUsed = now
				meta.staleReason = nil
				writeMeta(meta, hash)
				return .file(pdfURL(hash), meta: meta)
			case .fetched(let response, let finalURL):
				guard let body = response.bodyFile else { throw RemotePdfError.network("no body") }
				let target = pdfURL(hash)
				try? FileManager.default.removeItem(at: target)
				try FileManager.default.moveItem(at: body, to: target)
				let meta = Meta(url: url.absoluteString, finalURL: finalURL.absoluteString, fetchedAt: now,
					etag: response.headers["etag"], lastModified: response.headers["last-modified"],
					size: response.bytes, lastUsed: now, staleReason: nil)
				writeMeta(meta, hash)
				evict(keeping: hash)
				return .file(target, meta: meta)
			}
		} catch {
			let failure = error as? RemotePdfError ?? .network(error.localizedDescription)
			// Offline WITH a copy: the copy, marked by why it is stale.
			if var meta = readMeta(hash), FileManager.default.fileExists(atPath: pdfURL(hash).path) {
				meta.staleReason = "\(failure.code): \(failure.detail)"
				writeMeta(meta, hash)
				return .file(pdfURL(hash), meta: meta)
			}
			return .failure(failure)
		}
	}

	/// Least recently used first, down to the cap; never the one just stored.
	private func evict(keeping: String) {
		let fm = FileManager.default
		guard let names = try? fm.contentsOfDirectory(atPath: dir.path) else { return }
		var entries: [(hash: String, size: Int64, used: Double)] = []
		for name in names where name.hasSuffix(".pdf") {
			let hash = String(name.dropLast(4))
			let attributes = try? fm.attributesOfItem(atPath: pdfURL(hash).path)
			let size = (attributes?[.size] as? NSNumber)?.int64Value ?? 0
			entries.append((hash, size, readMeta(hash)?.lastUsed ?? 0))
		}
		var total = entries.reduce(Int64(0)) { $0 + $1.size }
		for entry in entries.sorted(by: { $0.used < $1.used }) where total > Self.cacheCap && entry.hash != keeping {
			try? fm.removeItem(at: pdfURL(entry.hash))
			try? fm.removeItem(at: metaURL(entry.hash))
			total -= entry.size
		}
	}

	// MARK: - Save a copy to the vault

	/// Copies a registered hash's cached PDF into `folder` (the vault's
	/// attachment folder), named from the URL, NEVER overwriting — a binary
	/// write through the vault, never the text-note bridge. Answers the new
	/// vault-relative path.
	func saveCopy(_ hash: String, folder: String, into vaults: VaultStore) throws -> [String: Any] {
		guard let url = state.sync(execute: { session[hash] }) else { throw ClewError.badPayload }
		let source = pdfURL(hash)
		guard FileManager.default.fileExists(atPath: source.path) else { throw ClewError.badPayload }
		let cleanFolder = folder.split(separator: "/").filter { $0 != "." && $0 != ".." && !$0.isEmpty }.joined(separator: "/")
		guard !cleanFolder.hasPrefix(".clew") else { throw ClewError.badPayload }
		var base = (url.deletingPathExtension().lastPathComponent.removingPercentEncoding ?? "document")
			.components(separatedBy: CharacterSet(charactersIn: "/\\:*?\"<>|")).joined(separator: "-")
			.trimmingCharacters(in: .whitespacesAndNewlines)
		if base.isEmpty || base.hasPrefix(".") { base = "document" + base }
		let prefix = cleanFolder.isEmpty ? "" : cleanFolder + "/"
		// writeBinaryFile never overwrites: an existing name becomes "name 1".
		return try vaults.writeBinaryFile(rel: "\(prefix)\(base).pdf", from: source)
	}
}
