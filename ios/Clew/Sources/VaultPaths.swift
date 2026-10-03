import Foundation

/// Vault containment by REAL path. A symlink inside a vault is followed
/// only while it stays inside the vault.
///
/// A lexical check (standardizedFileURL) never follows links: a vault
/// carrying `leak.md -> ../../Library/Preferences/…` passed it, and the
/// preview scheme served the app's own container, its preferences (which
/// hold the external-vault bookmarks), the trust store and every other
/// vault (measured 2026-10-03; frame-bridge R1). Bookmarks do not
/// canonicalise (one made through a link keeps the link's path), and
/// Foundation's resolvingSymlinksInPath drops `/private`. So this is POSIX
/// realpath on both sides, and a failure is a refusal.
///
/// On iPad a link leaving its vault cannot be a working link anyway: it
/// dangles (a Mac path), or the sandbox refuses it (outside the picked
/// folder's security scope), or it reaches the app's own container.
enum VaultPaths {
	/// POSIX realpath, or nil (missing, a dangling link, no permission).
	static func realPath(_ path: String) -> String? {
		guard let resolved = realpath(path, nil) else { return nil }
		defer { free(resolved) }
		return String(cString: resolved)
	}

	/// Does anything — a file, a folder or a link (dangling or not) — sit at `path`?
	static func entryExists(_ path: String) -> Bool {
		var st = stat()
		return lstat(path, &st) == 0
	}

	static func isLink(_ path: String) -> Bool {
		var st = stat()
		return lstat(path, &st) == 0 && (st.st_mode & S_IFMT) == S_IFLNK
	}

	/// Is the real path `real` the root itself or below it (both real)?
	static func isInside(_ real: String, root: String) -> Bool {
		let base = root.hasSuffix("/") ? String(root.dropLast()) : root
		return real == base || real.hasPrefix(base + "/")
	}

	enum Verdict: Equatable {
		/// Something is there, and its real path is inside.
		case inside(String)
		/// Nothing is there, and the nearest thing that is (an ancestor) is
		/// inside: a write may create it.
		case absent
		/// A link leaves the vault, or dangles, or cannot be resolved. The
		/// real path, when there is one.
		case escapes(String?)
	}

	/// Where `path` really leads, against the vault's real root `root`.
	static func check(_ path: String, root: String) -> Verdict {
		if entryExists(path) {
			guard let real = realPath(path) else { return .escapes(nil) }
			return isInside(real, root: root) ? .inside(real) : .escapes(real)
		}
		// Nothing there: what decides is the nearest existing ancestor (a
		// folder link leaving the vault would carry a new file out with it).
		var ancestor = (path as NSString).deletingLastPathComponent
		while !ancestor.isEmpty, ancestor != "/", !entryExists(ancestor) {
			ancestor = (ancestor as NSString).deletingLastPathComponent
		}
		guard let real = realPath(ancestor.isEmpty ? "/" : ancestor) else { return .escapes(nil) }
		return isInside(real, root: root) ? .absent : .escapes(real)
	}
}
