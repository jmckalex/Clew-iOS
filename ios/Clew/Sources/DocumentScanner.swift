// Scan into a note (FEATURE-IDEAS #9): VisionKit's document camera, the
// pages made into ONE PDF for the vault's attachment folder, and Vision's
// text recognition. The recognised lines go into the PDF as an invisible
// text layer, so a scan is searchable and selectable in Clew's PDF viewer
// like any born-digital PDF, and the text comes back for the note.
import UIKit
import VisionKit
import Vision
import CoreText

/// Presents the document camera and hands back the scanned pages: nil when
/// the user cancelled.
final class DocumentScanner: NSObject, VNDocumentCameraViewControllerDelegate {
	private var completion: ((Result<[UIImage]?, Error>) -> Void)?

	static var isSupported: Bool { VNDocumentCameraViewController.isSupported }

	func present(from controller: UIViewController, completion: @escaping (Result<[UIImage]?, Error>) -> Void) {
		// A second scan while one is open cancels the first cleanly.
		self.completion?(.success(nil))
		self.completion = completion
		let camera = VNDocumentCameraViewController()
		camera.delegate = self
		controller.present(camera, animated: true)
	}

	private func finish(_ controller: VNDocumentCameraViewController, _ result: Result<[UIImage]?, Error>) {
		let done = completion
		completion = nil
		controller.dismiss(animated: true) { done?(result) }
	}

	func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFinishWith scan: VNDocumentCameraScan) {
		finish(controller, .success((0..<scan.pageCount).map { scan.imageOfPage(at: $0) }))
	}

	func documentCameraViewControllerDidCancel(_ controller: VNDocumentCameraViewController) {
		finish(controller, .success(nil))
	}

	func documentCameraViewController(_ controller: VNDocumentCameraViewController, didFailWithError error: Error) {
		finish(controller, .failure(error))
	}
}

enum ScanPDF {
	/// One recognised line: its text and its box, normalised with the origin
	/// at the bottom left (Vision's convention).
	struct Line {
		let text: String
		let box: CGRect
	}

	/// The longest side a page image keeps: about 250 dpi on a letter page,
	/// plenty for reading and OCR, and a few hundred KB a page as JPEG.
	static let maxPixels: CGFloat = 2200
	/// PDF page width in points (US Letter's); the height follows the scan.
	static let pageWidth: CGFloat = 612

	/// Text recognition on one page. Never throws: a page Vision can't read
	/// is a page without a text layer, not a failed scan.
	static func recognize(_ image: UIImage) -> [Line] {
		guard let cgImage = image.cgImage else { return [] }
		let request = VNRecognizeTextRequest()
		request.recognitionLevel = .accurate
		request.usesLanguageCorrection = true
		request.automaticallyDetectsLanguage = true
		let handler = VNImageRequestHandler(cgImage: cgImage, orientation: cgOrientation(image.imageOrientation))
		do { try handler.perform([request]) } catch {
			NSLog("clew: text recognition failed: %@", error.localizedDescription)
			return []
		}
		return (request.results ?? []).compactMap { observation in
			guard let best = observation.topCandidates(1).first else { return nil }
			return Line(text: best.string, box: observation.boundingBox)
		}
	}

	/// The page's lines top to bottom, as the note's text.
	static func text(of lines: [Line]) -> String {
		lines.sorted { $0.box.maxY > $1.box.maxY }.map(\.text).joined(separator: "\n")
	}

	/// The pages as one PDF: each image fitted to the page, with its lines
	/// drawn invisibly over the words they came from.
	static func pdf(pages: [(image: UIImage, lines: [Line])]) -> Data {
		let renderer = UIGraphicsPDFRenderer(bounds: CGRect(x: 0, y: 0, width: pageWidth, height: pageWidth * 11 / 8.5))
		return renderer.pdfData { context in
			for page in pages {
				let image = downscaled(page.image)
				let height = (pageWidth * image.size.height / max(image.size.width, 1)).rounded()
				let bounds = CGRect(x: 0, y: 0, width: pageWidth, height: height)
				context.beginPage(withBounds: bounds, pageInfo: [:])
				image.draw(in: bounds)
				drawInvisible(page.lines, in: bounds, context: context.cgContext)
			}
		}
	}

	/// Re-encoded as JPEG at a bounded size, so the PDF embeds compressed
	/// image data rather than the camera's full-resolution bitmap.
	private static func downscaled(_ image: UIImage) -> UIImage {
		let longest = max(image.size.width * image.scale, image.size.height * image.scale)
		let factor = min(1, maxPixels / max(longest, 1))
		let size = CGSize(width: (image.size.width * image.scale * factor).rounded(),
			height: (image.size.height * image.scale * factor).rounded())
		let format = UIGraphicsImageRendererFormat()
		format.scale = 1
		let resized = UIGraphicsImageRenderer(size: size, format: format).image { _ in
			image.draw(in: CGRect(origin: .zero, size: size))
		}
		guard let jpeg = resized.jpegData(compressionQuality: 0.72), let decoded = UIImage(data: jpeg) else { return resized }
		return decoded
	}

	/// Each line in text-rendering mode "invisible", stretched to its box:
	/// selectable and searchable, never seen.
	private static func drawInvisible(_ lines: [Line], in bounds: CGRect, context cg: CGContext) {
		for line in lines where !line.text.isEmpty {
			let rect = CGRect(
				x: bounds.minX + line.box.minX * bounds.width,
				y: bounds.minY + (1 - line.box.maxY) * bounds.height,
				width: line.box.width * bounds.width,
				height: line.box.height * bounds.height)
			guard rect.width > 1, rect.height > 1 else { continue }
			let font = CTFontCreateWithName("Helvetica" as CFString, rect.height * 0.8, nil)
			// No ligatures: an "fi" glyph would extract as one odd character,
			// and search for "find" would miss it.
			let attributed = NSAttributedString(string: line.text, attributes: [
				NSAttributedString.Key(kCTFontAttributeName as String): font,
				NSAttributedString.Key(kCTLigatureAttributeName as String): 0,
			])
			let ctLine = CTLineCreateWithAttributedString(attributed)
			let natural = CGFloat(CTLineGetTypographicBounds(ctLine, nil, nil, nil))
			guard natural > 0 else { continue }
			cg.saveGState()
			// UIKit's PDF context is flipped (origin top left); text wants
			// y up. The baseline sits a fifth of the box above its bottom.
			cg.translateBy(x: rect.minX, y: rect.maxY - rect.height * 0.2)
			cg.scaleBy(x: rect.width / natural, y: -1)
			cg.textMatrix = .identity
			cg.textPosition = .zero
			cg.setTextDrawingMode(.invisible)
			CTLineDraw(ctLine, cg)
			cg.restoreGState()
		}
	}

	private static func cgOrientation(_ orientation: UIImage.Orientation) -> CGImagePropertyOrientation {
		switch orientation {
		case .up: return .up
		case .down: return .down
		case .left: return .left
		case .right: return .right
		case .upMirrored: return .upMirrored
		case .downMirrored: return .downMirrored
		case .leftMirrored: return .leftMirrored
		case .rightMirrored: return .rightMirrored
		@unknown default: return .up
		}
	}

	#if DEBUG
	/// The simulator has no camera: with `ClewScanFixture` set, a scan
	/// "captures" these pages instead, drawn like a photographed letter
	/// page, so the OCR, the PDF and the note insertion run for real.
	static func fixturePages(_ spec: String) -> [UIImage] {
		let pages = spec.components(separatedBy: "\n---\n")
		return pages.map { body in
			let size = CGSize(width: 1275, height: 1650)
			let format = UIGraphicsImageRendererFormat()
			format.scale = 1
			return UIGraphicsImageRenderer(size: size, format: format).image { ctx in
				UIColor(white: 0.96, alpha: 1).setFill()
				ctx.fill(CGRect(origin: .zero, size: size))
				let style = NSMutableParagraphStyle()
				style.lineSpacing = 18
				(body as NSString).draw(
					in: CGRect(x: 120, y: 140, width: size.width - 240, height: size.height - 280),
					withAttributes: [
						.font: UIFont(name: "Georgia", size: 40) ?? UIFont.systemFont(ofSize: 40),
						.foregroundColor: UIColor(white: 0.1, alpha: 1),
						.paragraphStyle: style,
					])
			}
		}
	}
	#endif
}
