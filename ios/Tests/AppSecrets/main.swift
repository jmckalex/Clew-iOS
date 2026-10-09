// Unit tests for ios/Clew/Sources/AppSecrets.swift over an in-memory backend.
// The real Keychain is measured in the simulator: on the Mac, an unsigned
// command-line tool reaches the login keychain, not the data-protection one
// the app uses. `npm run test:swift`.
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

final class MemoryBackend: SecretBackend {
	var items: [String: Data] = [:]
	var failing = false
	func read(_ account: String) throws -> Data? {
		if failing { throw AppSecretsError.unavailable(-25308) }
		return items[account]
	}
	func write(_ account: String, _ data: Data) throws {
		if failing { throw AppSecretsError.unavailable(-25308) }
		items[account] = data
	}
	func remove(_ account: String) throws -> Bool { items.removeValue(forKey: account) != nil }
	func accounts() throws -> [String] { Array(items.keys) }
}

let mem = MemoryBackend()
let store = AppSecretStore(backend: mem)
let A = "documents:Demo Vault", B = "path:/private/var/mobile/Other Vault"

// MARK: - Keep and find

try! store.set(vault: A, app: "stock-ticker", name: "finnhub-key", value: "abc123")
check((try? store.get(vault: A, app: "stock-ticker", name: "finnhub-key")) == "abc123", "a secret comes back")
check((try? store.get(vault: A, app: "stock-ticker", name: "other")) == .some(nil), "a missing name is nil")
check((try? store.get(vault: B, app: "stock-ticker", name: "finnhub-key")) == .some(nil), "the same app id in another vault does not see it")
check((try? store.get(vault: A, app: "seminar-picker", name: "finnhub-key")) == .some(nil), "another app in the vault does not see it")
try! store.set(vault: A, app: "stock-ticker", name: "finnhub-key", value: "def456")
check((try? store.get(vault: A, app: "stock-ticker", name: "finnhub-key")) == "def456", "a set replaces")
check(mem.items.count == 1, "one item, replaced in place")
try! store.set(vault: A, app: "stock-ticker", name: "b.second", value: "2")
try! store.set(vault: B, app: "stock-ticker", name: "finnhub-key", value: "elsewhere")
check((try? store.names(vault: A, app: "stock-ticker")) == ["b.second", "finnhub-key"], "names, sorted, this vault's only")
check((try? store.counts(vault: A)) == ["stock-ticker": 2], "counts for Settings → Apps")
check((try? store.delete(vault: A, app: "stock-ticker", name: "b.second")) == true, "delete says it was there")
check((try? store.delete(vault: A, app: "stock-ticker", name: "b.second")) == false, "and not the second time")
let unicode = "ключ — 🔑 \u{1F} \n"
try! store.set(vault: A, app: "stock-ticker", name: "u", value: unicode)
check((try? store.get(vault: A, app: "stock-ticker", name: "u")) == unicode, "any text round-trips, the separator in a VALUE included")

// MARK: - Accounts

let odd = "documents:A\u{1F}weird folder"
check(AppSecretStore.parse(AppSecretStore.account(vault: odd, app: "x", name: "y")).map { "\($0.vault)|\($0.app)|\($0.name)" } == "\(odd)|x|y", "read from the end: a vault name holding the separator")
check(AppSecretStore.parse("not-ours") == nil && AppSecretStore.parse("v\u{1F}Bad App\u{1F}n") == nil, "a foreign account is ignored")
for bad in ["", "Ticker", "-x", String(repeating: "a", count: 65), "a b", "a\u{1F}b"] {
	check((try? store.set(vault: A, app: bad, name: "n", value: "v")) == nil, "app id \(bad.debugDescription) refused")
}
for bad in ["", "a b", "a/b", String(repeating: "n", count: 65), "a\u{1F}b"] {
	check((try? store.set(vault: A, app: "x", name: bad, value: "v")) == nil, "name \(bad.debugDescription) refused")
}
check((try? store.set(vault: "", app: "x", name: "n", value: "v")) == nil, "no vault, no secret")

// MARK: - Revoke, forget, a new install

try! store.set(vault: A, app: "seminar-picker", name: "token", value: "p")
check((try? store.clearApp(vault: A, app: "stock-ticker")) == 2, "revoke clears that app's (two)")
check((try? store.names(vault: A, app: "stock-ticker")) == [], "it starts again with none")
check((try? store.get(vault: A, app: "seminar-picker", name: "token")) == "p", "another app's are kept")
check((try? store.get(vault: B, app: "stock-ticker", name: "finnhub-key")) == "elsewhere", "the same app in another vault keeps its own")
try! store.set(vault: odd, app: "stock-ticker", name: "k", value: "o")
check((try? store.clearVault(A)) == 1, "forgetting a vault clears its apps'")
check((try? store.get(vault: B, app: "stock-ticker", name: "finnhub-key")) == "elsewhere", "another vault untouched")
check((try? store.get(vault: odd, app: "stock-ticker", name: "k")) == "o", "a vault whose name only starts like it untouched")

let defaults = UserDefaults(suiteName: "clew-app-secrets-tests-\(UUID().uuidString)")!
mem.items["something an earlier install left"] = Data("x".utf8)
store.sweepIfNewInstall(defaults)
check(mem.items.isEmpty, "the first launch of an install sweeps the service")
try! store.set(vault: A, app: "stock-ticker", name: "finnhub-key", value: "kept")
store.sweepIfNewInstall(defaults)
check((try? store.get(vault: A, app: "stock-ticker", name: "finnhub-key")) == "kept", "later launches keep what was set")

// MARK: - No Keychain

mem.failing = true
do {
	try store.set(vault: A, app: "stock-ticker", name: "finnhub-key", value: "SECRET-VALUE")
	check(false, "a failing Keychain throws")
} catch {
	check(error.localizedDescription.hasPrefix("secrets are not kept on this device"), "unavailable, in words")
	check(!error.localizedDescription.contains("SECRET-VALUE"), "never the value in an error")
}

print("AppSecrets: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
