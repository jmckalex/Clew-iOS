#!/bin/sh
# The Swift unit tests that need no simulator: pure-Foundation policy code
# compiled with its tests for the Mac and run. Defensive tests only — fakes,
# never a real network. `npm run test:swift`.
set -e
root=$(cd "$(dirname "$0")/.." && pwd)
out=$(mktemp -d)
trap 'rm -rf "$out"' EXIT
export DEVELOPER_DIR=${DEVELOPER_DIR:-/Applications/Xcode.app/Contents/Developer}
xcrun swiftc -O -o "$out/remote-pdf-policy" \
	"$root/ios/Clew/Sources/RemotePdfPolicy.swift" \
	"$root/ios/Tests/RemotePdfPolicy/main.swift"
"$out/remote-pdf-policy"
