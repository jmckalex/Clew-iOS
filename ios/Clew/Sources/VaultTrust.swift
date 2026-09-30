// The interim vault-trust guard, iOS half (Clew-app main/vault-trust.js at
// e8d32e6; docs/dev/frame-bridge.md §4): a vault new to this device runs no
// note code — the engine's `Run note code` switch is off in its generated
// config — until the user trusts it. Every vault the device already knew at
// the upgrade stays trusted silently (migrate), and Clew's own vaults (the
// demo, one made in-app) are trusted by construction.
//
// The store lives ON THE DEVICE, in Application Support, never in the vault
// (a trust flag inside a vault would travel with it). Keyed by a device-side
// identity the VAULT never chooses (§4.3), with no absolute container path:
// the app container moves on every install (measured), so a vault in
// Documents is keyed by its path inside Documents; a vault elsewhere (Files,
// iCloud Drive — outside our container, where paths do not rotate) by its
// resolved path. The fingerprint is the root's creation time — a different
// folder at a trusted identity asks again — and deliberately not the inode,
// which a container move is not guaranteed to keep.
//
// Foundation only, so ios/Tests/VaultTrust runs it on the Mac with temp dirs.
import Foundation

final class VaultTrustStore {
	static let storeVersion = 1

	struct Fingerprint: Codable, Equatable {
		var birth: Double   // the root directory's creation time, ms
	}

	struct Entry: Codable, Equatable {
		var trusted: Bool
		var fingerprint: Fingerprint?
		var source: String       // "migrated" | "user" | "demo" | "created"
		var at: String
	}

	private struct Store: Codable {
		var version: Int
		var migratedAt: String?
		var vaults: [String: Entry]
	}

	let file: URL
	let documentsURL: URL
	private let now: () -> Date
	private let persist: Bool
	private var data: Store?
	private let lock = NSLock()

	init(file: URL, documentsURL: URL, persist: Bool = true, now: @escaping () -> Date = Date.init) {
		self.file = file
		self.documentsURL = documentsURL
		self.persist = persist
		self.now = now
	}

	private func stamp() -> String { ISO8601DateFormatter().string(from: now()) }

	private func canonical(_ url: URL) -> String {
		url.resolvingSymlinksInPath().standardizedFileURL.path
	}

	/// The device-side identity: `documents:<path inside Documents>` for a
	/// vault in this app's Documents, `path:<resolved path>` otherwise.
	func identity(_ root: URL) -> String {
		let docs = canonical(documentsURL)
		let path = canonical(root)
		if path.hasPrefix(docs + "/") { return "documents:" + String(path.dropFirst(docs.count + 1)) }
		return "path:" + path
	}

	static func fingerprint(_ root: URL) -> Fingerprint? {
		// A fresh URL, uncached: resourceValues caches per URL instance, so a
		// folder replaced under a URL still in hand would keep the old time.
		var url = URL(fileURLWithPath: root.path, isDirectory: true)
		url.removeAllCachedResourceValues()
		guard let values = try? url.resourceValues(forKeys: [.creationDateKey, .isDirectoryKey]),
			values.isDirectory == true, let created = values.creationDate else { return nil }
		return Fingerprint(birth: (created.timeIntervalSince1970 * 1000).rounded())
	}

	// Callers hold `lock`.
	private func load() -> Store {
		if let data { return data }
		var loaded: Store
		if let raw = try? Data(contentsOf: file) {
			if let store = try? JSONDecoder().decode(Store.self, from: raw) {
				loaded = store
			} else {
				// Unreadable: start empty AND call it migrated, so a damaged
				// file can never re-trust a vault its owner had revoked.
				NSLog("clew: %@ unreadable; every vault now asks again", file.path)
				loaded = Store(version: Self.storeVersion, migratedAt: stamp(), vaults: [:])
			}
		} else {
			// Missing: a first launch, which migrate() fills.
			loaded = Store(version: Self.storeVersion, migratedAt: nil, vaults: [:])
		}
		data = loaded
		return loaded
	}

	private func save() {
		guard persist, let data, let encoded = try? JSONEncoder().encode(data) else { return }
		try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
		try? encoded.write(to: file, options: .atomic)
	}

	/// Once per device: every vault it already knows becomes trusted. One not
	/// reachable right now is recorded without a fingerprint and takes the one
	/// it has when next opened. Answers how many were recorded (0 once done).
	@discardableResult
	func migrate(_ known: [URL]) -> Int {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		guard store.migratedAt == nil else { return 0 }
		var count = 0
		for root in known {
			let key = identity(root)
			if store.vaults[key] != nil { continue }
			store.vaults[key] = Entry(trusted: true, fingerprint: Self.fingerprint(root), source: "migrated", at: stamp())
			count += 1
		}
		store.migratedAt = stamp()
		data = store
		save()
		return count
	}

	/// Does this device trust the vault at `root`, as it is on disk now?
	func isTrusted(_ root: URL) -> Bool {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		let key = identity(root)
		guard var entry = store.vaults[key], entry.trusted else { return false }
		guard let current = Self.fingerprint(root) else { return false }
		guard let recorded = entry.fingerprint else {
			// Migrated while it was away: this is the first sight of it.
			entry.fingerprint = current
			store.vaults[key] = entry
			data = store
			save()
			return true
		}
		return recorded == current
	}

	/// The user said so (the banner, Settings), or Clew made the vault.
	func trust(_ root: URL, source: String = "user") { record(root, trusted: true, source: source) }

	func revoke(_ root: URL) { record(root, trusted: false, source: "user") }

	private func record(_ root: URL, trusted: Bool, source: String) {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		store.vaults[identity(root)] = Entry(trusted: trusted, fingerprint: Self.fingerprint(root), source: source, at: stamp())
		data = store
		save()
	}

	func entries() -> [String: Entry] {
		lock.lock(); defer { lock.unlock() }
		return load().vaults
	}

	var hasMigrated: Bool {
		lock.lock(); defer { lock.unlock() }
		return load().migratedAt != nil
	}
}
