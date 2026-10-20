// Unit tests for ios/Clew/Sources/ExportJobs.swift — temp directories only.
//   npm run test:swift
import Foundation

var passed = 0
var failed = 0
func check(_ condition: Bool, _ name: String, line: Int = #line) {
	if condition { passed += 1 } else { failed += 1; print("FAIL [\(line)] \(name)") }
}
func fails(_ name: String, line: Int = #line, _ body: () throws -> Void) -> ExportJobs.Failure? {
	do { try body(); check(false, "\(name): threw", line: line); return nil } catch let failure as ExportJobs.Failure {
		passed += 1
		return failure
	} catch {
		check(false, "\(name): threw \(error)", line: line)
		return nil
	}
}

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("export-jobs-tests-\(UUID().uuidString)", isDirectory: true)
try! fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let jobs = ExportJobs(root: scratch)
let job = Data(#"{"init":{},"build":{}}"#.utf8)
let answer = { (files: [String], output: String) in
	try! JSONSerialization.data(withJSONObject: ["output": output, "files": files, "warnings": ["w1"], "ms": 12])
}

// MARK: - Paths an output may name

for good in ["Note.tex", "Note-figures/MetaPost/abc-1.pdf", "Note-figures/.jmarkdown-figures", "a b/c.pdf"] {
	check(ExportJobs.isSafeRelativePath(good), "safe: \(good)")
}
for bad in ["", "/etc/hosts", "../x", "a/../../x", "a//b", "./a", "a/./b", "a\\b", "a\0b", String(repeating: "a", count: 513)] {
	check(!ExportJobs.isSafeRelativePath(bad), "refused: \(bad.debugDescription)")
}

// MARK: - One job, single-use token

let token = try! jobs.begin(job: job)
check(token.count == 32 && token.allSatisfy(\.isHexDigit), "the token is 32 hex digits")
check(jobs.isRunning, "a job runs")
_ = fails("a second job while one runs") { _ = try jobs.begin(job: job) }
check(fails("another token's job") { _ = try jobs.takeJob(token: String(repeating: "0", count: 32)) } == .unknownToken, "unknown token")
_ = fails("an output before the job is taken") { try jobs.write(token: token, rel: "x.tex", data: Data()) }
check((try? jobs.takeJob(token: token)) == job, "the job, once")
check(fails("the job again") { _ = try jobs.takeJob(token: token) } == .alreadyServed, "single use")

// MARK: - Outputs

let folder = jobs.folder!
try! jobs.write(token: token, rel: "Note.tex", data: Data("\\documentclass{article}".utf8))
try! jobs.write(token: token, rel: "Note-figures/MetaPost/f-1.pdf", data: Data("%PDF-1.5".utf8))
check(fm.fileExists(atPath: folder.appendingPathComponent("Note-figures/MetaPost/f-1.pdf").path), "a nested output lands in the folder")
check(fails("the same output twice") { try jobs.write(token: token, rel: "Note.tex", data: Data()) } == .duplicate("Note.tex"), "written once")
check(fails("an escape") { try jobs.write(token: token, rel: "../escape.tex", data: Data()) } == .badPath("../escape.tex"), "no ..")
check(!fm.fileExists(atPath: scratch.appendingPathComponent("escape.tex").path), "nothing written outside")
_ = fails("a wrong token's output") { try jobs.write(token: String(repeating: "f", count: 32), rel: "y.tex", data: Data()) }
// A link planted inside the folder is not followed out of it.
let outside = scratch.appendingPathComponent("outside", isDirectory: true)
try! fm.createDirectory(at: outside, withIntermediateDirectories: true)
try! fm.createSymbolicLink(at: folder.appendingPathComponent("link"), withDestinationURL: outside)
check(fails("through a link") { try jobs.write(token: token, rel: "link/z.pdf", data: Data()) } == .badPath("link/z.pdf"), "a link is not followed")
check(!fm.fileExists(atPath: outside.appendingPathComponent("z.pdf").path), "nothing written through the link")
try! fm.removeItem(at: folder.appendingPathComponent("link"))

// MARK: - The last word must name what was written

check(fails("files that were not written") { _ = try jobs.finish(token: token, body: answer(["Note.tex"], "Note.tex")) }
	== .malformed("the files named are not the files written"), "the list must match")
check(!jobs.isRunning && !fm.fileExists(atPath: folder.path), "a refused answer ends the job and removes its folder")

let t2 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: t2)
try! jobs.write(token: t2, rel: "Note.tex", data: Data("tex".utf8))
try! jobs.write(token: t2, rel: "Note-figures/a.pdf", data: Data("%PDF".utf8))
let done = try! jobs.finish(token: t2, body: answer(["Note-figures/a.pdf", "Note.tex"], "Note.tex"))
check(done.output == "Note.tex" && done.files == ["Note.tex": 3, "Note-figures/a.pdf": 4], "done names the output and sizes")
check(done.warnings == ["w1"] && done.ms == 12, "warnings and time carried")
check(!jobs.isRunning && fm.fileExists(atPath: done.folder.appendingPathComponent("Note.tex").path), "a finished job's folder stays")
_ = fails("an output after done") { try jobs.write(token: t2, rel: "late.tex", data: Data()) }

// MARK: - A reported failure, a malformed answer

let t3 = try! jobs.begin(job: job)
check(!fm.fileExists(atPath: done.folder.path), "the next job sweeps the last one's folder")
_ = try! jobs.takeJob(token: t3)
let f3 = jobs.folder!
check(fails("reported") { _ = try jobs.finish(token: t3, body: Data(#"{"error":"BUILD FAILED: x"}"#.utf8)) } == .reported("BUILD FAILED: x"), "the page's error is said as is")
check(!fm.fileExists(atPath: f3.path), "and its folder is gone")
let t4 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: t4)
check(fails("not JSON") { _ = try jobs.finish(token: t4, body: Data("nope".utf8)) } == .malformed("not a JSON object"), "malformed")
let t5 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: t5)
try! jobs.write(token: t5, rel: "a.pdf", data: Data())
check(fails("an output never written") { _ = try jobs.finish(token: t5, body: answer(["a.pdf"], "Note.tex")) }
	== .malformed("the output Note.tex was never written"), "the output must be among the files")

// MARK: - Abandon, discard, sweep

let t6 = try! jobs.begin(job: job)
let f6 = jobs.folder!
jobs.abandon()
check(!jobs.isRunning && !fm.fileExists(atPath: f6.path), "abandon ends the job and removes its folder")
_ = fails("the abandoned job's token") { _ = try jobs.takeJob(token: t6) }

let t7 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: t7)
try! jobs.write(token: t7, rel: "N.tex", data: Data("x".utf8))
let running = jobs.folder!.lastPathComponent
check(!jobs.discard(folderName: running), "a running job's folder is not discarded")
let d7 = try! jobs.finish(token: t7, body: answer(["N.tex"], "N.tex"))
check(!jobs.discard(folderName: "../outside"), "only a job folder's name")
check(!jobs.discard(folderName: "clew-export-zz"), "a malformed name")
check(jobs.discard(folderName: d7.folder.lastPathComponent) && !fm.fileExists(atPath: d7.folder.path), "a finished job's folder is discarded")
check(fm.fileExists(atPath: outside.path), "nothing else was touched")
let stray = scratch.appendingPathComponent("clew-export-" + String(repeating: "a", count: 32), isDirectory: true)
try! fm.createDirectory(at: stray, withIntermediateDirectories: true)
jobs.sweep()
check(!fm.fileExists(atPath: stray.path) && fm.fileExists(atPath: outside.path), "sweep removes job folders only")

// MARK: - Limits

let t8 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: t8)
let big = Data(count: ExportJobs.maxBytes / 2 + 1)
try! jobs.write(token: t8, rel: "one.bin", data: big)
check(fails("past the size limit") { try jobs.write(token: t8, rel: "two.bin", data: big) } != nil, "the size is bounded")
jobs.abandon()

// MARK: - The share (L2)

check(ExportJobs.shareName("a/b:c") == "a-b-c" && ExportJobs.shareName("..x") == "x" && ExportJobs.shareName(" ") == "Export",
	"a note's name as a file's")
// The .tex alone: nothing else written, nothing named.
let s1 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: s1)
try! jobs.write(token: s1, rel: "Note.tex", data: Data("\\documentclass{article}".utf8))
check(jobs.finishedFolder(named: jobs.folder!.lastPathComponent) == nil, "a running job's folder is not one to share")
let d1 = try! jobs.finish(token: s1, body: answer(["Note.tex"], "Note.tex"))
let f1 = jobs.finishedFolder(named: d1.folder.lastPathComponent)!
let alone = try! ExportJobs.share(in: f1, name: "Note", output: "Note.tex", include: [], bibs: []) { _, _ in false }
check(alone.kind == "tex" && alone.url.lastPathComponent == "Note.tex" && alone.bytes == 23 && alone.entries == 1, "the .tex alone")
check(fails("an output that is not a .tex") { _ = try ExportJobs.share(in: f1, name: "Note", output: "../Note.tex", include: [], bibs: []) { _, _ in false } } != nil,
	"the output must be the folder's own .tex")

// A zip: the outputs, the vault files and bibliographies the .tex names.
let vault = scratch.appendingPathComponent("vault", isDirectory: true)
try! fm.createDirectory(at: vault.appendingPathComponent("Attachments"), withIntermediateDirectories: true)
try! fm.createDirectory(at: vault.appendingPathComponent("Library"), withIntermediateDirectories: true)
try! Data("PNG".utf8).write(to: vault.appendingPathComponent("Attachments/x y.png"))
try! Data("@book{a,}".utf8).write(to: vault.appendingPathComponent("Library/refs.bib"))
var asked: [String] = []
let copyFromVault = { (rel: String, dest: URL) throws -> Bool in
	asked.append(rel)
	let source = vault.appendingPathComponent(rel)
	guard fm.fileExists(atPath: source.path) else { return false }
	try fm.copyItem(at: source, to: dest)
	return true
}
let s2 = try! jobs.begin(job: job)
_ = try! jobs.takeJob(token: s2)
try! jobs.write(token: s2, rel: "My Note.tex", data: Data("tex".utf8))
try! jobs.write(token: s2, rel: "My Note-figures/MetaPost/f-1.pdf", data: Data("%PDF".utf8))
let d2 = try! jobs.finish(token: s2, body: answer(["My Note-figures/MetaPost/f-1.pdf", "My Note.tex"], "My Note.tex"))
let f2 = jobs.finishedFolder(named: d2.folder.lastPathComponent)!
let zipped = try! ExportJobs.share(in: f2, name: "My Note", output: "My Note.tex",
	include: ["Attachments/x y.png", "../escape.png", "My Note-figures/MetaPost/f-1.pdf", "Attachments/missing.png"],
	bibs: [(rel: "Library/refs.bib", as: "refs.bib"), (rel: "Library/refs.bib", as: "run.sh"), (rel: "Library/refs.bib", as: "../up.bib")],
	copy: copyFromVault)
check(zipped.kind == "zip" && zipped.url.lastPathComponent == "My Note.zip" && zipped.bytes > 0, "a zip named for the note")
check(zipped.entries == 4, "the .tex, its figure, the image and the bibliography (\(zipped.entries))")
check(Set(zipped.skipped) == ["../escape.png", "My Note-figures/MetaPost/f-1.pdf", "Attachments/missing.png", "run.sh", "../up.bib"],
	"skipped: an escape, an output's own path, a file the vault lacks, a bibliography not named .bib, one outside (\(zipped.skipped))")
check(!asked.contains("../escape.png") && !asked.contains("My Note-figures/MetaPost/f-1.pdf"), "nothing unsafe or taken is asked for")
let list = Process()
list.executableURL = URL(fileURLWithPath: "/usr/bin/unzip")
list.arguments = ["-Z1", zipped.url.path]
let pipe = Pipe()
list.standardOutput = pipe
try! list.run()
list.waitUntilExit()
let names = Set(String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
	.split(separator: "\n").map(String.init).filter { !$0.hasSuffix("/") })
check(names == ["My Note/My Note.tex", "My Note/My Note-figures/MetaPost/f-1.pdf", "My Note/Attachments/x y.png", "My Note/refs.bib"],
	"the zip's one folder holds the .tex, its figures, the image at its vault path and the .bib beside the .tex (\(names.sorted()))")
check(!fm.fileExists(atPath: scratch.appendingPathComponent("escape.png").path) && !fm.fileExists(atPath: scratch.appendingPathComponent("up.bib").path),
	"nothing written outside")
check(jobs.discard(folderName: d2.folder.lastPathComponent) && !fm.fileExists(atPath: zipped.url.path), "the share's folder is discarded whole")
check(jobs.finishedFolder(named: d2.folder.lastPathComponent) == nil, "and is no longer one to share")

print("ExportJobs: \(passed) passed, \(failed) failed")
exit(failed == 0 ? 0 : 1)
