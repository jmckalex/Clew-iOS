// The bundled demo vault, brought up to date in the user's copy — a port of
// Clew-app's main/demo-sync.js (5a99c9e, 15163db), rule for rule.
//
// The first launch copies the bundle's SeedVault to Documents/Demo Vault, and
// nothing touched that copy again, so whoever opened the demo once never saw
// a demo note added or improved later (no App Gallery after 77b0bea, no
// Signals book after cbfa692). Now each opening of the demo vault:
//   - ADDS the bundled files the copy was never given;
//   - UPDATES a file the user never changed: its content is still exactly
//     what Clew gave (the hash `.clew/demo-files.json` records) or a version
//     Clew ever shipped (DemoHistory.json, Clew-app's demo-history.json:
//     every committed version by sha256, with when it first shipped);
//   - never touches a file the user changed, never brings back one they
//     deleted (a file given before and missing now), and never writes into
//     `.clew/` or any dot path: a vault's plugins and scripts are code.
// A copy with no record (every iPad copy before this) is dated by its own
// untouched files: the newest first-shipped position among them is the
// oldest Clew it can have come from. A demo file shipped by then and missing
// now was deleted by the user and stays so; one first shipped later is added.
//
// One rule is the iPad's own: a copy with no record and nothing of the demo
// in it is left alone entirely (desktop gives it everything it lacks). On the
// iPad the demo's place is a Documents folder anyone can make in the Files
// app, so a folder that does not look like a demo copy is not treated as one.
//
// Writes go through VaultPaths.check, so nothing is written through a link
// that leaves the vault. ios/Tests/DemoSync ports desktop's test cases.
import CryptoKit
import Foundation

enum DemoSync {
	/// rel → the hash given (nil: given, hash unknown).
	typealias Record = [String: String?]
	/// rel → sha256 → when that version first shipped (nil: not an integer).
	typealias History = [String: [String: Int?]]

	static let manifest = ".clew/demo-files.json"

	/// Every regular file under `root`, relative with `/`, no dot names
	/// anywhere, links neither followed nor listed.
	static func listFiles(_ root: URL) -> [String] {
		var out: [String] = []
		func walk(_ dir: String, _ rel: String) {
			guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return }
			for name in names where !name.hasPrefix(".") {
				let abs = (dir as NSString).appendingPathComponent(name)
				let r = rel.isEmpty ? name : "\(rel)/\(name)"
				var st = stat()
				guard lstat(abs, &st) == 0 else { continue }
				switch st.st_mode & S_IFMT {
				case S_IFDIR: walk(abs, r)
				case S_IFREG: out.append(r)
				default: break
				}
			}
		}
		walk(root.path, "")
		return out.sorted()
	}

	static func sha256(_ data: Data) -> String {
		SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
	}

	static func hashes(_ root: URL) -> [String: String] {
		var out: [String: String] = [:]
		for rel in listFiles(root) {
			if let data = try? Data(contentsOf: root.appendingPathComponent(rel)) { out[rel] = sha256(data) }
		}
		return out
	}

	/// The record in a copy, or nil. A record from Clew-app 2619e1c (a list,
	/// no hashes) counts as given with no hash.
	static func readRecord(_ target: URL) -> Record? {
		guard let data = try? Data(contentsOf: target.appendingPathComponent(manifest)),
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
		if let list = json["files"] as? [String] {
			return Dictionary(list.map { ($0, String?.none) }, uniquingKeysWith: { a, _ in a })
		}
		if let files = json["files"] as? [String: Any] {
			return files.mapValues { $0 as? String }
		}
		return nil
	}

	/// DemoHistory.json, or an empty history.
	static func loadHistory(_ url: URL?) -> History {
		guard let url, let data = try? Data(contentsOf: url),
			let json = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
		return json.mapValues { versions in
			versions.mapValues { value -> Int? in
				guard let n = value as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
				let d = n.doubleValue
				return d == d.rounded() ? Int(d) : nil
			}
		}
	}

	/// When a version of a file first shipped: .some(position or nil) when
	/// the history holds that version, nil when it does not.
	private static func shippedAt(_ history: History, _ rel: String, _ hash: String) -> Int?? {
		guard let versions = history[rel], let at = versions[hash] else { return nil }
		return .some(at)
	}

	/// The oldest Clew a copy with no record can have come from: the newest
	/// first-shipped position among its files that are a version Clew
	/// shipped. Nil when none is.
	static func shippedSince(_ current: [String: String], _ history: History) -> Int? {
		var newest: Int?
		for (rel, have) in current {
			if case .some(.some(let at)) = shippedAt(history, rel, have), newest == nil || at > newest! { newest = at }
		}
		return newest
	}

	struct Plan: Equatable {
		var add: [String]
		var update: [String]
		var record: Record
	}

	/// What to do, and the record after it. Pure: hashes of the bundle's
	/// files and the copy's, the copy's record, and the history.
	static func plan(bundled: [String: String], current: [String: String], record: Record?, history: History = [:]) -> Plan {
		var add: [String] = []
		var update: [String] = []
		var next: Record = [:]
		// No record: what the copy was given is what Clew had shipped by the
		// date its files give it (nil: nothing recognisable, nothing known given).
		let since = record == nil ? shippedSince(current, history) : nil
		let firstShipped = { (rel: String) -> Int? in (history[rel] ?? [:]).values.compactMap { $0 }.min() }
		for rel in bundled.keys.sorted() {
			let want = bundled[rel]!
			let wasGiven = record?.keys.contains(rel) == true
			let given: String? = wasGiven ? (record![rel] ?? nil) : nil
			guard let have = current[rel] else {
				// Missing: given before means deleted by the user — it stays so.
				// With no record, given is what had shipped by the copy's date.
				if wasGiven { next[rel] = .some(given) }
				else if let since, let first = firstShipped(rel), first <= since { next[rel] = .some(nil) }
				else { add.append(rel); next[rel] = .some(want) }
				continue
			}
			if have == want { next[rel] = .some(want); continue }
			let untouched = (given != nil && have == given) || shippedAt(history, rel, have) != nil
			if untouched { update.append(rel); next[rel] = .some(want) }
			else { next[rel] = .some(given) }            // the user's: never touched
		}
		for (rel, h) in record ?? [:] where next[rel] == nil { next[rel] = .some(h) }
		return Plan(add: add, update: update, record: next)
	}

	/// Bring `target` (the user's copy) up to date with `source` (the bundle).
	/// Returns what it added and what it updated (relative paths).
	@discardableResult
	static func sync(source: URL, target: URL, history: History = [:]) throws -> (added: [String], updated: [String]) {
		let current = hashes(target)
		let record = readRecord(target)
		// The iPad's own rule (above): not a demo copy, not touched.
		if record == nil && shippedSince(current, history) == nil { return ([], []) }
		guard let root = VaultPaths.realPath(target.path) else { return ([], []) }
		let todo = Self.plan(bundled: hashes(source), current: current, record: record, history: history)
		var added: [String] = []
		var updated: [String] = []
		let fm = FileManager.default
		for rel in todo.add {
			let to = target.appendingPathComponent(rel)
			guard case .absent = VaultPaths.check(to.path, root: root) else { continue }  // something there, or a link out
			try fm.createDirectory(at: to.deletingLastPathComponent(), withIntermediateDirectories: true)
			try fm.copyItem(at: source.appendingPathComponent(rel), to: to)
			added.append(rel)
		}
		for rel in todo.update {
			let to = target.appendingPathComponent(rel)
			// Never through a link: a regular file, inside.
			guard !VaultPaths.isLink(to.path), case .inside = VaultPaths.check(to.path, root: root) else { continue }
			try AtomicFile.write(try Data(contentsOf: source.appendingPathComponent(rel)), to: to)
			updated.append(rel)
		}
		let file = target.appendingPathComponent(manifest)
		let next = recordText(todo.record)
		if (try? String(contentsOf: file, encoding: .utf8)) != next {
			let dir = file.deletingLastPathComponent()
			if case .escapes = VaultPaths.check(dir.path, root: root) { return (added, updated) }
			try fm.createDirectory(at: dir, withIntermediateDirectories: true)
			try AtomicFile.write(Data(next.utf8), to: file)
		}
		return (added, updated)
	}

	/// The record as desktop writes it: JSON.stringify({version: 2, files},
	/// null, '\t'), the files sorted.
	static func recordText(_ record: Record) -> String {
		func quote(_ s: String) -> String {
			let data = (try? JSONSerialization.data(withJSONObject: s, options: [.fragmentsAllowed, .withoutEscapingSlashes])) ?? Data("\"\"".utf8)
			return String(decoding: data, as: UTF8.self)
		}
		let rows = record.keys.sorted().map { rel -> String in
			let value = record[rel] ?? nil
			return "\t\t\(quote(rel)): \(value.map(quote) ?? "null")"
		}
		let files = rows.isEmpty ? "{}" : "{\n\(rows.joined(separator: ",\n"))\n\t}"
		return "{\n\t\"version\": 2,\n\t\"files\": \(files)\n}"
	}
}
