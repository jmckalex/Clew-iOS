#!/bin/sh
# The Swift unit tests that need no simulator: pure-Foundation code compiled
# with its tests for the Mac and run. Defensive tests only — fakes and temp
# directories, never a real network. `npm run test:swift`.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
run() {
	name=$1; shift
	xcrun swiftc -O -o "$out/$name" "$@"
	"$out/$name"
}
run remote-pdf-policy "$root/ios/Clew/Sources/RemotePdfPolicy.swift" "$root/ios/Tests/RemotePdfPolicy/main.swift"
run vault-trust "$root/ios/Clew/Sources/VaultTrust.swift" "$root/ios/Tests/VaultTrust/main.swift"
run vault-paths "$root/ios/Clew/Sources/VaultPaths.swift" "$root/ios/Tests/VaultPaths/main.swift"
run atomic-file "$root/ios/Clew/Sources/AtomicFile.swift" "$root/ios/Tests/AtomicFile/main.swift"
DEMO_BUNDLE="$root/seed-vault" DEMO_HISTORY="$root/vendor/clew/main/demo-history.json" \
	run demo-sync "$root/ios/Clew/Sources/DemoSync.swift" "$root/ios/Clew/Sources/VaultPaths.swift" "$root/ios/Clew/Sources/AtomicFile.swift" "$root/ios/Tests/DemoSync/main.swift"
run app-secrets "$root/ios/Clew/Sources/AppSecrets.swift" "$root/ios/Tests/AppSecrets/main.swift"
