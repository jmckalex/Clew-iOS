// Secrets an app keeps on THIS DEVICE (`app.secrets`, Clew-app 0cc8547;
// frame-bridge.md §9c) — the iOS twin of Clew-app's main/app-secrets.js, on
// the Keychain. The shared rules (names, 8 KB, 32 per app, the error codes)
// are upstream's app-calls.js; this file only keeps and finds.
//
// One generic-password item per secret:
//   service  org.jmckalex.clew.ios.app-secrets
//   account  <vault identity> US <app id> US <name>   (US = U+001F)
//   accessible AfterFirstUnlockThisDeviceOnly, never synchronizable — never
//   iCloud Keychain, never restored onto another device.
// The vault identity is VaultTrust's (`documents:<rel>` or `path:<real>`),
// so forgetting a vault can clear what its apps kept. App ids and names
// cannot hold U+001F (APP_ID_RE, SECRET_NAME), so an account is read from
// its END: the last two fields are the app and the name, the rest is the
// vault, whatever its folder is called.
//
// iOS keeps Keychain items when the app is deleted; the grants (Application
// Support) go with it. So the first launch of an install sweeps the service
// (`sweepIfNewInstall`, a UserDefaults marker): a reinstalled Clew starts
// with no secrets, as it starts with no grants.
//
// A value is never logged and never put in an error.
import Foundation
import Security

/// Where the items live: the Keychain, or memory (ios/Tests/AppSecrets).
protocol SecretBackend {
	func read(_ account: String) throws -> Data?
	func write(_ account: String, _ data: Data) throws
	func remove(_ account: String) throws -> Bool
	func accounts() throws -> [String]
}

enum AppSecretsError: Error, LocalizedError {
	case unavailable(OSStatus)
	case badScope
	var errorDescription: String? {
		switch self {
		case .unavailable(let status): return "secrets are not kept on this device (Keychain \(status))"
		case .badScope: return "bad secret scope"
		}
	}
}

struct KeychainBackend: SecretBackend {
	let service: String

	private func base(_ account: String? = nil) -> [String: Any] {
		var q: [String: Any] = [
			kSecClass as String: kSecClassGenericPassword,
			kSecAttrService as String: service,
			kSecAttrSynchronizable as String: kCFBooleanFalse as Any,
		]
		if let account { q[kSecAttrAccount as String] = account }
		return q
	}

	func read(_ account: String) throws -> Data? {
		var q = base(account)
		q[kSecReturnData as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitOne
		var out: CFTypeRef?
		let status = SecItemCopyMatching(q as CFDictionary, &out)
		if status == errSecItemNotFound { return nil }
		guard status == errSecSuccess else { throw AppSecretsError.unavailable(status) }
		return out as? Data
	}

	func write(_ account: String, _ data: Data) throws {
		let update: [String: Any] = [
			kSecValueData as String: data,
			kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
		]
		var status = SecItemUpdate(base(account) as CFDictionary, update as CFDictionary)
		if status == errSecItemNotFound {
			var add = base(account)
			add.merge(update) { _, new in new }
			status = SecItemAdd(add as CFDictionary, nil)
		}
		guard status == errSecSuccess else { throw AppSecretsError.unavailable(status) }
	}

	func remove(_ account: String) throws -> Bool {
		let status = SecItemDelete(base(account) as CFDictionary)
		if status == errSecItemNotFound { return false }
		guard status == errSecSuccess else { throw AppSecretsError.unavailable(status) }
		return true
	}

	func accounts() throws -> [String] {
		var q = base()
		q[kSecReturnAttributes as String] = true
		q[kSecMatchLimit as String] = kSecMatchLimitAll
		var out: CFTypeRef?
		let status = SecItemCopyMatching(q as CFDictionary, &out)
		if status == errSecItemNotFound { return [] }
		guard status == errSecSuccess else { throw AppSecretsError.unavailable(status) }
		return (out as? [[String: Any]] ?? []).compactMap { $0[kSecAttrAccount as String] as? String }
	}
}

final class AppSecretStore {
	static let service = "org.jmckalex.clew.ios.app-secrets"
	static let separator = "\u{1F}"
	static let shared = AppSecretStore(backend: KeychainBackend(service: service))

	private let backend: SecretBackend
	private let lock = NSLock()

	init(backend: SecretBackend) { self.backend = backend }

	/// Upstream's APP_ID_RE and SECRET_NAME: a request outside them never
	/// reaches the Keychain.
	static func validApp(_ id: String) -> Bool {
		id.range(of: #"^[a-z0-9][a-z0-9._-]{0,63}$"#, options: .regularExpression) != nil
	}
	static func validName(_ name: String) -> Bool {
		name.range(of: #"^[A-Za-z0-9._-]{1,64}$"#, options: .regularExpression) != nil
	}

	static func account(vault: String, app: String, name: String) -> String {
		[vault, app, name].joined(separator: separator)
	}

	/// (vault, app, name) from an account, read from its end; nil for one
	/// this file did not write.
	static func parse(_ account: String) -> (vault: String, app: String, name: String)? {
		let parts = account.components(separatedBy: separator)
		guard parts.count >= 3 else { return nil }
		let name = parts[parts.count - 1], app = parts[parts.count - 2]
		let vault = parts[0..<(parts.count - 2)].joined(separator: separator)
		guard !vault.isEmpty, validApp(app), validName(name) else { return nil }
		return (vault, app, name)
	}

	private func scoped(_ vault: String, _ app: String, _ name: String? = nil) throws -> String? {
		guard !vault.isEmpty, Self.validApp(app) else { throw AppSecretsError.badScope }
		guard let name else { return nil }
		guard Self.validName(name) else { throw AppSecretsError.badScope }
		return Self.account(vault: vault, app: app, name: name)
	}

	private func locked<T>(_ body: () throws -> T) rethrows -> T {
		lock.lock(); defer { lock.unlock() }
		return try body()
	}

	/// The value, or nil — nil too for one this device cannot read as text.
	func get(vault: String, app: String, name: String) throws -> String? {
		let account = try scoped(vault, app, name)!
		return try locked { try backend.read(account).flatMap { String(data: $0, encoding: .utf8) } }
	}

	func set(vault: String, app: String, name: String, value: String) throws {
		let account = try scoped(vault, app, name)!
		try locked { try backend.write(account, Data(value.utf8)) }
	}

	func delete(vault: String, app: String, name: String) throws -> Bool {
		let account = try scoped(vault, app, name)!
		return try locked { try backend.remove(account) }
	}

	func names(vault: String, app: String) throws -> [String] {
		_ = try scoped(vault, app)
		return try locked {
			try backend.accounts().compactMap(Self.parse).filter { $0.vault == vault && $0.app == app }.map(\.name).sorted()
		}
	}

	/// app id → how many secrets it keeps, for one vault (Settings → Apps).
	func counts(vault: String) throws -> [String: Int] {
		try locked {
			var out: [String: Int] = [:]
			for item in try backend.accounts().compactMap(Self.parse) where item.vault == vault { out[item.app, default: 0] += 1 }
			return out
		}
	}

	/// Revoke: the app starts again with none. Returns how many went.
	@discardableResult
	func clearApp(vault: String, app: String) throws -> Int {
		_ = try scoped(vault, app)
		return try locked {
			var n = 0
			for account in try backend.accounts() {
				guard let item = Self.parse(account), item.vault == vault, item.app == app else { continue }
				if try backend.remove(account) { n += 1 }
			}
			return n
		}
	}

	/// A vault forgotten on this device: every app's secrets in it.
	@discardableResult
	func clearVault(_ vault: String) throws -> Int {
		guard !vault.isEmpty else { throw AppSecretsError.badScope }
		return try locked {
			var n = 0
			for account in try backend.accounts() {
				guard let item = Self.parse(account), item.vault == vault else { continue }
				if try backend.remove(account) { n += 1 }
			}
			return n
		}
	}

	/// Every item of the service, whatever its account.
	@discardableResult
	func clearAll() throws -> Int {
		try locked {
			var n = 0
			for account in try backend.accounts() {
				if try backend.remove(account) { n += 1 }
			}
			return n
		}
	}

	/// The first launch of an install: what an earlier install left in the
	/// Keychain goes (iOS keeps Keychain items across a delete). Once.
	static let installMarker = "appSecretsInstall"
	func sweepIfNewInstall(_ defaults: UserDefaults = .standard) {
		guard defaults.object(forKey: Self.installMarker) == nil else { return }
		do {
			let n = try clearAll()
			if n > 0 { NSLog("clew: app secrets: %d left by an earlier install removed", n) }
			defaults.set(Date().timeIntervalSince1970, forKey: Self.installMarker)
		} catch {
			// The Keychain not ready (a launch before first unlock): next time.
			NSLog("clew: app secrets: sweep deferred (%@)", error.localizedDescription)
		}
	}
}
