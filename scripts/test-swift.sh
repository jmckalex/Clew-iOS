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
run atomic-file "$root/ios/Clew/Sources/AtomicFile.swift" "$root/ios/Tests/AtomicFile/main.swift"
