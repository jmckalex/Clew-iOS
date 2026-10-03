// Quick capture from the Home Screen (FEATURE-IDEAS #9): press and hold
// the app icon for Scan Document, New Note or Today's Diary Entry
// (Info.plist's UIApplicationShortcutItems).
//
// The action waits here until the page takes it (the `takeQuickAction`
// bridge call): on a cold launch the page asks once its vault is open,
// and on a warm one it is nudged to ask. Taking clears it, so it runs once.
import UIKit

final class QuickActions {
	static let shared = QuickActions()
	private var pending: String?
	/// Set by WebHost: nudges a page that is already up to take the action.
	var nudge: (() -> Void)?

	/// "org.jmckalex.clew.ios.scan" → "scan".
	func handle(_ type: String) {
		pending = type.components(separatedBy: ".").last
		nudge?()
	}

	func take() -> String? {
		defer { pending = nil }
		return pending
	}
}

final class AppDelegate: NSObject, UIApplicationDelegate {
	func application(_ application: UIApplication, configurationForConnecting session: UISceneSession,
		options: UIScene.ConnectionOptions) -> UISceneConfiguration {
		// A cold launch from a quick action arrives here, not in the scene.
		if let item = options.shortcutItem { QuickActions.shared.handle(item.type) }
		let configuration = UISceneConfiguration(name: nil, sessionRole: session.role)
		configuration.delegateClass = QuickActionSceneDelegate.self
		return configuration
	}
}

/// SwiftUI keeps the window; this only hears the quick actions chosen while
/// the app is already running.
final class QuickActionSceneDelegate: NSObject, UIWindowSceneDelegate {
	func windowScene(_ windowScene: UIWindowScene, performActionFor shortcutItem: UIApplicationShortcutItem,
		completionHandler: @escaping (Bool) -> Void) {
		QuickActions.shared.handle(shortcutItem.type)
		completionHandler(true)
	}
}
