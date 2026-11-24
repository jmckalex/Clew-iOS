// Unit tests for ios/Clew/Sources/NotesExportFolder.swift — "Export notes as
// PDF (reading view)": what goes into the chosen folder, and that nothing
// already there is ever changed. Temp directories only.
//   npm run test:swift
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}
func failure(_ name: String, line: Int = #line, _ body: () throws -> Void) -> NotesExportFolder.Failure? {
	do { try body(); check(false, "\(name): did not throw", line: line); return nil } catch let f as NotesExportFolder.Failure {
		passed += 1
		return f
	} catch {
		check(false, "\(name): threw \(error)", line: line)
		return nil
	}
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("notes-export-tests-\(UUID().uuidString)", isDirectory: true)
let folder = scratch.appendingPathComponent("Marked essays", isDirectory: true)
try! fm.createDirectory(at: folder, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let pdf = { (s: String) in Data("%PDF-1.4 \(s)".utf8) }
let text = { (rel: String) in (try? String(contentsOf: folder.appendingPathComponent(rel), encoding: .utf8)) ?? "" }

// MARK: - Names a batch may write

for good in ["Ann.pdf", "Week 1/Ann.pdf", "Participant 7556723.pdf", "a b/c d/é.PDF", "Ann 2.pdf"] {
	check((try? NotesExportFolder.target(in: folder, name: good)) != nil, "a name: \(good)")
}
for bad in ["", "/etc/x.pdf", "../x.pdf", "a/../../x.pdf", "a//b.pdf", "./a.pdf", "a/./b.pdf", ".hidden.pdf", "a/.b/c.pdf",
	"a\\b.pdf", "a\0b.pdf", "Ann.md", "Ann", "Week 1/"] {
	check(failure("refused: \(bad.debugDescription)") { _ = try NotesExportFolder.target(in: folder, name: bad) } == .badName(bad), "badName: \(bad.debugDescription)")
}

// MARK: - A new PDF, its subfolders made

try! NotesExportFolder.writeNew(pdf("ann"), as: "Ann.pdf", in: folder)
try! NotesExportFolder.writeNew(pdf("week ann"), as: "Week 1/Ann.pdf", in: folder)
check(text("Ann.pdf") == "%PDF-1.4 ann", "written whole")
check(text("Week 1/Ann.pdf") == "%PDF-1.4 week ann", "into a subfolder made on the way")
let leftovers = (fm.enumerator(atPath: folder.path)?.allObjects as? [String] ?? []).filter { $0.contains("clew-tmp") }
check(leftovers.isEmpty, "no temporary file left: \(leftovers)")

// MARK: - Nothing there is ever changed

try! pdf("the marked one, sent").write(to: folder.appendingPathComponent("Bob.pdf"))
let before = try! fm.attributesOfItem(atPath: folder.appendingPathComponent("Bob.pdf").path)[.modificationDate] as! Date
check(failure("a name already there") { try NotesExportFolder.writeNew(pdf("bob again"), as: "Bob.pdf", in: folder) } == .exists("Bob.pdf"), "refused: exists")
check(text("Bob.pdf") == "%PDF-1.4 the marked one, sent", "the old PDF as it was")
let after = try! fm.attributesOfItem(atPath: folder.appendingPathComponent("Bob.pdf").path)[.modificationDate] as! Date
check(before == after, "not even touched")
check(failure("over a PDF this batch wrote") { try NotesExportFolder.writeNew(pdf("ann twice"), as: "Ann.pdf", in: folder) } == .exists("Ann.pdf"), "refused: its own")
check(text("Ann.pdf") == "%PDF-1.4 ann", "kept")
try! fm.createDirectory(at: folder.appendingPathComponent("Carol.pdf"), withIntermediateDirectories: true)
check(failure("a folder by that name") { try NotesExportFolder.writeNew(pdf("carol"), as: "Carol.pdf", in: folder) } == .exists("Carol.pdf"), "refused: a folder")
check((try? fm.contentsOfDirectory(atPath: folder.appendingPathComponent("Carol.pdf").path)) == [], "the folder untouched")
let leftovers2 = (fm.enumerator(atPath: folder.path)?.allObjects as? [String] ?? []).filter { $0.contains("clew-tmp") }
check(leftovers2.isEmpty, "a refusal leaves no temporary file: \(leftovers2)")
check(failure("a bad name") { try NotesExportFolder.writeNew(pdf("x"), as: "../Escaped.pdf", in: folder) } == .badName("../Escaped.pdf"), "refused: escape")
check(!fm.fileExists(atPath: scratch.appendingPathComponent("Escaped.pdf").path), "nothing outside the folder")
let gone = scratch.appendingPathComponent("Gone", isDirectory: true)
check(failure("a folder no longer there") { try NotesExportFolder.writeNew(pdf("x"), as: "x.pdf", in: gone) } == .noSuchFolder, "refused: no folder")
check(!fm.fileExists(atPath: gone.path), "and not made")

// MARK: - What is there, for the planner

try! Data().write(to: folder.appendingPathComponent(".Dee.pdf.icloud"))
try! Data().write(to: folder.appendingPathComponent(".DS_Store"))
try! Data().write(to: folder.appendingPathComponent("Week 1/Notes.txt"))
check(NotesExportFolder.list(in: folder, dirs: [""]) == ["Ann.pdf", "Bob.pdf", "Carol.pdf", "Dee.pdf", "Week 1"],
	"the folder's own, an evicted iCloud file by its name, hidden files not: \(NotesExportFolder.list(in: folder, dirs: [""]))")
check(NotesExportFolder.list(in: folder, dirs: ["Week 1", "Week 2", "../.."]) == ["Week 1/Ann.pdf", "Week 1/Notes.txt"],
	"a subfolder's; one not there has nothing; one outside is not looked in: \(NotesExportFolder.list(in: folder, dirs: ["Week 1", "Week 2", "../.."]))")

print("NotesExportFolder: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
