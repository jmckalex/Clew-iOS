// Atomic file writes — the on-disk convention shared with the desktop app.
//
// Desktop (src/main/fs-utils.js#writeFileAtomic) writes every durable file
// as temp + fsync + rename, and the temp is `.<basename>.clew-tmp` BESIDE
// the target. iOS matches the shape exactly, not just the guarantee, because
// both apps write the same iCloud vaults: a dotfile stays out of every
// vault walk on either side (VaultStore skips dot-entries; chokidar skips
// dotfiles), and the FIXED name means a temp orphaned by a crash is swept
// by the next successful save of the same file — whichever app makes it.
//
// Foundation's write(atomically:) was already temp + rename, but under its
// own temp name and without a flush; what this buys is the shared name and
// F_FULLFSYNC, the call that actually reaches the platter on Apple platforms
// (and what libuv gives Node's fsyncSync on Darwin).
import Foundation

enum AtomicFile {
	/// Write `data` so that a crash at any moment leaves either the old
	/// content or the new at `file` — never a truncated half.
	static func write(_ data: Data, to file: URL) throws {
		// Written THROUGH a symlink, as upstream does: renaming onto the link
		// itself would replace it with a regular file and orphan the real
		// note. (A Files-app vault cannot contain one, but the rule costs
		// one call.)
		let target = file.resolvingSymlinksInPath()
		let temp = target.deletingLastPathComponent()
			.appendingPathComponent(".\(target.lastPathComponent).clew-tmp")
		let fd = open(temp.path, O_WRONLY | O_CREAT | O_TRUNC, 0o644)
		guard fd >= 0 else { throw posixError("open \(temp.lastPathComponent)") }
		do {
			// The target's permissions survive the inode swap.
			var st = stat()
			if stat(target.path, &st) == 0 { fchmod(fd, st.st_mode & 0o7777) }
			try data.withUnsafeBytes { (raw: UnsafeRawBufferPointer) in
				guard let base = raw.baseAddress else { return } // empty file
				var off = 0
				while off < raw.count {
					let n = Darwin.write(fd, base + off, raw.count - off)
					guard n >= 0 else { throw posixError("write \(target.lastPathComponent)") }
					off += n
				}
			}
			if fcntl(fd, F_FULLFSYNC) != 0 { fsync(fd) }
			close(fd)
		} catch {
			close(fd)
			unlink(temp.path)
			throw error
		}
		guard rename(temp.path, target.path) == 0 else {
			let error = posixError("rename \(target.lastPathComponent)")
			unlink(temp.path)
			throw error
		}
	}

	/// The failing call's errno, read before anything else can clobber it.
	private static func posixError(_ op: String) -> Error {
		let code = errno
		return NSError(domain: NSPOSIXErrorDomain, code: Int(code),
			userInfo: [NSLocalizedDescriptionKey: "\(op): \(String(cString: strerror(code)))"])
	}
}
