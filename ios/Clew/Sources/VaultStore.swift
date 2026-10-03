// Vault registry and filesystem state on the Swift side.
//
// Vaults come from three places, all funneling into the same open/mirror/
// rescan machinery:
//   1. The app's Documents directory (seeded demo vault; folders dropped in
//      via the Files app / Finder sharing — UIFileSharingEnabled).
//   2. Folders picked with the document picker anywhere Files can reach —
//      iCloud Drive, Working Copy repos, other providers — held onto with
//      security-scoped bookmarks and opened in place.
//   3. (Same as 2 at this layer) whatever the JS recents list re-opens.
//
// The JS layer mirrors the open vault's text files in memory; this class
// does the real IO: the bulk snapshot at open, coordinated write-through
// persistence, and mtime-diff rescans for external changes (Files app,
// iCloud sync, git pulls) that replace the desktop's chokidar watcher.
// iCloud content that isn't local yet ("evicted", shown as .name.icloud
// placeholders) is requested and awaited for text files at snapshot time,
// and materialized on demand when the scheme handler serves binaries.
import Foundation
import Security

final class VaultStore {
	/// Absolute path of the currently open vault (set by vaultOpen).
	private(set) var currentVaultPath: String?
	/// The open vault's REAL root (POSIX realpath, VaultPaths): what every
	/// vault path is clamped to, links followed.
	private var currentVaultRealRoot: String?
	/// Links in the open vault that lead out of it (or dangle), by vault
	/// path → where they lead ("" when nowhere). Never followed; reported to
	/// the app page so a missing file can be explained.
	private(set) var refusedLinks: [String: String] = [:]
	/// rel path -> mtimeMs at last snapshot/rescan, text files only. Read
	/// and written on `ioQueue` (writes, rescans and opens all run there).
	private var knownMtimes: [String: Double] = [:]
	/// The same for the vault's PDFs (the walk, the rescan, a save): what a
	/// guarded PDF save compares, so an annotation saved over a version this
	/// app has not seen is refused, as a text save is. `ioQueue` only.
	private var knownPdfMtimes: [String: Double] = [:]
	/// Files with unresolved iCloud conflict versions (the walk's
	/// ubiquitousItemHasUnresolvedConflicts), reported to the shim.
	private(set) var cloudConflicts = Set<String>()
	/// The security-scoped URL whose access we currently hold, if any.
	private var activeScopedURL: URL?

	let ioQueue = DispatchQueue(label: "org.jmckalex.clew.vault-io", qos: .userInitiated)

	// MARK: - The session (Clew-app main/session.js, main/caller-token.js)

	/// The preview URLs' `/<sid>/` segment, random so a frame not handed a
	/// URL cannot build one; empty until the first vault opens.
	private(set) var sessionId = ""
	/// The render POSTs' caller token: 32 random bytes, hex. Memory only —
	/// never persisted, logged, or put in a URL; the app page receives it
	/// through the bridge (main frame only), and hands it to its own frames.
	private(set) var callerToken = ""

	/// A new session for a vault opening: the old vault's preview URLs and
	/// token die with it. Main thread (the scheme handler reads both there).
	func newSession() {
		sessionId = "s" + Self.randomHex(16)
		callerToken = Self.randomHex(32)
		// Web-PDF registrations are the session's too.
		RemotePdfStore.shared.resetSession()
	}

	private static func randomHex(_ count: Int) -> String {
		var bytes = [UInt8](repeating: 0, count: count)
		precondition(SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess, "no randomness")
		return bytes.map { String(format: "%02x", $0) }.joined()
	}

	static let textExtensions: Set<String> = [
		"md", "jmd", "bib", "canvas", "json", "css", "js", "mjs", "txt", "csl",
		"xml", "yaml", "yml", "svg", "html", "gpx", "geojson", "tex", "org", "csv",
	]

	static let ignoredNames: Set<String> = [".DS_Store", "node_modules"]
	private static let bookmarksKey = "vaultBookmarks"

	var documentsURL: URL {
		FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
	}

	/// Globally installed plugins: Documents/Plugins — the one place a user
	/// can put files from the Files app (desktop's <userData>/plugins would
	/// be unreachable here). Installed by the USER, never by Clew or a
	/// vault; enabling stays per vault, exactly as upstream (main/plugins.js).
	var globalPluginsURL: URL {
		documentsURL.appendingPathComponent("Plugins", isDirectory: true)
	}

	/// Documents/Plugins, created if missing — the target of "Open global
	/// plugin folder". Returns the path.
	func ensureGlobalPluginsFolder() throws -> String {
		let url = globalPluginsURL
		try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
		return url.path
	}

	// MARK: - Vault trust (VaultTrust.swift, frame-bridge.md §4)

	private let accessLock = NSLock()
	private var currentAccess: [String: Any] = VaultTrustStore.effectiveAccess(trusted: false, enable: nil, decided: false)

	/// What the open vault may run on this device (desktop's session.access):
	/// SchemeHandler reads it to inject vault scripts and plugins, and for
	/// the preview CSP; the shim gets it with vaultOpen.
	var access: [String: Any] {
		accessLock.lock(); defer { accessLock.unlock() }
		return currentAccess
	}
	var accessTrusted: Bool { access["trusted"] as? Bool == true }
	var accessScripts: Bool { access["scripts"] as? Bool == true }
	var accessNetwork: Bool { access["network"] as? Bool == true }
	var accessPlugins: [String] { access["plugins"] as? [String] ?? [] }

	/// Re-read the open vault's access from the store (after a decision or
	/// an enablement changed).
	@discardableResult
	func refreshAccess() -> [String: Any] {
		var next = VaultTrustStore.effectiveAccess(trusted: false, enable: nil, decided: false)
		if let path = currentVaultPath {
			let root = URL(fileURLWithPath: path, isDirectory: true)
			next = trust.accessFor(root, requests: Self.readRequests(root))
		}
		accessLock.lock(); currentAccess = next; accessLock.unlock()
		return next
	}

	/// What the vault at `root` ASKS to run (desktop's vault-requests.js):
	/// its vault-settings.json keys `plugins`, `noteApi`, `dataviewJs`,
	/// `network`. A missing file is an empty request; an unreadable one nil.
	static func readRequests(_ root: URL) -> [String: Any]? {
		let file = root.appendingPathComponent(".clew/vault-settings.json")
		guard FileManager.default.fileExists(atPath: file.path) else { return [:] }
		guard let data = try? Data(contentsOf: file) else { return nil }
		guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return [:] }
		return [
			"plugins": (object["plugins"] as? [Any] ?? []).compactMap { $0 as? String },
			"noteApi": object["noteApi"] as? Bool == true,
			"dataviewJs": object["dataviewJs"] as? Bool == true,
			"network": object["network"] as? Bool == true,
		]
	}

	/// The device's trust store, in Application Support. Created on first use
	/// (WebHost touches it on the main thread at launch, so the I/O queue and
	/// main never race to create it); a device's first launch with it
	/// migrates every vault the device already knows as trusted.
	lazy var trust: VaultTrustStore = {
		let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
		let store = VaultTrustStore(file: support.appendingPathComponent("vault-trust.json"), documentsURL: documentsURL)
		if !store.hasMigrated { store.migrate(knownVaults()) }
		return store
	}()

	/// Every vault this device already knows: those it opened in Documents
	/// (Clew leaves a `.clew/` in a vault it opens) and every external vault
	/// it holds a bookmark for — an external vault cannot be reopened
	/// without one, so this is the whole recents list that can still open.
	private func knownVaults() -> [URL] {
		var known = bookmarks.keys.map { URL(fileURLWithPath: $0, isDirectory: true) }
		let fm = FileManager.default
		if let names = try? fm.contentsOfDirectory(atPath: documentsURL.path) {
			for name in names where !name.hasPrefix(".") {
				let url = documentsURL.appendingPathComponent(name, isDirectory: true)
				if fm.fileExists(atPath: url.appendingPathComponent(".clew").path) { known.append(url) }
			}
		}
		return known
	}

	// MARK: - External-vault bookmarks

	private var bookmarks: [String: Data] {
		get { (UserDefaults.standard.dictionary(forKey: Self.bookmarksKey) as? [String: Data]) ?? [:] }
		set { UserDefaults.standard.set(newValue, forKey: Self.bookmarksKey) }
	}

	/// A folder just picked in the document picker: begin security-scoped
	/// access and persist a bookmark so relaunches can reopen it in place.
	/// Folders inside our own Documents need neither.
	func registerExternalVault(_ url: URL) -> String {
		guard !url.path.hasPrefix(documentsURL.path) else { return url.path }
		_ = url.startAccessingSecurityScopedResource()
		activeScopedURL?.stopAccessingSecurityScopedResource()
		activeScopedURL = url
		if let data = try? url.bookmarkData() {
			var all = bookmarks
			all[url.path] = data
			bookmarks = all
		}
		return url.path
	}

	/// Make the vault at `path` reachable (resolving + re-arming the
	/// security-scoped bookmark for external folders). Returns the real
	/// current path — bookmarks follow moved/renamed folders — or nil.
	func resolveAccess(_ path: String) -> String? {
		let fm = FileManager.default
		if path.hasPrefix(documentsURL.path) {
			return fm.fileExists(atPath: path) ? path : nil
		}
		if activeScopedURL?.path == path, fm.fileExists(atPath: path) { return path }
		guard let data = bookmarks[path] else {
			// No bookmark (debug/simulator paths): plain reachability.
			return fm.fileExists(atPath: path) ? path : nil
		}
		var stale = false
		guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) else { return nil }
		activeScopedURL?.stopAccessingSecurityScopedResource()
		_ = url.startAccessingSecurityScopedResource()
		activeScopedURL = url
		var all = bookmarks
		if stale || url.path != path {
			all.removeValue(forKey: path)
			all[url.path] = (try? url.bookmarkData()) ?? data
			bookmarks = all
		}
		return fm.fileExists(atPath: url.path) ? url.path : nil
	}

	// MARK: - Switching vaults

	// The iPad has one scene, so switching vaults is a fresh page, as desktop's
	// is a fresh window: the shim settles the open vault, names the next one
	// here (setNextVault), and reloads; the boot then opens it like any
	// launch (bootstrapVaultPath).

	/// The part of `path` inside an app container's Documents, or nil. A
	/// Documents vault is remembered by full path, and the container's path
	/// is not stable (a reinstall moves it), so it is followed by this part.
	static func documentsRelative(_ path: String) -> String? {
		guard let range = path.range(of: #"/Data/Application/[0-9A-Fa-f-]+/Documents/"#, options: .regularExpression) else { return nil }
		let rest = String(path[range.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
		return rest.isEmpty ? nil : rest
	}

	/// A remembered vault's standing, for the switcher: where it is now, or
	/// why it cannot be opened. Never disturbs the open vault's security
	/// scope: an external folder is checked under a scope opened and closed
	/// here, unless it is the one already open.
	func vaultStatus(_ path: String) -> [String: Any] {
		let fm = FileManager.default
		let isDirectory = { (p: String) -> Bool in
			var isDir: ObjCBool = false
			return fm.fileExists(atPath: p, isDirectory: &isDir) && isDir.boolValue
		}
		let name = (path as NSString).lastPathComponent
		if let rel = Self.documentsRelative(path) ?? (path.hasPrefix(documentsURL.path + "/") ? String(path.dropFirst(documentsURL.path.count + 1)) : nil) {
			let now = documentsURL.appendingPathComponent(rel, isDirectory: true).path
			if isDirectory(now) { return ["path": path, "ok": true, "resolved": now, "name": name, "kind": "documents"] }
			return ["path": path, "ok": false, "name": name, "kind": "documents",
				"reason": "It is no longer in Clew’s folder on this iPad: it may have been moved, renamed or deleted."]
		}
		guard let data = bookmarks[path] else {
			if isDirectory(path) { return ["path": path, "ok": true, "resolved": path, "name": name, "kind": "external"] }
			return ["path": path, "ok": false, "name": name, "kind": "external",
				"reason": "Clew no longer has access to this folder. Use Open Folder… to choose it again."]
		}
		var stale = false
		guard let url = try? URL(resolvingBookmarkData: data, bookmarkDataIsStale: &stale) else {
			return ["path": path, "ok": false, "name": name, "kind": "external",
				"reason": "The folder can’t be found: it may have been deleted, or its storage provider is unavailable."]
		}
		let alreadyOpen = activeScopedURL?.path == url.path
		let started = alreadyOpen ? false : url.startAccessingSecurityScopedResource()
		defer { if started { url.stopAccessingSecurityScopedResource() } }
		if isDirectory(url.path) {
			return ["path": path, "ok": true, "resolved": url.path, "name": url.lastPathComponent, "kind": "external"]
		}
		return ["path": path, "ok": false, "name": name, "kind": "external",
			"reason": "The folder can’t be reached: it may have been moved or deleted, or its storage provider is offline."]
	}

	/// The vault the next page load opens. Resolved now, so a vault that
	/// cannot be opened is said here, before anything is torn down.
	func setNextVault(_ path: String) -> [String: Any] {
		let status = vaultStatus(path)
		guard status["ok"] as? Bool == true, let resolved = status["resolved"] as? String else { return status }
		UserDefaults.standard.set(resolved, forKey: "lastVaultPath")
		return ["ok": true, "path": resolved]
	}

	/// A vault created for a switch that was then cancelled: removed again,
	/// but only while it is still exactly what createVault made — an empty
	/// folder directly in Documents. Anything else is left alone.
	func removeEmptyVault(_ path: String) -> Bool {
		let url = URL(fileURLWithPath: path, isDirectory: true).standardizedFileURL
		guard url.deletingLastPathComponent().standardizedFileURL.path == documentsURL.standardizedFileURL.path else { return false }
		let fm = FileManager.default
		guard let names = try? fm.contentsOfDirectory(atPath: url.path),
			names.allSatisfy({ $0 == ".DS_Store" }) else { return false }
		guard (try? fm.removeItem(at: url)) != nil else { return false }
		trust.forget(url)
		return true
	}

	/// A remembered vault the user removed from the list: its bookmark goes
	/// with it (nothing else remembers an external folder natively).
	func forgetVault(_ path: String) {
		var all = bookmarks
		all.removeValue(forKey: path)
		bookmarks = all
	}

	// MARK: - Bootstrap

	/// The vault to auto-open at launch: the last-open one if it is still
	/// reachable, else the seeded demo vault.
	func bootstrapVaultPath() -> String {
		let demo = demoVaultPath()
		if let last = UserDefaults.standard.string(forKey: "lastVaultPath"),
			let resolved = resolveAccess(last) {
			return resolved
		}
		return demo
	}

	/// The demo vault — the de-facto tutorial. The bundle's copy is read-only
	/// payload and a vault must be writable, so the user gets their own copy
	/// in Documents: created on first use, reopened (never overwritten)
	/// after that — the same rule as desktop's ~/Documents/Clew Demo Vault.
	func demoVaultPath() -> String {
		let fm = FileManager.default
		let demo = documentsURL.appendingPathComponent("Demo Vault", isDirectory: true)
		if !fm.fileExists(atPath: demo.path),
			let seed = Bundle.main.url(forResource: "SeedVault", withExtension: nil) {
			try? fm.copyItem(at: seed, to: demo)
		}
		// Clew's own vault: trusted by construction — unless its owner has
		// since said otherwise (a recorded entry is left alone).
		// What it asks for is what Clew wrote into it: its plugins and the
		// Note API run (desktop main.js passes the demo's request the same way).
		if trust.entries()[trust.identity(demo)] == nil {
			trust.trust(demo, source: "demo", enable: Self.readRequests(demo).map { VaultTrustStore.Enable.normalize($0, scripts: true) })
		}
		return demo.path
	}

	/// A new, empty vault in Documents (visible in the Files app), its name
	/// deduped like a new note's. Returns the path.
	func createVault(named raw: String) throws -> String {
		let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
			.replacingOccurrences(of: "/", with: "-").replacingOccurrences(of: ":", with: "-")
		let base = name.isEmpty ? "My Vault" : name
		var candidate = documentsURL.appendingPathComponent(base, isDirectory: true)
		var counter = 2
		while FileManager.default.fileExists(atPath: candidate.path) {
			candidate = documentsURL.appendingPathComponent("\(base) \(counter)", isDirectory: true)
			counter += 1
		}
		try FileManager.default.createDirectory(at: candidate, withIntermediateDirectories: true)
		// Made in-app, so trusted by construction.
		trust.trust(candidate, source: "created")
		return candidate.path
	}

	// MARK: - Snapshot

	func openVault(path: String) throws -> [String: Any] {
		guard let real = resolveAccess(path) else {
			throw ClewError.vaultUnreachable(path)
		}
		currentVaultPath = real
		currentVaultRealRoot = VaultPaths.realPath(real)
		refusedLinks = [:]
		UserDefaults.standard.set(real, forKey: "lastVaultPath")
		knownMtimes = [:]
		knownPdfMtimes = [:]
		cloudConflicts = []
		var files: [String: Any] = [:]
		let root = URL(fileURLWithPath: real, isDirectory: true)
		// Evicted iCloud text files must land before the mirror snapshot;
		// spend at most this long waiting across the whole walk (whatever
		// misses the deadline arrives via a later rescan).
		let downloadDeadline = Date().addingTimeInterval(20)
		walk(root, rel: "", downloadDeadline: downloadDeadline, ancestry: [currentVaultRealRoot ?? real],
			onConflict: { self.cloudConflicts.insert($0) }) { rel, url, mtimeMs, size in
			if Self.isText(rel) {
				let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
				files[rel] = ["text": text, "size": size, "mtimeMs": mtimeMs]
				self.knownMtimes[rel] = mtimeMs
			} else {
				files[rel] = ["size": size, "mtimeMs": mtimeMs]
				if Self.isPdf(rel) { self.knownPdfMtimes[rel] = mtimeMs }
			}
		}
		var result: [String: Any] = [
			"name": root.lastPathComponent,
			"path": real,
			"files": files,
		]
		if let global = globalPluginsSnapshot() { result["globalPlugins"] = global }
		// Links leading out of the vault, skipped by the walk: the app page
		// says so once, so a missing file is explained.
		if !refusedLinks.isEmpty { result["refusedLinks"] = refusedLinks.keys.sorted() }
		// iCloud's own conflicts: the shim offers each its keep/compare sheet.
		if !cloudConflicts.isEmpty { result["cloudConflicts"] = cloudConflicts.sorted() }
		// Decided here, before the first engine config: a vault new to this
		// device runs none of its own code until its owner trusts it, and
		// what a trusted one may run is this device's record (§4.2).
		let access = refreshAccess()
		result["access"] = access
		// The device-side identity: what an app's origin key derives from.
		result["identity"] = trust.identity(root)
		result["trusted"] = access["trusted"] as? Bool == true
		return result
	}

	/// The global plugin folder as a mirror snapshot ({rel: {text?, size,
	/// mtimeMs}} under its own root), or nil when there is none. Read-only
	/// from the app's side: no mtimes are remembered, no rescan diffs it —
	/// a plugin dropped in mid-session is picked up at the next vault open.
	private func globalPluginsSnapshot() -> [String: Any]? {
		let url = globalPluginsURL
		var isDir: ObjCBool = false
		guard FileManager.default.fileExists(atPath: url.path, isDirectory: &isDir), isDir.boolValue else { return nil }
		var files: [String: Any] = [:]
		walk(url, rel: "", downloadDeadline: Date().addingTimeInterval(5)) { rel, fileURL, mtimeMs, size in
			if Self.isText(rel) {
				let text = (try? String(contentsOf: fileURL, encoding: .utf8)) ?? ""
				files[rel] = ["text": text, "size": size, "mtimeMs": mtimeMs]
			} else {
				files[rel] = ["size": size, "mtimeMs": mtimeMs]
			}
		}
		return ["path": url.path, "files": files]
	}

	static func isText(_ rel: String) -> Bool {
		textExtensions.contains((rel as NSString).pathExtension.lowercased())
	}

	/// Walk one directory level. Skips dot-entries (except `.clew`, whose
	/// settings/caches the mirror needs) so a Working Copy vault's .git or
	/// an Obsidian vault's .obsidian never enters the snapshot. iCloud
	/// placeholders (.name.icloud) are mapped to their real names; text
	/// placeholders are downloaded and awaited within the shared deadline.
	/// `ancestry` is the real paths of the folders above `dir` on this walk:
	/// a folder whose real path is already among them (a link back up the
	/// tree) is not entered again, so links cannot loop. `onConflict` hears
	/// each item iCloud holds unresolved conflict versions of.
	private func walk(_ dir: URL, rel: String, downloadDeadline: Date?, ancestry: [String] = [],
		onConflict: ((String) -> Void)? = nil, visit: (String, URL, Double, Int) -> Void) {
		let fm = FileManager.default
		guard let entries = try? fm.contentsOfDirectory(
			at: dir, includingPropertiesForKeys: [.isDirectoryKey, .contentModificationDateKey, .fileSizeKey, .ubiquitousItemHasUnresolvedConflictsKey],
			options: []) else { return }
		for entry in entries {
			var url = entry
			var name = url.lastPathComponent
			if Self.ignoredNames.contains(name) { continue }
			if name.hasPrefix(".") {
				if name.hasSuffix(".icloud"), name.count > ".icloud".count + 1 {
					// Evicted iCloud item: ".Note.md.icloud" stands in for "Note.md".
					let realName = String(name.dropFirst().dropLast(".icloud".count))
					let realURL = dir.appendingPathComponent(realName)
					try? fm.startDownloadingUbiquitousItem(at: realURL)
					let realRel = rel.isEmpty ? realName : "\(rel)/\(realName)"
					if Self.isText(realRel), let deadline = downloadDeadline,
						Self.waitUntil(deadline: deadline, existing: realURL) {
						url = realURL
						name = realName
					} else {
						// Not local yet: report a stub so wikilinks resolve; a
						// rescan delivers the content once iCloud lands it.
						visit(realRel, realURL, 0, 0)
						continue
					}
				} else if name != ".clew" {
					continue
				}
			}
			let childRel = rel.isEmpty ? name : "\(rel)/\(name)"
			let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey, .contentModificationDateKey, .fileSizeKey, .ubiquitousItemHasUnresolvedConflictsKey])
			if values?.ubiquitousItemHasUnresolvedConflicts == true { onConflict?(childRel) }
			if values?.isSymbolicLink == true {
				// A link is followed only while it stays inside the vault
				// (VaultPaths); one leaving it, or dangling, is skipped and
				// recorded. A folder link is walked once, by its real path,
				// so a link back up the tree cannot loop.
				guard let root = currentVaultRealRoot,
					case .inside(let real) = VaultPaths.check(url.path, root: root) else {
					if case .escapes(let real) = currentVaultRealRoot.map({ VaultPaths.check(url.path, root: $0) }) ?? .escapes(nil) {
						refusedLinks[childRel] = real ?? ""
					}
					continue
				}
				var isDir: ObjCBool = false
				guard fm.fileExists(atPath: real, isDirectory: &isDir) else { continue }
				if isDir.boolValue {
					// Listed through its REAL folder: contentsOfDirectory(at:)
					// does not follow a link to a folder. Paths stay the link's.
					if !ancestry.contains(real) {
						walk(URL(fileURLWithPath: real, isDirectory: true), rel: childRel, downloadDeadline: downloadDeadline,
							ancestry: ancestry + [real], onConflict: onConflict, visit: visit)
					}
				} else {
					let attrs = try? fm.attributesOfItem(atPath: real)
					let mtimeMs = ((attrs?[.modificationDate] as? Date)?.timeIntervalSince1970 ?? 0) * 1000
					visit(childRel, url, mtimeMs, (attrs?[.size] as? NSNumber)?.intValue ?? 0)
				}
			} else if values?.isDirectory == true {
				let real = VaultPaths.realPath(url.path) ?? url.path
				if !ancestry.contains(real) {
					walk(url, rel: childRel, downloadDeadline: downloadDeadline, ancestry: ancestry + [real], onConflict: onConflict, visit: visit)
				}
			} else {
				let mtimeMs = (values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000
				visit(childRel, url, mtimeMs, values?.fileSize ?? 0)
			}
		}
	}

	private static func waitUntil(deadline: Date, existing url: URL) -> Bool {
		while Date() < deadline {
			if FileManager.default.fileExists(atPath: url.path) { return true }
			Thread.sleep(forTimeInterval: 0.1)
		}
		return FileManager.default.fileExists(atPath: url.path)
	}

	/// Ensure a vault file is local (downloading an evicted iCloud item if
	/// needed) — used by the scheme handler before serving media/binaries.
	func materialize(rel: String, timeout: TimeInterval) -> URL? {
		guard let url = try? resolve(rel) else { return nil }
		let fm = FileManager.default
		if fm.fileExists(atPath: url.path) { return url }
		let placeholder = url.deletingLastPathComponent()
			.appendingPathComponent("." + url.lastPathComponent + ".icloud")
		guard fm.fileExists(atPath: placeholder.path) else { return nil }
		try? fm.startDownloadingUbiquitousItem(at: url)
		return Self.waitUntil(deadline: Date().addingTimeInterval(timeout), existing: url) ? url : nil
	}

	// MARK: - File operations (bridge write-through)

	func resolve(_ rel: String) throws -> URL {
		guard let vault = currentVaultPath else { throw ClewError.noVault }
		let base = URL(fileURLWithPath: vault, isDirectory: true).standardizedFileURL
		let target = base.appendingPathComponent(rel).standardizedFileURL
		guard target.path == base.path || target.path.hasPrefix(base.path + "/") else {
			throw ClewError.pathEscape(rel)
		}
		// Lexically inside is not inside: a link can lead out. Clamp by real
		// path (VaultPaths): a link leaving the vault, or dangling, is
		// refused, for reads, writes, renames and serving alike.
		guard let root = currentVaultRealRoot ?? VaultPaths.realPath(vault) else { throw ClewError.pathEscape(rel) }
		if case .escapes = VaultPaths.check(target.path, root: root) {
			throw ClewError.linkEscape(rel)
		}
		return target
	}

	/// Coordinated write — iCloud/file-provider folders need file
	/// coordination for other participants to see changes promptly. Every
	/// body below writes through AtomicFile, so the provider sees exactly
	/// one replacement of a complete file (the .forReplacing scope covers
	/// the temp's rename into place).
	private func coordinatedWrite(to url: URL, _ body: (URL) throws -> Void) throws {
		try FileManager.default.createDirectory(
			at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
		var coordinationError: NSError?
		var writeError: Error?
		NSFileCoordinator().coordinate(writingItemAt: url, options: .forReplacing,
			error: &coordinationError) { destination in
			do { try body(destination) } catch { writeError = error }
		}
		if let error = coordinationError { throw error }
		if let error = writeError { throw error }
	}

	/// Write a text file. A GUARDED write (an editor's save — desktop's
	/// write-guard.js, opt-in as there, because only the editor can answer
	/// a refusal) is refused when the file changed on disk since this app
	/// last saw it (another device's edit, delivered by iCloud or a file
	/// provider between rescans) and differs from what is being written:
	/// NOTHING is written and the disk's version comes back, so neither is
	/// lost silently (the renderer holds the note and asks). `force` is the
	/// user's answer, "keep mine". Vault state (.clew/, the kv store) is
	/// never guarded.
	func write(rel: String, text: String, guarded: Bool = false, force: Bool = false) throws -> [String: Any]? {
		let url = try resolve(rel)
		let fm = FileManager.default
		if guarded, !force, Self.isGuarded(rel), fm.fileExists(atPath: url.path) {
			let onDisk = currentMtimeMs(url)
			let changedBehindUs = knownMtimes[rel].map { abs($0 - onDisk) > 0.5 } ?? true
			if changedBehindUs {
				let disk = coordinatedReadText(url) ?? ""
				if disk != text {
					return ["conflict": true, "disk": disk, "mtimeMs": onDisk]
				}
			}
		}
		try coordinatedWrite(to: url) { try AtomicFile.write(Data(text.utf8), to: $0) }
		knownMtimes[rel] = currentMtimeMs(url)
		return nil
	}

	/// The renderer adopted the disk's version that a guarded write was
	/// refused over (Keep theirs reads it afresh): this app has now seen it,
	/// so the next save is not refused for it. Only while that version is
	/// still the one on disk.
	func markSeen(rel: String, mtimeMs: Double) throws {
		let url = try resolve(rel)
		if abs(currentMtimeMs(url) - mtimeMs) <= 0.5 { knownMtimes[rel] = mtimeMs }
	}

	/// A user's file, where a write over an unseen version must not happen
	/// silently: not vault state.
	static func isGuarded(_ rel: String) -> Bool {
		!rel.hasPrefix(".clew/") && rel != "clewdata.json"
	}

	/// A text file's content as the file coordinator gives it (an iCloud or
	/// provider-backed file may be mid-update).
	private func coordinatedReadText(_ url: URL) -> String? {
		var result: String?
		var error: NSError?
		NSFileCoordinator().coordinate(readingItemAt: url, options: [], error: &error) { readURL in
			result = try? String(contentsOf: readURL, encoding: .utf8)
		}
		return result
	}

	// MARK: - iCloud conflict versions (NSFileVersion)

	/// The unresolved conflict versions of a vault file, newest first, with
	/// their text: what the conflict sheet compares against the current one.
	func cloudConflictVersions(rel: String) throws -> [[String: Any]] {
		let url = try resolve(rel)
		let versions = (NSFileVersion.unresolvedConflictVersionsOfItem(at: url) ?? [])
			.sorted { ($0.modificationDate ?? .distantPast) > ($1.modificationDate ?? .distantPast) }
		return versions.enumerated().map { index, version in
			[
				"index": index,
				"from": version.localizedNameOfSavingComputer ?? "another device",
				"modifiedMs": (version.modificationDate?.timeIntervalSince1970 ?? 0) * 1000,
				"text": (try? String(contentsOf: version.url, encoding: .utf8)) ?? "",
			]
		}
	}

	/// The user chose: keep the current version, or put conflict version
	/// `index` in its place. Either way every conflict version is then marked
	/// resolved and removed — only after the choice, and the shim has put
	/// both texts in .clew/history before calling this.
	func resolveCloudConflict(rel: String, keepOther index: Int?) throws {
		let url = try resolve(rel)
		let versions = (NSFileVersion.unresolvedConflictVersionsOfItem(at: url) ?? [])
			.sorted { ($0.modificationDate ?? .distantPast) > ($1.modificationDate ?? .distantPast) }
		if let index, versions.indices.contains(index) {
			let text = try String(contentsOf: versions[index].url, encoding: .utf8)
			try coordinatedWrite(to: url) { try AtomicFile.write(Data(text.utf8), to: $0) }
		}
		for version in versions { version.isResolved = true }
		try NSFileVersion.removeOtherVersionsOfItem(at: url)
		knownMtimes[rel] = currentMtimeMs(url)
		cloudConflicts.remove(rel)
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
		return try writeNewBinary(data, rel: targetRel)
	}

	/// A file's bytes written into the vault as a NEW file (a web PDF's cached
	/// copy, RemotePdfStore.saveCopy) — the same never-overwriting write.
	func writeBinaryFile(rel: String, from source: URL) throws -> [String: Any] {
		try writeNewBinary(try Data(contentsOf: source), rel: rel)
	}

	/// Writes `data` at `targetRel`, or at "name 1.ext", "name 2.ext", … if
	/// that exists — never overwriting — and answers the path it used.
	func writeNewBinary(_ data: Data, rel targetRel: String) throws -> [String: Any] {
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
		let payload = data
		try coordinatedWrite(to: candidate) { try AtomicFile.write(payload, to: $0) }
		let vaultBase = URL(fileURLWithPath: currentVaultPath!, isDirectory: true).standardizedFileURL.path
		let outRel = String(candidate.standardizedFileURL.path.dropFirst(vaultBase.count + 1))
		return ["rel": outRel, "size": data.count]
	}

	/// Overwrite an existing vault file in place (inline PDF annotation
	/// saves). Unlike writeBinary this never creates or renames: a wrong
	/// path must fail loudly, not scatter deduped "name 1" copies.
	func updateBinary(rel: String, base64: String) throws {
		guard let data = Data(base64Encoded: base64) else { throw ClewError.badPayload }
		_ = try updateBinaryData(rel: rel, data: data)
	}

	static func isPdf(_ rel: String) -> Bool { (rel as NSString).pathExtension.lowercased() == "pdf" }

	/// Overwrite an existing vault file in place (a PDF annotation save: the
	/// binary POST, SchemeHandler `__clew_pdf_save__`). A `guarded` save of a
	/// PDF is refused — nothing written, {conflict, mtimeMs} — when the file
	/// changed on disk since this app last saw it (another device's
	/// annotations, landed between rescans), as an editor's text save is;
	/// `force` is "keep mine". Never creates: a wrong path fails loudly.
	func updateBinaryData(rel: String, data: Data, guarded: Bool = false, force: Bool = false) throws -> [String: Any] {
		let file = try resolve(rel)
		guard FileManager.default.fileExists(atPath: file.path) else { throw ClewError.notFound(rel) }
		if guarded, !force, Self.isPdf(rel) {
			let onDisk = currentMtimeMs(file)
			if let known = knownPdfMtimes[rel], abs(known - onDisk) > 0.5 {
				return ["conflict": true, "mtimeMs": onDisk]
			}
		}
		try coordinatedWrite(to: file) { try AtomicFile.write(data, to: $0) }
		let mtimeMs = currentMtimeMs(file)
		if Self.isPdf(rel) { knownPdfMtimes[rel] = mtimeMs }
		return ["ok": true, "mtimeMs": mtimeMs, "size": data.count]
	}

	func mkdir(rel: String) throws {
		try FileManager.default.createDirectory(at: try resolve(rel), withIntermediateDirectories: true)
	}

	func rename(rel: String, newRel: String) throws {
		let to = try resolve(newRel)
		try FileManager.default.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
		try FileManager.default.moveItem(at: try resolve(rel), to: to)
		// Carry the rescan baseline along, or the next pass reports the move
		// as a removal plus a fresh change of the same bytes.
		for (key, mtime) in knownMtimes where key == rel || key.hasPrefix(rel + "/") {
			knownMtimes.removeValue(forKey: key)
			knownMtimes[newRel + key.dropFirst(rel.count)] = mtime
		}
	}

	/// Stamp a file's modification time: note-history snapshots carry the
	/// time their content was written, not the time they were copied.
	/// Metadata-only coordination, so providers don't see a content change.
	func setMtime(rel: String, mtimeMs: Double) throws {
		let url = try resolve(rel)
		let date = Date(timeIntervalSince1970: mtimeMs / 1000)
		try coordinated(url, options: .contentIndependentMetadataOnly) {
			try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: $0.path)
		}
		knownMtimes[rel] = currentMtimeMs(url)
	}

	/// Hard delete — the mirror's only deletion path, used by note-history
	/// pruning. User files never come through here (they go to trash()),
	/// and anything outside .clew/history/ is refused so a bug upstream of
	/// this call cannot become data loss.
	func remove(rel: String) throws {
		guard rel.hasPrefix(".clew/history/") else { throw ClewError.refused(rel) }
		let url = try resolve(rel)
		try coordinated(url, options: .forDeleting) { try FileManager.default.removeItem(at: $0) }
		knownMtimes.removeValue(forKey: rel)
		for key in knownMtimes.keys where key.hasPrefix(rel + "/") { knownMtimes.removeValue(forKey: key) }
	}

	private func coordinated(_ url: URL, options: NSFileCoordinator.WritingOptions,
		_ body: (URL) throws -> Void) throws {
		var coordinationError: NSError?
		var bodyError: Error?
		NSFileCoordinator().coordinate(writingItemAt: url, options: options, error: &coordinationError) { target in
			do { try body(target) } catch { bodyError = error }
		}
		if let error = coordinationError { throw error }
		if let error = bodyError { throw error }
	}

	func trash(rel: String) throws {
		let url = try resolve(rel)
		do {
			try FileManager.default.trashItem(at: url, resultingItemURL: nil)
		} catch {
			try FileManager.default.removeItem(at: url)
		}
	}

	/// stat(2), never a URL's cached resource values (AtomicFile.mtimeMs).
	private func currentMtimeMs(_ url: URL) -> Double { AtomicFile.mtimeMs(url) }

	// MARK: - Rescan (external-change detection)

	/// Diff current on-disk state against the last snapshot; async on the IO
	/// queue, completion on main. Returns nil when nothing changed.
	func rescan(_ completion: @escaping ([String: Any]?) -> Void) {
		guard let vault = currentVaultPath else { return completion(nil) }
		// On the IO queue throughout, the queue every write runs on: a save
		// can't land between the snapshot and the new mtimes and be forgotten
		// (the guarded write would then take its own save for another
		// device's, and raise a false conflict).
		ioQueue.async {
			let previous = self.knownMtimes
			var changed: [String: Any] = [:]
			var seen = Set<String>()
			var next: [String: Double] = [:]
			var conflicts = Set<String>()
			var nextPdf: [String: Double] = [:]
			let root = URL(fileURLWithPath: vault, isDirectory: true)
			// Rescans stay cheap: newly appearing evicted text gets a short
			// shared download budget, the rest lands on a later pass.
			let deadline = Date().addingTimeInterval(5)
			self.walk(root, rel: "", downloadDeadline: deadline, ancestry: [self.currentVaultRealRoot ?? vault],
				onConflict: { conflicts.insert($0) }) { rel, url, mtimeMs, size in
				if Self.isPdf(rel) { nextPdf[rel] = mtimeMs }
				guard Self.isText(rel) else { return }
				seen.insert(rel)
				next[rel] = mtimeMs
				if abs((previous[rel] ?? -1) - mtimeMs) > 0.5 {
					let text = (try? String(contentsOf: url, encoding: .utf8)) ?? ""
					changed[rel] = ["text": text, "size": size, "mtimeMs": mtimeMs]
				}
			}
			let removed = previous.keys.filter { !seen.contains($0) }
			self.knownMtimes = next
			self.knownPdfMtimes = nextPdf
			self.cloudConflicts = conflicts // the ones still unresolved
			let sorted = conflicts.sorted()
			DispatchQueue.main.async {
				if changed.isEmpty && removed.isEmpty && sorted.isEmpty { return completion(nil) }
				completion(["changed": changed, "removed": Array(removed), "cloudConflicts": sorted])
			}
		}
	}
}

enum ClewError: Error, LocalizedError {
	case noVault
	case pathEscape(String)
	case linkEscape(String)
	case badPayload
	case unknownMethod(String)
	case vaultUnreachable(String)
	case notFound(String)
	case refused(String)
	case printBusy
	case printFailed(String)
	/// Said as is (the viewer's notice shows it).
	case message(String)

	var errorDescription: String? {
		switch self {
		case .noVault: return "No vault open"
		case .pathEscape(let rel): return "Path escapes vault: \(rel)"
		case .linkEscape(let rel): return "“\(rel)” is a link that leads outside the vault: links leaving a vault aren’t followed on iPad"
		case .badPayload: return "Bad payload"
		case .unknownMethod(let name): return "Unknown bridge method: \(name)"
		case .notFound(let rel): return "No such vault file: \(rel)"
		case .vaultUnreachable(let path): return "Cannot access vault at \(path) — re-pick the folder to renew access"
		case .refused(let rel): return "Refused: \(rel) is not a note-history snapshot"
		case .message(let text): return text
		case .printBusy: return "A PDF export is already in progress"
		case .printFailed(let why): return "PDF export failed: \(why)"
		}
	}
}
