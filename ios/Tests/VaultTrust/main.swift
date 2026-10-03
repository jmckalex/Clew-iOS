// Unit tests for ios/Clew/Sources/VaultTrust.swift (the interim vault-trust
// store) — temp directories only.   npm run test:swift
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("vault-trust-tests-\(UUID().uuidString)", isDirectory: true)
defer { try? fm.removeItem(at: scratch) }

/// A fake app container: Documents + Application Support.
func container(_ name: String) -> (docs: URL, store: URL) {
	let root = scratch.appendingPathComponent(name, isDirectory: true)
	let docs = root.appendingPathComponent("Documents", isDirectory: true)
	try! fm.createDirectory(at: docs, withIntermediateDirectories: true)
	return (docs, root.appendingPathComponent("Library/Application Support/vault-trust.json"))
}

func mkvault(_ parent: URL, _ name: String) -> URL {
	let url = parent.appendingPathComponent(name, isDirectory: true)
	try! fm.createDirectory(at: url.appendingPathComponent(".clew"), withIntermediateDirectories: true)
	return url
}

// MARK: - Migration and first sight

do {
	let c = container("c1")
	let known = mkvault(c.docs, "Known")
	let fresh = mkvault(c.docs, "Fresh")
	let away = scratch.appendingPathComponent("unplugged/Away", isDirectory: true)   // not on disk yet
	let store = VaultTrustStore(file: c.store, documentsURL: c.docs)
	check(!store.hasMigrated, "a first launch has not migrated")
	check(store.migrate([known, away]) == 2, "migration records every known vault")
	check(store.hasMigrated, "…once")
	check(store.migrate([fresh]) == 0, "a second migration records nothing")
	check(store.isTrusted(known), "a known vault stays trusted")
	check(!store.isTrusted(fresh), "a vault new to the device is not")
	check(store.entries()[store.identity(away)]?.fingerprint == nil, "an unreachable known vault is recorded without a fingerprint")
	try! fm.createDirectory(at: away, withIntermediateDirectories: true)
	check(store.isTrusted(away), "…and trusted at first sight")
	check(store.entries()[store.identity(away)]?.fingerprint != nil, "…taking its fingerprint then")
}

// MARK: - A different folder at a trusted identity asks again

do {
	let c = container("c2")
	let vault = mkvault(c.docs, "Swapped")
	let store = VaultTrustStore(file: c.store, documentsURL: c.docs)
	store.trust(vault)
	check(store.isTrusted(vault), "trusted")
	try! fm.removeItem(at: vault)
	Thread.sleep(forTimeInterval: 0.02)   // a different creation time
	_ = mkvault(c.docs, "Swapped")
	check(!store.isTrusted(vault), "a vault replaced at the same path asks again")
	store.revoke(vault)
	check(!store.isTrusted(vault), "revoked")
	store.trust(vault)
	check(store.isTrusted(vault), "trusted again by the user")
}

// MARK: - Persistence, a damaged file, and a store written elsewhere

do {
	let c = container("c3")
	let a = mkvault(c.docs, "A")
	let first = VaultTrustStore(file: c.store, documentsURL: c.docs)
	first.migrate([a])
	let second = VaultTrustStore(file: c.store, documentsURL: c.docs)
	check(second.isTrusted(a) && second.hasMigrated, "the store persists")
	try! Data("{ not json".utf8).write(to: c.store)
	let damaged = VaultTrustStore(file: c.store, documentsURL: c.docs)
	check(!damaged.isTrusted(a), "a damaged store trusts nothing")
	check(damaged.hasMigrated && damaged.migrate([a]) == 0, "…and counts as migrated, so nothing is re-trusted")
	let volatile = VaultTrustStore(file: scratch.appendingPathComponent("never/written.json"), documentsURL: c.docs, persist: false)
	volatile.trust(a)
	check(!fm.fileExists(atPath: scratch.appendingPathComponent("never/written.json").path), "persist: false writes nothing")
}

// MARK: - The identity: no container path, and never the vault's choice

do {
	let c = container("c4")
	let vault = mkvault(c.docs, "Moved With The Container")
	let store = VaultTrustStore(file: c.store, documentsURL: c.docs)
	store.trust(vault, source: "demo")
	check(store.identity(vault) == "documents:Moved With The Container", "a Documents vault is keyed by its path inside Documents")
	// An app update moves the whole container: same vault, new absolute path.
	let moved = scratch.appendingPathComponent("c4-after-update", isDirectory: true)
	try! fm.moveItem(at: scratch.appendingPathComponent("c4"), to: moved)
	let docs2 = moved.appendingPathComponent("Documents", isDirectory: true)
	let store2 = VaultTrustStore(file: moved.appendingPathComponent("Library/Application Support/vault-trust.json"), documentsURL: docs2)
	let vault2 = docs2.appendingPathComponent("Moved With The Container", isDirectory: true)
	check(store2.identity(vault2) == store.identity(vault), "the identity survives the container moving")
	check(store2.isTrusted(vault2), "…and so does the trust (a move keeps the creation time)")
	let external = mkvault(scratch.appendingPathComponent("iCloud Drive", isDirectory: true), "Shared")
	check(store2.identity(external).hasPrefix("path:/"), "a vault outside the container is keyed by its resolved path")
	check(!store2.isTrusted(external), "…and is not trusted by default")
	// Nothing in the vault can name its identity: a .clew/trust file is ignored.
	try! Data("{\"trusted\":true}".utf8).write(to: external.appendingPathComponent(".clew/vault-trust.json"))
	check(!store2.isTrusted(external), "a trust file planted in the vault means nothing")
}

// MARK: - Forgetting a vault Clew made and removed unused

do {
	let c = container("c-forget")
	let store = VaultTrustStore(file: c.store, documentsURL: c.docs)
	let made = mkvault(c.docs, "My Vault")
	store.trust(made, source: "created")
	check(store.isTrusted(made), "a created vault is trusted")
	store.forget(made)
	check(store.entries()[store.identity(made)] == nil, "forget removes its entry")
	check(!store.isTrusted(made), "…so a folder of that name is no longer trusted")
	store.forget(made) // nothing to forget: no harm
	let kept = mkvault(c.docs, "Kept")
	store.trust(kept)
	store.forget(made)
	check(store.isTrusted(kept), "forgetting one vault leaves the others")
}

// MARK: - Version 2: enablements on the device, the vault only asks

do {
	let c = container("v2")
	let known = mkvault(c.docs, "Known")
	let fresh = mkvault(c.docs, "Fresh")
	let store = VaultTrustStore(file: c.store, documentsURL: c.docs)
	store.migrate([known])
	// A legacy entry (migrated) copies what its settings enabled, once, with
	// the network on for a trusted vault, and counts as decided.
	let request: [String: Any] = ["plugins": ["charts", "Bad Id"], "noteApi": true, "dataviewJs": false]
	let a = store.accessFor(known, requests: request)
	check(a["trusted"] as? Bool == true && a["decided"] as? Bool == true, "a migrated vault: trusted and decided")
	check(a["scripts"] as? Bool == true && a["noteApi"] as? Bool == true && a["network"] as? Bool == true, "legacy: scripts, its noteApi request, the network")
	check(a["plugins"] as? [String] == ["charts"], "only well-formed plugin ids")
	// Copied once: a changed request is no grant.
	let b = store.accessFor(known, requests: ["noteApi": false, "dataviewJs": true])
	check(b["noteApi"] as? Bool == true && b["dataviewJs"] as? Bool == false, "a later request changes nothing")
	// A vault never seen: restricted and undecided, whatever it asks.
	let f = store.accessFor(fresh, requests: ["noteApi": true, "plugins": ["charts"]])
	check(f["trusted"] as? Bool == false && f["decided"] as? Bool == false, "a new vault: restricted, undecided")
	check(f["noteApi"] as? Bool == false && f["scripts"] as? Bool == false, "nothing of its own runs")
	// setEnable on an undecided vault: a global plugin for it, still undecided.
	store.setEnable(fresh, patch: ["plugins": ["header"]])
	let g = store.accessFor(fresh, requests: nil)
	check(g["decided"] as? Bool == false && g["plugins"] as? [String] == ["header"], "a switched-on plugin is no answer to the prompt")
	// The prompt's yes: trusted with the vault's request.
	store.trust(fresh, enable: .normalize(["noteApi": true, "plugins": ["header", "charts"]], scripts: true))
	let h = store.accessFor(fresh, requests: nil)
	check(h["trusted"] as? Bool == true && h["decided"] as? Bool == true && h["noteApi"] as? Bool == true, "trusted with its request")
	check(h["network"] as? Bool == false, "the network only when asked and granted")
	// Revoke keeps the enablements for a later trust; effective access drops them.
	store.revoke(fresh)
	let r = store.accessFor(fresh, requests: nil)
	check(r["trusted"] as? Bool == false && r["noteApi"] as? Bool == false && r["decided"] as? Bool == true, "revoked: restricted, decided")
	check(store.enablements(fresh).noteApi == true, "…its enablements kept")
	store.trust(fresh)
	check(store.accessFor(fresh, requests: nil)["noteApi"] as? Bool == true, "trusted again: they apply again")
	// Unknown keys are ignored by setEnable.
	let e = store.setEnable(fresh, patch: ["network": true, "evil": true])
	check(e.network && store.accessFor(fresh, requests: nil)["network"] as? Bool == true, "the network switched on")
	// forgetKey: the next open is a first open.
	store.forgetKey(store.identity(fresh))
	check(store.accessFor(fresh, requests: nil)["decided"] as? Bool == false, "forgotten: undecided again")
}

do {
	// The one-time notice: true once for a version-1 store, never for a fresh one.
	let c = container("notice")
	try? FileManager.default.createDirectory(at: c.store.deletingLastPathComponent(), withIntermediateDirectories: true)
	try! #"{"version":1,"migratedAt":"2026-01-01T00:00:00Z","vaults":{}}"#.data(using: .utf8)!.write(to: c.store)
	let old = VaultTrustStore(file: c.store, documentsURL: c.docs)
	check(old.takeNotice() == true, "a version-1 store: the notice, once")
	check(old.takeNotice() == false, "…and only once")
	let c2 = container("notice-fresh")
	let fresh = VaultTrustStore(file: c2.store, documentsURL: c2.docs)
	check(fresh.takeNotice() == false, "a fresh store never shows it")
}

print("VaultTrust: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
