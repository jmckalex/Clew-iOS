// The note's own typeface, as font FILES the wasm TeX can load.
//
// `font=note` figures (vendor/clew/engine/figures.js) set their text in the
// face the note is read in — Avenir Next — by naming NoteFont-Regular.ttf,
// -Bold, -Italic and -BoldItalic in the figure's preamble; the preview
// client fetches those files from __clew_assets__/notefonts/ and hands them
// to the engine. The desktop (main/note-fonts.js) slices the four faces out
// of /System/Library/Fonts/Avenir Next.ttc. The iPad does it the other way
// round: it never reads Apple's font file, it asks CoreText for each face's
// tables and writes an sfnt of its own — the same 12-byte header, sorted
// 16-byte directory, 4-byte-aligned tables and recomputed
// head.checkSumAdjustment the desktop writes, so a strict reader (and
// dvisvgm, which subsets the face into the SVG) sees one ordinary TrueType
// file per face. One file per face is mandatory: dvisvgm keys embedded
// faces by file path, and a collection comes out garbled.
//
// The files are cached in Application Support, keyed on the iOS version
// (the system face changes with it, if ever). Nothing is shipped in the
// app: Apple's face is read from the device it is on.
import Foundation
import CoreText
import UIKit

final class NoteFonts {
	static let shared = NoteFonts()

	/// Face → CoreText PostScript name. The keys are the face names the
	/// engine and the preview client agree on (figures.js#noteFontFaces).
	static let faces: [(face: String, postScriptName: String)] = [
		("Regular", "AvenirNext-Regular"),
		("Bold", "AvenirNext-Bold"),
		("Italic", "AvenirNext-Italic"),
		("BoldItalic", "AvenirNext-BoldItalic"),
	]
	static let family = "Avenir Next"

	struct Prepared {
		let dir: URL
		let family: String
		/// face → file name, only the faces that could be built.
		let faces: [String: String]
	}

	private let lock = NSLock()
	private var prepared: Prepared?

	var directory: URL {
		let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
		return support.appendingPathComponent("notefonts", isDirectory: true)
			.appendingPathComponent(UIDevice.current.systemVersion, isDirectory: true)
	}

	/// The four files, built on first use and reused after. Thread-safe;
	/// both the bridge (for the engine's face map) and the scheme handler
	/// (serving the files) come through here.
	func ensure() -> Prepared {
		lock.lock(); defer { lock.unlock() }
		if let prepared { return prepared }
		let dir = directory
		let fm = FileManager.default
		try? fm.createDirectory(at: dir, withIntermediateDirectories: true)
		var faces: [String: String] = [:]
		for (face, psName) in Self.faces {
			let name = "NoteFont-\(face).ttf"
			let url = dir.appendingPathComponent(name)
			if fm.fileExists(atPath: url.path) { faces[face] = name; continue }
			guard let data = Self.buildFace(postScriptName: psName) else { continue }
			// The extension follows the outlines: 'OTTO' is CFF, anything else TrueType.
			let isCFF = data.count >= 4 && data.prefix(4) == Data([0x4F, 0x54, 0x54, 0x4F])
			let fileName = isCFF ? "NoteFont-\(face).otf" : name
			if (try? data.write(to: dir.appendingPathComponent(fileName), options: .atomic)) != nil {
				faces[face] = fileName
			}
		}
		// The index the preview client reads (only `faces` matters to it).
		let index: [String: Any] = ["family": Self.family, "source": "CoreText", "faces": faces]
		if let json = try? JSONSerialization.data(withJSONObject: index, options: [.prettyPrinted, .sortedKeys]) {
			try? json.write(to: dir.appendingPathComponent("index.json"), options: .atomic)
		}
		let result = Prepared(dir: dir, family: Self.family, faces: faces)
		prepared = result
		return result
	}

	/// The file for a request under notefonts/, or nil.
	func file(named name: String) -> URL? {
		let p = ensure()
		guard !name.contains("/"), !name.contains("..") else { return nil }
		if name == "index.json" { return p.dir.appendingPathComponent(name) }
		return p.faces.values.contains(name) ? p.dir.appendingPathComponent(name) : nil
	}

	// MARK: - sfnt from CoreText tables

	/// One face as a standalone font file, from the tables CoreText hands
	/// out. Returns nil when the name resolves to a fallback face (CoreText
	/// substitutes rather than failing) or the tables cannot be read.
	static func buildFace(postScriptName: String) -> Data? {
		let font = CTFontCreateWithName(postScriptName as CFString, 12, nil)
		guard (CTFontCopyPostScriptName(font) as String) == postScriptName else { return nil }
		guard let tags = CTFontCopyAvailableTables(font, []) else { return nil }
		var tables: [(tag: UInt32, data: Data)] = []
		for i in 0..<CFArrayGetCount(tags) {
			// The array holds the tags themselves, not objects.
			let tag = UInt32(UInt(bitPattern: CFArrayGetValueAtIndex(tags, i)))
			guard let cf = CTFontCopyTable(font, CTFontTableTag(tag), []) else { continue }
			tables.append((tag, cf as Data))
		}
		guard tables.contains(where: { $0.tag == fourCC("head") }),
			tables.contains(where: { $0.tag == fourCC("glyf") || $0.tag == fourCC("CFF ") }) else { return nil }
		// Directory entries sorted by tag, as the format requires of a reader
		// that binary-searches them.
		tables.sort { $0.tag < $1.tag }
		return assemble(tables: tables)
	}

	/// Header + directory + tables, 4-byte aligned, per-table checksums
	/// computed over the padded bytes, head.checkSumAdjustment recomputed
	/// so the whole file sums to 0xB1B0AFBA — extractFace's arithmetic.
	static func assemble(tables: [(tag: UInt32, data: Data)]) -> Data {
		let n = tables.count
		let headerSize = 12 + 16 * n
		let align = { (x: Int) -> Int in (x + 3) & ~3 }
		var offsets: [Int] = []
		var total = headerSize
		for t in tables { offsets.append(total); total = align(total + t.data.count) }
		var out = Data(count: total)
		let isCFF = tables.contains { $0.tag == fourCC("CFF ") }
		out.putU32(isCFF ? 0x4F54544F : 0x00010000, at: 0)
		out.putU16(UInt16(n), at: 4)
		var power = 1, selector = 0
		while power * 2 <= n { power *= 2; selector += 1 }
		out.putU16(UInt16(power * 16), at: 6)
		out.putU16(UInt16(selector), at: 8)
		out.putU16(UInt16(n * 16 - power * 16), at: 10)
		for (i, t) in tables.enumerated() {
			out.replaceSubrange(offsets[i]..<(offsets[i] + t.data.count), with: t.data)
		}
		var headAt: Int? = nil
		for (i, t) in tables.enumerated() {
			let at = 12 + 16 * i
			if t.tag == fourCC("head") { headAt = offsets[i]; out.putU32(0, at: offsets[i] + 8) }
			out.putU32(t.tag, at: at)
			out.putU32(checksum(out, from: offsets[i], length: t.data.count), at: at + 4)
			out.putU32(UInt32(offsets[i]), at: at + 8)
			out.putU32(UInt32(t.data.count), at: at + 12)
		}
		if let headAt {
			let sum = checksum(out, from: 0, length: out.count)
			out.putU32(0xB1B0AFBA &- sum, at: headAt + 8)
		}
		return out
	}

	/// Sum of big-endian 32-bit words over [from, from+length), zero-padded to
	/// a multiple of four — the sfnt checksum.
	static func checksum(_ d: Data, from: Int, length: Int) -> UInt32 {
		var sum: UInt32 = 0
		var i = from
		let end = from + length
		while i < end {
			var word: UInt32 = 0
			for k in 0..<4 {
				let b: UInt32 = (i + k < end) ? UInt32(d[i + k]) : 0
				word = (word << 8) | b
			}
			sum = sum &+ word
			i += 4
		}
		return sum
	}

	static func fourCC(_ s: String) -> UInt32 {
		s.utf8.reduce(0) { ($0 << 8) | UInt32($1) }
	}
}

private extension Data {
	mutating func putU32(_ v: UInt32, at: Int) {
		self[at] = UInt8(v >> 24); self[at + 1] = UInt8((v >> 16) & 0xFF)
		self[at + 2] = UInt8((v >> 8) & 0xFF); self[at + 3] = UInt8(v & 0xFF)
	}
	mutating func putU16(_ v: UInt16, at: Int) {
		self[at] = UInt8(v >> 8); self[at + 1] = UInt8(v & 0xFF)
	}
}
