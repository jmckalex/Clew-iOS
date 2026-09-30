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
				// Under the status bar and the home indicator (the page pads
				// itself with env(safe-area-inset-*)), but NOT under the
				// keyboard: when the on-screen keyboard — or iPadOS's minimised
				// keyboard bar, shown instead of it while a hardware keyboard
				// is attached — comes up, the web view shrinks above it and the
				// app re-lays out. Ignoring every safe area (as before) left the
				// web view under the keyboard, and WebKit scrolled the whole
				// fixed page up to make room: the toolbars went under the status
				// bar, out of reach.
				.ignoresSafeArea(.container)
				// What shows beside the minimised keyboard bar, in the space the
				// web view gives up: the web view's own background colour, not
				// the window's white.
				.background(Color(red: 0.08, green: 0.09, blue: 0.11).ignoresSafeArea())
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
