// Office-document thumbnails for embeds and canvas nodes, from Quick Look.
//
// Desktop renders these by booting LibreOffice-in-wasm offscreen
// (main/office-thumbs.js). iOS asks QLThumbnailGenerator — the system's own
// previewers for Word, Excel and PowerPoint — and caches the PNG exactly
// where desktop caches its own, <vault>/.clew/cache/office-thumbs/<rel>.png,
// reused until the document's mtime moves, so a vault shared over iCloud
// reuses either side's thumbnails. OpenDocument formats have no Quick Look
// previewer; those report the reason and the embed shows its card.
import Foundation
import QuickLookThumbnailing
import UIKit

enum OfficeThumbs {
	static let officeExtensions: Set<String> = ["odt", "ods", "odp", "docx", "xlsx", "pptx"]

	static func thumbRel(_ rel: String) -> String { ".clew/cache/office-thumbs/\(rel).png" }

	/// A PDF's first page (Clew-app docs/dev/pdf-unification.md §2): the same
	/// arrangement at `.clew/cache/pdf-thumbs/<rel>.png` — a mirrored,
	/// vault-relative path, reused until the PDF's mtime moves — from Quick
	/// Look, which renders a PDF's first page natively (desktop renders its
	/// own in an offscreen EmbedPDF; the iPad keeps Pdfium's wasm out of the
	/// one web content process). Capped at 1024 px on the long side.
	static func pdfThumbRel(_ rel: String) -> String { ".clew/cache/pdf-thumbs/\(rel).png" }

	static func pdfThumbnail(rel: String, in vaults: VaultStore, completion: @escaping ([String: Any]) -> Void) {
		guard (rel as NSString).pathExtension.lowercased() == "pdf" else {
			return completion(["ok": false, "reason": "not a PDF: \(rel)"])
		}
		render(rel: rel, outRel: pdfThumbRel(rel), size: CGSize(width: 1024, height: 1024), in: vaults, completion: completion)
	}

	/// Resolves to { ok, path, stamp } or { ok: false, reason } — the shape
	/// main/office-thumbs.js answers CH.OFFICE_THUMBNAIL with. May block
	/// briefly (an evicted iCloud document is fetched first): call off main.
	static func thumbnail(rel: String, in vaults: VaultStore, completion: @escaping ([String: Any]) -> Void) {
		let ext = (rel as NSString).pathExtension.lowercased()
		guard officeExtensions.contains(ext) else {
			return completion(["ok": false, "reason": "not an office document: \(rel)"])
		}
		// Portrait for text documents, landscape for sheets and slides — the
		// same canvas desktop captures.
		let portrait = ext == "odt" || ext == "docx"
		let size = portrait ? CGSize(width: 900, height: 1160) : CGSize(width: 1280, height: 800)
		render(rel: rel, outRel: thumbRel(rel), size: size, in: vaults, completion: completion)
	}

	/// Quick Look's thumbnail of `rel` at `outRel`, reused while it is newer
	/// than the document.
	private static func render(rel: String, outRel: String, size: CGSize, in vaults: VaultStore,
		completion: @escaping ([String: Any]) -> Void) {
		guard let doc = vaults.materialize(rel: rel, timeout: 15) else {
			return completion(["ok": false, "reason": "missing document"])
		}
		guard let out = try? vaults.resolve(outRel) else {
			return completion(["ok": false, "reason": "bad path"])
		}
		let fm = FileManager.default
		if let cached = try? fm.attributesOfItem(atPath: out.path),
			let cachedDate = cached[.modificationDate] as? Date,
			let bytes = cached[.size] as? NSNumber, bytes.intValue > 0,
			cachedDate.timeIntervalSince1970 >= mtime(doc) {
			return completion(["ok": true, "path": outRel, "stamp": stamp(cachedDate)])
		}
		let request = QLThumbnailGenerator.Request(fileAt: doc, size: size, scale: 1, representationTypes: .thumbnail)
		QLThumbnailGenerator.shared.generateBestRepresentation(for: request) { representation, error in
			guard let representation, let png = representation.uiImage.pngData() else {
				return completion(["ok": false,
					"reason": error?.localizedDescription ?? "Quick Look cannot render this document"])
			}
			do {
				try fm.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
				try AtomicFile.write(png, to: out)
				completion(["ok": true, "path": outRel, "stamp": stamp(Date(timeIntervalSince1970: mtime(out)))])
			} catch {
				completion(["ok": false, "reason": error.localizedDescription])
			}
		}
	}

	private static func mtime(_ url: URL) -> TimeInterval {
		let date = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
		return date?.timeIntervalSince1970 ?? 0
	}

	private static func stamp(_ date: Date) -> Int { Int((date.timeIntervalSince1970 * 1000).rounded()) }
}
