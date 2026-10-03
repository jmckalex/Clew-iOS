// Unit tests for ios/Clew/Sources/AtomicFile.swift — temp directories only.
//   npm run test:swift
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("atomic-file-tests-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let note = scratch.appendingPathComponent("Note.md")

// MARK: - Writes

try! AtomicFile.write(Data("one".utf8), to: note)
check((try? String(contentsOf: note, encoding: .utf8)) == "one", "written")
check(!fm.fileExists(atPath: scratch.appendingPathComponent(".Note.md.clew-tmp").path), "no temp left behind")

// MARK: - The mtime VaultStore.write's guard compares

// The guard reads the mtime, writes, and reads it again on the SAME URL.
// A URL's cached resource values would still answer the first reading
// (the rename happens behind Foundation's back): every next save would
// look like another device's edit. stat(2) answers the new one.
for round in 1...3 {
	let url = URL(fileURLWithPath: note.path)
	let before = AtomicFile.mtimeMs(url)
	_ = try? url.resourceValues(forKeys: [.contentModificationDateKey]) // what used to be read
	Thread.sleep(forTimeInterval: 0.02)
	try! AtomicFile.write(Data("v\(round)".utf8), to: url)
	let after = AtomicFile.mtimeMs(url)
	let fresh = (try? URL(fileURLWithPath: note.path).resourceValues(forKeys: [.contentModificationDateKey]))?
		.contentModificationDate.map { $0.timeIntervalSince1970 * 1000 } ?? -1
	check(after > before, "round \(round): the mtime after a write is the new one (\(before) → \(after))")
	check(abs(after - fresh) < 0.5, "round \(round): stat agrees with a fresh URL to well under the guard's 0.5 ms")
}
check(AtomicFile.mtimeMs(scratch.appendingPathComponent("missing.md")) == 0, "a missing file answers 0")

print("AtomicFile: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
