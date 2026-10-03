// Vault trust on this device, the iOS half (Clew-app main/vault-trust.js,
// store version 2 at f3a7d5b; docs/dev/frame-bridge.md §4): a vault new to
// this device runs none of its own code until the user trusts it, and what
// a trusted vault may run — its scripts, its plugins, the Note API,
// dataviewJs, the network — is ENABLED here, per vault, never read as a
// grant from the vault's own vault-settings.json (that is only its REQUEST).
// Every vault the device already knew at the upgrade stays trusted silently
// (migrate), and on first sight copies what its settings enabled (legacy);
// Clew's own vaults (the demo, one made in-app) are trusted by construction.
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
	static let storeVersion = 2

	/// What a vault may ASK for, and the device may enable (§4.6).
	static let enableKeys = ["scripts", "plugins", "noteApi", "dataviewJs", "network"]

	/// The device's enablement record for one vault.
	struct Enable: Codable, Equatable {
		var scripts: Bool
		var plugins: [String]
		var noteApi: Bool
		var dataviewJs: Bool
		var network: Bool

		/// A request (vault-settings.json, or what the user ticked) as a
		/// record: only well-formed values. Vault scripts have no request
		/// key — a vault asks for them by having them — so `scripts` is the
		/// caller's default (desktop's normalizeEnable).
		static func normalize(_ raw: [String: Any]?, scripts: Bool = true) -> Enable {
			let ids = (raw?["plugins"] as? [Any] ?? []).compactMap { $0 as? String }
				.filter { $0.range(of: "^[a-z0-9][a-z0-9-]{0,63}$", options: .regularExpression) != nil }
			var unique: [String] = []
			for id in ids where !unique.contains(id) { unique.append(id) }
			return Enable(
				scripts: (raw?["scripts"] as? Bool) ?? scripts,
				plugins: unique,
				noteApi: raw?["noteApi"] as? Bool == true,
				dataviewJs: raw?["dataviewJs"] as? Bool == true,
				network: raw?["network"] as? Bool == true)
		}

		var dictionary: [String: Any] {
			["scripts": scripts, "plugins": plugins, "noteApi": noteApi, "dataviewJs": dataviewJs, "network": network]
		}
	}

	/// What may run (desktop's effectiveAccess): trust gates the vault's own
	/// code; the plugin ids stay as enabled (which of them may load — a
	/// global one always, a vault one only when trusted — is decided where
	/// plugins are listed).
	static func effectiveAccess(trusted: Bool, enable: Enable?, decided: Bool) -> [String: Any] {
		let e = enable ?? Enable.normalize([:], scripts: false)
		return [
			"trusted": trusted,
			"scripts": trusted && e.scripts,
			"plugins": e.plugins,
			"noteApi": trusted && e.noteApi,
			"dataviewJs": trusted && e.dataviewJs,
			"network": trusted && e.network,
			"decided": decided,
		]
	}

	struct Fingerprint: Codable, Equatable {
		var birth: Double   // the root directory's creation time, ms
	}

	struct Entry: Codable, Equatable {
		var trusted: Bool
		var fingerprint: Fingerprint?
		var source: String       // "migrated" | "user" | "demo" | "created"
		var at: String
		/// nil (a version-1 entry) counts as decided.
		var decided: Bool?
		/// nil: an entry made before enablements lived here (legacy).
		var enable: Enable?
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

	/// The user said so (the prompt, Settings), or Clew made the vault.
	/// `enable` (the prompt's yes passes the vault's request) replaces the
	/// enablements; otherwise those of this same vault are kept.
	func trust(_ root: URL, source: String = "user", enable: Enable? = nil) {
		record(root, trusted: true, source: source, enable: enable)
	}

	/// Restricted, as the user's decision (Keep restricted, Revoke): the
	/// enablements are kept, for a later trust.
	func revoke(_ root: URL) { record(root, trusted: false, source: "user", enable: nil) }

	/// Is the entry about THIS vault — the one on disk now? A missing
	/// fingerprint (migrated while away) is taken from the first sight.
	/// Callers hold `lock`; `store` is written back by them.
	private func isCurrent(_ entry: inout Entry, _ root: URL) -> Bool {
		guard let fp = Self.fingerprint(root) else { return false }
		guard let recorded = entry.fingerprint else {
			entry.fingerprint = fp
			return true
		}
		return recorded == fp
	}

	/// What the vault at `root` may run here, and whether this device has
	/// DECIDED about it (one never decided gets the prompt). `requests` is
	/// the vault's own request (its vault-settings.json): read only to fill
	/// a legacy entry once, never as a grant.
	func accessFor(_ root: URL, requests: [String: Any]?) -> [String: Any] {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		let key = identity(root)
		guard var entry = store.vaults[key], isCurrent(&entry, root) else {
			return Self.effectiveAccess(trusted: false, enable: nil, decided: false)
		}
		if entry.enable == nil, let requests {
			// This device ran whatever its settings enabled: copied once, the
			// network on for a trusted vault (no CSP existed), and the
			// decision counts as made (§4.8).
			var enable = Enable.normalize(requests, scripts: true)
			if entry.trusted { enable.network = true }
			entry.enable = enable
			entry.decided = true
		}
		store.vaults[key] = entry
		data = store
		save()
		return Self.effectiveAccess(trusted: entry.trusted, enable: entry.enable, decided: entry.decided != false)
	}

	/// The device's enablement record (not gated by trust).
	func enablements(_ root: URL) -> Enable {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		let key = identity(root)
		guard var entry = store.vaults[key], isCurrent(&entry, root), let enable = entry.enable else {
			return Enable.normalize([:], scripts: true)
		}
		store.vaults[key] = entry
		data = store
		return enable
	}

	/// One enablement changed (Settings → This vault). A vault never decided
	/// about stays undecided: switching on a global plugin for it is not an
	/// answer to the trust prompt.
	@discardableResult
	func setEnable(_ root: URL, patch: [String: Any]) -> Enable {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		let key = identity(root)
		var entry: Entry
		if var existing = store.vaults[key], isCurrent(&existing, root) {
			entry = existing
		} else {
			entry = Entry(trusted: false, fingerprint: Self.fingerprint(root), source: "user", at: stamp(),
				decided: false, enable: Enable.normalize([:], scripts: true))
		}
		var merged = entry.enable?.dictionary ?? Enable.normalize([:], scripts: true).dictionary
		for (k, v) in patch where Self.enableKeys.contains(k) { merged[k] = v }
		entry.enable = Enable.normalize(merged, scripts: true)
		store.vaults[key] = entry
		data = store
		save()
		return entry.enable!
	}

	/// The folder an identity names: `documents:<rel>` inside this app's
	/// Documents, `path:<p>` anywhere else.
	func rootURL(forKey key: String) -> URL? {
		if key.hasPrefix("documents:") {
			return documentsURL.appendingPathComponent(String(key.dropFirst("documents:".count)), isDirectory: true)
		}
		if key.hasPrefix("path:") { return URL(fileURLWithPath: String(key.dropFirst("path:".count)), isDirectory: true) }
		return nil
	}

	/// Forget by the stored key itself (Settings → Trusted vaults, a vault
	/// no longer on disk): its next open is a first open.
	func forgetKey(_ key: String) {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		guard store.vaults.removeValue(forKey: key) != nil else { return }
		data = store
		save()
	}

	/// True ONCE, for a store that predates the full design (version 1):
	/// the one-time notice says what changed. A fresh store never shows it.
	func takeNotice() -> Bool {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		guard store.version < Self.storeVersion else { return false }
		store.version = Self.storeVersion
		data = store
		save()
		return true
	}

	/// A vault Clew made and removed again unused (a cancelled switch to a
	/// new vault): its entry goes with it.
	func forget(_ root: URL) {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		guard store.vaults.removeValue(forKey: identity(root)) != nil else { return }
		data = store
		save()
	}

	private func record(_ root: URL, trusted: Bool, source: String, enable: Enable?) {
		lock.lock(); defer { lock.unlock() }
		var store = load()
		let key = identity(root)
		// A new vault at a known identity keeps nothing of the old one.
		var keep: Enable? = nil
		if var old = store.vaults[key], isCurrent(&old, root) { keep = old.enable }
		store.vaults[key] = Entry(trusted: trusted, fingerprint: Self.fingerprint(root), source: source, at: stamp(),
			decided: true, enable: enable ?? keep ?? Enable.normalize([:], scripts: true))
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
