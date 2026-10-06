// Unit tests for ios/Clew/Sources/DemoSync.swift — temp directories only.
// Desktop's cases (Clew-app tests/demo-sync.test.js at cbfa692), ported one
// for one, then the iPad's own. `npm run test:swift` (DEMO_BUNDLE and
// DEMO_HISTORY name the seed vault and Clew-app's demo-history.json).
import CryptoKit
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("demo-sync-tests-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }

func put(_ root: URL, _ rel: String, _ text: String) {
	let url = root.appendingPathComponent(rel)
	try! fm.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
	try! Data(text.utf8).write(to: url)
}
func read(_ root: URL, _ rel: String) -> String? { try? String(contentsOf: root.appendingPathComponent(rel), encoding: .utf8) }
func has(_ root: URL, _ rel: String) -> Bool { fm.fileExists(atPath: root.appendingPathComponent(rel).path) }
func h(_ text: String) -> String { DemoSync.sha256(Data(text.utf8)) }
func hist(_ o: [String: [String: Int]]) -> DemoSync.History { o.mapValues { $0.mapValues { Optional($0) } } }

// MARK: - The plan

do {
	// With a record of hashes: untouched updated, edited kept, deleted left deleted, new added.
	let plan = DemoSync.plan(
		bundled: ["Apps/Ticker/app.js": h("new ticker"), "Welcome.md": h("welcome v2"), "Old.md": h("old"), "New.md": h("new")],
		current: ["Apps/Ticker/app.js": h("old ticker"), "Welcome.md": h("welcome, my edit")],
		record: ["Apps/Ticker/app.js": h("old ticker"), "Welcome.md": h("welcome v1"), "Old.md": h("old")])
	check(plan.add == ["New.md"] && plan.update == ["Apps/Ticker/app.js"], "record: add New.md, update the ticker (\(plan.add), \(plan.update))")
	check(plan.record["Welcome.md"] == .some(h("welcome v1")), "the user's edit keeps the hash we gave")
	check(plan.record["Apps/Ticker/app.js"] == .some(h("new ticker")), "the updated ticker's new hash")
	check(plan.record["Old.md"] == .some(h("old")), "a deleted note stays recorded as given")
}

do {
	// A copy with no record (dev.6's): a version Clew shipped is updated; anything else is the user's.
	let history = hist(["Apps/Ticker/app.js": [h("old ticker"): 2], "Welcome.md": [h("welcome v1"): 1]])
	let plan = DemoSync.plan(
		bundled: ["Apps/Ticker/app.js": h("new ticker"), "Welcome.md": h("welcome v2"), "Features/App Gallery.md": h("g")],
		current: ["Apps/Ticker/app.js": h("old ticker"), "Welcome.md": h("welcome, my edit")],
		record: nil, history: history)
	check(plan.add == ["Features/App Gallery.md"] && plan.update == ["Apps/Ticker/app.js"], "no record: shipped version updated, the gallery added")
	check(plan.record.keys.contains("Welcome.md") && plan.record["Welcome.md"] == .some(nil), "given, hash unknown")
}

do {
	// 2619e1c's record (a list, no hashes) counts as given; the history still recognises a shipped version.
	let dir = scratch.appendingPathComponent("legacy")
	put(dir, ".clew/demo-files.json", #"{"files":["Welcome.md","Gone.md"]}"#)
	let record = DemoSync.readRecord(dir)
	check(record?.count == 2 && record?["Welcome.md"] == .some(nil) && record?["Gone.md"] == .some(nil), "a list record: given, no hashes")
	let plan = DemoSync.plan(bundled: ["Welcome.md": h("v2"), "Gone.md": h("g")], current: ["Welcome.md": h("v1")],
		record: record, history: hist(["Welcome.md": [h("v1"): 1]]))
	check(plan.add.isEmpty && plan.update == ["Welcome.md"], "Gone.md stays gone; Welcome v1 is updated")
}

do {
	// No record: the copy is dated by its untouched files — a note shipped by
	// then and missing stays deleted, a later one is added.
	let history = hist([
		"Welcome.md": [h("welcome v1"): 1, h("welcome v2"): 5],
		"Guide/Old.md": [h("old"): 2],
		"Apps/Ticker/app.js": [h("old ticker"): 3, h("new ticker"): 5],
		"Features/App Gallery.md": [h("g"): 4],
	])
	let current = ["Apps/Ticker/app.js": h("old ticker"), "Welcome.md": h("welcome v1")]
	check(DemoSync.shippedSince(current, history) == 3, "dated at 3")
	let plan = DemoSync.plan(
		bundled: ["Apps/Ticker/app.js": h("new ticker"), "Welcome.md": h("welcome v2"), "Guide/Old.md": h("old"), "Features/App Gallery.md": h("g")],
		current: current, record: nil, history: history)
	check(plan.add == ["Features/App Gallery.md"] && plan.update == ["Apps/Ticker/app.js", "Welcome.md"], "dated: \(plan.add) \(plan.update)")
	check(plan.record.keys.contains("Guide/Old.md") && plan.record["Guide/Old.md"] == .some(nil), "recorded as given: deleted, it stays so")
}

do {
	// No record and nothing recognisable: the PLAN adds everything missing
	// (desktop). The iPad's sync() leaves such a folder alone (below).
	let history = hist(["Welcome.md": [h("welcome v1"): 1], "Guide/Old.md": [h("old"): 2]])
	let bundled = ["Welcome.md": h("welcome v2"), "Guide/Old.md": h("old")]
	for current in [[:], ["Welcome.md": h("my own welcome"), "Mine.md": h("mine")]] as [[String: String]] {
		check(DemoSync.shippedSince(current, history) == nil, "nothing recognisable")
		let plan = DemoSync.plan(bundled: bundled, current: current, record: nil, history: history)
		check(plan.add == (current["Welcome.md"] != nil ? ["Guide/Old.md"] : ["Guide/Old.md", "Welcome.md"]), "adds what is missing: \(plan.add)")
		check(plan.update.isEmpty, "updates nothing")
	}
}

// MARK: - The real history

if let bundlePath = ProcessInfo.processInfo.environment["DEMO_BUNDLE"],
	let historyPath = ProcessInfo.processInfo.environment["DEMO_HISTORY"] {
	// A copy as dev.6 made it, one old note deleted — not brought back; the Books notes are added.
	let real = DemoSync.loadHistory(URL(fileURLWithPath: historyPath))
	let bundleURL = URL(fileURLWithPath: bundlePath)
	check(real.count > 50, "the real history loaded (\(real.count) files)")
	let first = { (rel: String) -> Int in (real[rel] ?? [:]).values.compactMap { $0 }.min() ?? Int.max }
	let dev6 = first("Books/Signals/Signals.md") - 1
	let bundled = DemoSync.hashes(bundleURL)
	var current: [String: String] = [:]
	for rel in bundled.keys {
		let shipped = (real[rel] ?? [:]).compactMap { k, v in v.map { (k, $0) } }.filter { $0.1 <= dev6 }.sorted { $0.1 > $1.1 }
		if let newest = shipped.first { current[rel] = newest.0 }
	}
	let gone = "Reading/Evolutionary Game Theory.md"
	check(current.removeValue(forKey: gone) != nil, "dev.6 shipped it")
	let plan = DemoSync.plan(bundled: bundled, current: current, record: nil, history: real)
	check(!plan.add.contains(gone), "the deleted note is not brought back")
	for rel in bundled.keys where rel.hasPrefix("Books/") { check(plan.add.contains(rel), "\(rel) added") }
	check(!plan.add.isEmpty && plan.add.allSatisfy { first($0) > dev6 }, "only notes newer than dev.6 added: \(plan.add)")
	// Every file of the bundle is a version the history knows (a fresh copy
	// is recognisable, so it gets its record).
	check(bundled.allSatisfy { real[$0.key]?[$0.value] != nil }, "the bundle is in the history")
} else {
	print("SKIP the real-history case: DEMO_BUNDLE / DEMO_HISTORY not set")
}

// MARK: - On disk

do {
	// The old ticker updated, Welcome's edit kept, a deleted note left deleted, .clew untouched.
	let source = scratch.appendingPathComponent("bundle")
	let target = scratch.appendingPathComponent("copy")
	put(source, "Apps/Ticker/app.js", "new ticker\n")
	put(source, "Welcome.md", "Welcome, v2.\n")
	put(source, "Guide/Old.md", "old\n")
	put(source, "Features/App Gallery.md", "# App Gallery\n")
	put(source, ".clew/plugins/p/main.js", "// code\n")
	put(target, "Apps/Ticker/app.js", "old ticker\n")
	put(target, "Welcome.md", "Welcome, v1 — and my own edit.\n")
	let history = hist([
		"Welcome.md": [h("Welcome, v1.\n"): 1], "Guide/Old.md": [h("old\n"): 2],
		"Apps/Ticker/app.js": [h("old ticker\n"): 3], "Features/App Gallery.md": [h("# App Gallery\n"): 4],
	])
	let first = try! DemoSync.sync(source: source, target: target, history: history)
	check(first.added == ["Features/App Gallery.md"] && first.updated == ["Apps/Ticker/app.js"], "first: \(first)")
	check(!has(target, "Guide/Old.md"), "deleted stays deleted")
	check(read(target, "Apps/Ticker/app.js") == "new ticker\n", "the ticker updated")
	check(read(target, "Welcome.md") == "Welcome, v1 — and my own edit.\n", "the edit kept")
	check(!has(target, ".clew/plugins/p/main.js"), "no code into .clew")
	let json = try! JSONSerialization.jsonObject(with: Data(contentsOf: target.appendingPathComponent(".clew/demo-files.json"))) as! [String: Any]
	check(json["version"] as? Int == 2, "the record is version 2")
	// Twice: nothing changes, the record is not rewritten.
	let recordFile = target.appendingPathComponent(".clew/demo-files.json")
	let before = try! Data(contentsOf: recordFile)
	let stamp = (try! fm.attributesOfItem(atPath: recordFile.path)[.modificationDate] as! Date)
	Thread.sleep(forTimeInterval: 0.05)
	let again = try! DemoSync.sync(source: source, target: target, history: history)
	check(again.added.isEmpty && again.updated.isEmpty, "a second opening is quiet")
	check((try! Data(contentsOf: recordFile)) == before && (try! fm.attributesOfItem(atPath: recordFile.path)[.modificationDate] as! Date) == stamp, "the record untouched")
	// Now with a record: deleting a demo note sticks.
	try! fm.removeItem(at: target.appendingPathComponent("Features/App Gallery.md"))
	let third = try! DemoSync.sync(source: source, target: target, history: history)
	check(third.added.isEmpty && third.updated.isEmpty && !has(target, "Features/App Gallery.md"), "a deletion with a record sticks")
	// A newer bundle: the untouched ticker follows it, the edited Welcome does not.
	put(source, "Apps/Ticker/app.js", "newer ticker\n")
	put(source, "Welcome.md", "Welcome, v3.\n")
	let fourth = try! DemoSync.sync(source: source, target: target, history: history)
	check(fourth.added.isEmpty && fourth.updated == ["Apps/Ticker/app.js"], "newer bundle: \(fourth)")
	check(read(target, "Welcome.md") == "Welcome, v1 — and my own edit.\n", "still the user's")
	check(DemoSync.listFiles(target) == ["Apps/Ticker/app.js", "Welcome.md"], "only those two: \(DemoSync.listFiles(target))")
	// The record's shape is desktop's (JSON.stringify(…, null, '\t')).
	check(DemoSync.recordText(["b": "x", "a": nil]) == "{\n\t\"version\": 2,\n\t\"files\": {\n\t\t\"a\": null,\n\t\t\"b\": \"x\"\n\t}\n}", "the record's text")
	check(DemoSync.recordText([:]) == "{\n\t\"version\": 2,\n\t\"files\": {}\n}", "an empty record's text")
}

// MARK: - The iPad's own rules

do {
	// A folder with no record and nothing of the demo in it is not a demo copy: untouched.
	let source = scratch.appendingPathComponent("bundle2")
	let target = scratch.appendingPathComponent("not-a-demo")
	put(source, "Welcome.md", "Welcome.\n")
	put(source, "Guide/Old.md", "old\n")
	put(target, "Welcome.md", "My own vault.\n")
	put(target, "Notes/Mine.md", "mine\n")
	let history = hist(["Welcome.md": [h("Welcome.\n"): 1], "Guide/Old.md": [h("old\n"): 2]])
	let out = try! DemoSync.sync(source: source, target: target, history: history)
	check(out.added.isEmpty && out.updated.isEmpty, "nothing added or updated")
	check(!has(target, "Guide/Old.md") && !has(target, ".clew/demo-files.json"), "no demo note, no record")
	check(read(target, "Welcome.md") == "My own vault.\n", "its Welcome untouched")
	// An empty folder too.
	let empty = scratch.appendingPathComponent("empty")
	try! fm.createDirectory(at: empty, withIntermediateDirectories: true)
	let none = try! DemoSync.sync(source: source, target: empty, history: history)
	check(none.added.isEmpty && DemoSync.listFiles(empty).isEmpty && !has(empty, ".clew"), "an empty folder untouched")
}

do {
	// Nothing is written through a link leaving the copy.
	let source = scratch.appendingPathComponent("bundle3")
	let target = scratch.appendingPathComponent("linked")
	let outside = scratch.appendingPathComponent("outside")
	put(source, "Welcome.md", "Welcome v2.\n")
	put(source, "Books/Signals/Signals.md", "# Signals\n")
	put(source, "Notes/Old.md", "old v2\n")
	put(target, "Welcome.md", "Welcome v1.\n")
	put(outside, "Old.md", "old v1\n")
	try! fm.createDirectory(at: outside.appendingPathComponent("Signals"), withIntermediateDirectories: true)
	// Books → outside (a folder link), Notes/Old.md → outside/Old.md (a file link).
	try! fm.createSymbolicLink(atPath: target.appendingPathComponent("Books").path, withDestinationPath: outside.path)
	try! fm.createDirectory(at: target.appendingPathComponent("Notes"), withIntermediateDirectories: true)
	try! fm.createSymbolicLink(atPath: target.appendingPathComponent("Notes/Old.md").path, withDestinationPath: outside.appendingPathComponent("Old.md").path)
	let history = hist(["Welcome.md": [h("Welcome v1.\n"): 1], "Notes/Old.md": [h("old v1\n"): 1], "Books/Signals/Signals.md": [h("# Signals\n"): 2]])
	let out = try! DemoSync.sync(source: source, target: target, history: history)
	check(out.updated == ["Welcome.md"], "only Welcome updated: \(out)")
	check(!out.added.contains("Books/Signals/Signals.md") && !has(outside, "Signals/Signals.md"), "nothing added through the folder link")
	check(read(outside, "Old.md") == "old v1\n", "nothing written through the file link")
}

print("DemoSync: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
