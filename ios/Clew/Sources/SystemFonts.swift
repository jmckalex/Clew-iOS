// The device's font FAMILIES as files, for a figure whose preamble names
// one (`\setmainfont{Optima}`, engine/figure-fonts.js reads which) — the
// iPad twin of Clew-app main/system-fonts.js (the postscript merge, e00dabe).
//
// mp-tikz-wasm's LuaTeX loads only files it is handed, and from 0.4.0
// luaotfload finds every style of a supplied family by name. Desktop indexes
// the font folders and serves the files as they are. iOS keeps its font
// folders out of an app's reach, so the iPad asks CoreText instead: the
// family's faces by name, each written as an sfnt of its own from the tables
// CoreText hands out (NoteFonts.buildFace, one file per face, as dvisvgm
// needs). They are cached in Application Support per iOS version and served
// at __clew_assets__/systemfonts/ in desktop's URL shape:
//   systemfonts/family/<family>.json → { files: [name…] }
//   systemfonts/file/<family>/<n>    → that family's nth file
// A family the device lacks hands over nothing, and its figure says so in
// its own place. Nothing is shipped, and nothing goes into a vault.
import Foundation
import CoreText
import UIKit

final class SystemFonts {
	static let shared = SystemFonts()

	/// Upstream's FAMILY_LIMIT: a family bigger than this hands over nothing.
	static let familyLimit = 64 * 1024 * 1024

	private let lock = NSLock()
	private var built: [String: [URL]] = [:]   // canonical family → its files

	var directory: URL {
		let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
		return support.appendingPathComponent("systemfonts", isDirectory: true)
			.appendingPathComponent(UIDevice.current.systemVersion, isDirectory: true)
	}

	/// Every family the device can draw, as CoreText names them.
	static func availableFamilies() -> [String] {
		(CTFontManagerCopyAvailableFontFamilyNames() as? [String] ?? []).sorted()
	}

	/// The device's own spelling of `family`, matched as desktop's index
	/// matches it (case-insensitive), or nil.
	static func canonical(_ family: String) -> String? {
		let wanted = family.trimmingCharacters(in: .whitespaces).lowercased()
		guard !wanted.isEmpty else { return nil }
		return availableFamilies().first { $0.lowercased() == wanted }
	}

	/// The PostScript names of a family's faces — only faces CoreText files
	/// under that family, never a fallback it would substitute.
	static func faces(of family: String) -> [String] {
		let descriptor = CTFontDescriptorCreateWithAttributes([kCTFontFamilyNameAttribute: family] as CFDictionary)
		let mandatory: Set<CFString> = [kCTFontFamilyNameAttribute]
		guard let matches = CTFontDescriptorCreateMatchingFontDescriptors(descriptor, mandatory as CFSet) as? [CTFontDescriptor] else { return [] }
		var names: [String] = []
		for match in matches {
			guard (CTFontDescriptorCopyAttribute(match, kCTFontFamilyNameAttribute) as? String)?.lowercased() == family.lowercased(),
				let ps = CTFontDescriptorCopyAttribute(match, kCTFontNameAttribute) as? String,
				!names.contains(ps) else { continue }
			names.append(ps)
		}
		return names.sorted()
	}

	/// A family's files, built on first use and reused after; [] when the
	/// device lacks it or it is over the limit. Thread-safe.
	func files(family raw: String) -> [URL] {
		guard let family = Self.canonical(raw) else { return [] }
		lock.lock(); defer { lock.unlock() }
		if let known = built[family] { return known }
		let fm = FileManager.default
		let dir = directory.appendingPathComponent(Self.folderName(family), isDirectory: true)
		try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
		var out: [URL] = []
		var bytes = 0
		for ps in Self.faces(of: family) {
			let safe = ps.replacingOccurrences(of: "/", with: "_")
			let existing = ["ttf", "otf"].map { dir.appendingPathComponent("\(safe).\($0)") }.first { fm.fileExists(atPath: $0.path) }
			if let existing {
				out.append(existing)
				bytes += (try? fm.attributesOfItem(atPath: existing.path)[.size] as? Int) ?? 0
				continue
			}
			guard let data = NoteFonts.buildFace(postScriptName: ps) else { continue }
			let isCFF = data.count >= 4 && data.prefix(4) == Data([0x4F, 0x54, 0x54, 0x4F])
			let url = dir.appendingPathComponent("\(safe).\(isCFF ? "otf" : "ttf")")
			guard (try? data.write(to: url, options: .atomic)) != nil else { continue }
			out.append(url)
			bytes += data.count
			if bytes > Self.familyLimit { break }
		}
		let result = bytes > Self.familyLimit ? [] : out
		built[family] = result
		return result
	}

	/// A folder name for a family: its letters and digits, never a path.
	static func folderName(_ family: String) -> String {
		let kept = family.unicodeScalars.map { CharacterSet.alphanumerics.contains($0) ? Character($0) : "-" }
		return String(kept).isEmpty ? "family" : String(kept)
	}
}
