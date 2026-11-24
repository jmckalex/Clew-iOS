// "Export notes as PDF (reading view)" (Clew-app 393d482): the folder the
// user chose for a batch's PDFs, and what is written into it. Pure
// Foundation, so its rules are tested on the Mac (ios/Tests/
// NotesExportFolder, scripts/test-swift.sh); FSBridge gives it the document
// picker, the printer (PrintPDF.swift) and the Files app.
//
// The rule it holds: NOTHING already in the folder is changed. A PDF goes in
// under a name the batch planned (print-batch.js#batchPdfNames, numbered past
// what list() found when the user chose Keep Both), and only if that name is
// free when it lands: an exclusive rename of a finished temporary file, so a
// file that appeared meanwhile is refused, never replaced. Replace (the old
// PDF somewhere recoverable first) waits on the owner (Clew-boss, 2026-11-24);
// until then the iPad offers Keep Both and Cancel.
import Foundation

enum NotesExportFolder {
	enum Failure: LocalizedError, Equatable {
		case badName(String)
		case exists(String)
		case noSuchFolder

		var errorDescription: String? {
			switch self {
			case .badName(let name): return "\"\(name)\" is not a name for a PDF in the chosen folder"
			case .exists(let name): return "a file named \"\(name)\" is already in the folder, and was left as it was"
			case .noSuchFolder: return "the chosen folder is no longer there"
			}
		}
	}

	/// `name` (a batch PDF's, '/'-separated, relative) inside `folder`: no
	/// empty, `.` or `..` part, no hidden part, no NUL, a `.pdf` at the end.
	/// Everything a batch names is a vault note's path with `.pdf` for its
	/// extension, so a name that fails here was never planned.
	static func target(in folder: URL, name: String) throws -> URL {
		let parts = name.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
		guard !name.isEmpty, !name.contains("\0"), !name.contains("\\"), name.lowercased().hasSuffix(".pdf"),
			parts.allSatisfy({ !$0.isEmpty && $0 != "." && $0 != ".." && !$0.hasPrefix(".") }) else {
			throw Failure.badName(name)
		}
		var url = folder
		for part in parts { url.appendPathComponent(part) }
		let base = folder.standardizedFileURL.path
		guard url.standardizedFileURL.path.hasPrefix(base.hasSuffix("/") ? base : base + "/") else {
			throw Failure.badName(name)
		}
		return url
	}

	/// The files already in each of `dirs` ("" for the folder itself), as
	/// relative paths — for the batch's names, so the planner can number past
	/// them. An iCloud file not downloaded yet (`.Name.pdf.icloud`) counts as
	/// its name. A folder that is not there has nothing in it.
	static func list(in folder: URL, dirs: [String]) -> [String] {
		var found = Set<String>()
		for dir in Set(dirs) {
			let url = dir.isEmpty ? folder : folder.appendingPathComponent(dir, isDirectory: true)
			guard dir.isEmpty || (try? target(in: folder, name: dir + "/x.pdf")) != nil,
				let names = try? FileManager.default.contentsOfDirectory(atPath: url.path) else { continue }
			for raw in names {
				var name = raw
				if name.hasPrefix("."), name.hasSuffix(".icloud") { name = String(name.dropFirst().dropLast(".icloud".count)) }
				if name.isEmpty || name.hasPrefix(".") { continue }
				found.insert(dir.isEmpty ? name : "\(dir)/\(name)")
			}
		}
		return found.sorted()
	}

	/// `data` as `name` in `folder`, its subfolders made on the way, only if
	/// nothing is there by that name: written whole to a hidden temporary file
	/// beside it, then renamed into place exclusively (RENAME_EXCL), so a file
	/// of that name, there before or arriving meanwhile, stays as it was and
	/// this PDF is refused. Coordinated, for an iCloud or provider folder.
	static func writeNew(_ data: Data, as name: String, in folder: URL) throws {
		guard FileManager.default.fileExists(atPath: folder.path) else { throw Failure.noSuchFolder }
		let url = try target(in: folder, name: name)
		let dir = url.deletingLastPathComponent()
		try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
		let temp = dir.appendingPathComponent(".\(url.lastPathComponent).clew-tmp-\(UUID().uuidString)")
		var coordinationError: NSError?
		var failure: Error?
		NSFileCoordinator().coordinate(writingItemAt: url, options: [], error: &coordinationError) { target in
			do {
				defer { try? FileManager.default.removeItem(at: temp) } // gone once renamed
				try data.write(to: temp)
				try renameExclusive(temp, to: target, name: name)
			} catch {
				failure = error
			}
		}
		if let coordinationError { throw coordinationError }
		if let failure { throw failure }
	}

	/// rename(2) that never replaces: RENAME_EXCL where the volume has it
	/// (APFS); elsewhere FileManager's move, which refuses a destination
	/// that exists.
	private static func renameExclusive(_ from: URL, to: URL, name: String) throws {
		if renamex_np(from.path, to.path, UInt32(RENAME_EXCL)) == 0 { return }
		let code = errno
		if code == EEXIST { throw Failure.exists(name) }
		guard code == ENOTSUP || code == EINVAL else {
			throw NSError(domain: NSPOSIXErrorDomain, code: Int(code), userInfo: [NSFilePathErrorKey: to.path])
		}
		if FileManager.default.fileExists(atPath: to.path) { throw Failure.exists(name) }
		do {
			try FileManager.default.moveItem(at: from, to: to)
		} catch let error as CocoaError where error.code == .fileWriteFileExists {
			throw Failure.exists(name)
		}
	}
}
