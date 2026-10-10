// The identity of the bundled TeX engines and the app, so a changed build is
// never served stale — the iOS twin of Clew-app main/asset-stamp.js.
//
// SchemeHandler serves __clew_assets__/mptikz/ as `public, max-age=31536000,
// immutable`: a pinned, read-only build whose wasm WebKit may only code-cache
// if it is allowed to store it, and whose bundle files a figure re-reads by
// the dozen. The engines' URLs (gs.wasm among them) carry no version, so an
// update that ships new engines at the same URLs could be answered from the
// cache for a year (desktop measured exactly that, 2026-09-17). The stamp is
// the app's version and build plus the staged tree's STAGED.json (the
// release and archive pins stage-mptikz.js writes). When it differs from the
// one recorded at the last launch, WebKit's caches are cleared before the
// page loads. A first launch, or one from a build without a record, clears
// once, which costs nothing that is not fetched anyway.
import Foundation
import WebKit

enum AssetStamp {
	static let key = "assetStamp"

	static func current(bundle: Bundle = .main) -> String {
		let info = bundle.infoDictionary ?? [:]
		let version = "\(info["CFBundleShortVersionString"] ?? "")(\(info["CFBundleVersion"] ?? ""))"
		let staged = bundle.url(forResource: "WebRoot", withExtension: nil)?
			.appendingPathComponent("preview-assets/mptikz/STAGED.json")
		let engines = staged.flatMap { try? Data(contentsOf: $0) }.map { String(decoding: $0, as: UTF8.self) } ?? "-"
		return "\(version)|\(engines)"
	}

	/// Clear WebKit's caches when the stamp changed, then `then` (on main).
	static func clearIfChanged(_ defaults: UserDefaults = .standard, then: @escaping () -> Void) {
		let stamp = current()
		guard defaults.string(forKey: key) != stamp else { return then() }
		let types: Set<String> = [WKWebsiteDataTypeDiskCache, WKWebsiteDataTypeMemoryCache, WKWebsiteDataTypeFetchCache]
		WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) {
			defaults.set(stamp, forKey: key)
			NSLog("clew: asset cache cleared: the bundled TeX engines or the app changed")
			then()
		}
	}
}
