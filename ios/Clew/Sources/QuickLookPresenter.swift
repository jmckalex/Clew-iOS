// The system document viewer, for the file types WebKit can't render well
// inline — above all PDFs, which an <embed> shows as a single static page.
// QuickLook brings the real reader (scrolling, search, thumbnails) plus
// Pencil markup; edits save in place, so annotations land in the vault
// file itself and travel with it (iCloud, git, desktop).
import Foundation
import QuickLook
import UIKit

final class QuickLookPresenter: NSObject, QLPreviewControllerDataSource, QLPreviewControllerDelegate {
	private var url: URL?

	func present(url: URL, from root: UIViewController) {
		self.url = url
		let controller = QLPreviewController()
		controller.dataSource = self
		controller.delegate = self
		root.present(controller, animated: true)
	}

	func numberOfPreviewItems(in controller: QLPreviewController) -> Int {
		url == nil ? 0 : 1
	}

	func previewController(_ controller: QLPreviewController, previewItemAt index: Int) -> QLPreviewItem {
		url! as NSURL
	}

	func previewController(_ controller: QLPreviewController,
		editingModeFor previewItem: QLPreviewItem) -> QLPreviewItemEditingMode {
		.updateContents
	}
}
