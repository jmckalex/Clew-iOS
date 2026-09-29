// Clew for iOS — SwiftUI shell around the web app.
//
// The entire UI is the ported Clew renderer running in one WKWebView,
// served over clew-app:// from the bundled WebRoot. Swift provides what
// Electron's main process provided natively: the filesystem bridge
// (FSBridge), the preview protocol (SchemeHandler), and lifecycle glue.
import SwiftUI

@main
struct ClewApp: App {
	@Environment(\.scenePhase) private var scenePhase
	@StateObject private var host = WebHost()

	var body: some Scene {
		WindowGroup {
			WebContainerView(host: host)
				.ignoresSafeArea()
				.statusBarHidden(false)
		}
		.onChange(of: scenePhase) { _, phase in
			switch phase {
			case .inactive:
				// The web side flushes editors on visibilitychange too; this
				// covers the case where scripts are already paused.
				host.flushEditors()
			case .background:
				// …and on the way to suspension, a background task holds the
				// app awake until the saves in flight have landed.
				host.flushForSuspension()
			case .active:
				// External changes (Files app, iCloud) surface on foreground.
				host.rescanVault()
			@unknown default:
				break
			}
		}
	}
}
