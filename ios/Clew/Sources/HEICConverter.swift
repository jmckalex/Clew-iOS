// HEIC → JPEG for pasted/imported photos (the iOS equivalent of desktop's
// sips conversion — WebKit cannot display HEIC in previews, and EXIF GPS
// must survive for photo maps).
import Foundation
import ImageIO
import UniformTypeIdentifiers

enum HEICConverter {
	static func jpegData(from heic: Data) -> Data? {
		guard let source = CGImageSourceCreateWithData(heic as CFData, nil) else { return nil }
		let out = NSMutableData()
		guard let dest = CGImageDestinationCreateWithData(
			out, UTType.jpeg.identifier as CFString, 1, nil) else { return nil }
		// Copying the source properties through keeps EXIF (incl. GPS).
		let options: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.9]
		CGImageDestinationAddImageFromSource(dest, source, 0, options as CFDictionary)
		guard CGImageDestinationFinalize(dest) else { return nil }
		return out as Data
	}
}
