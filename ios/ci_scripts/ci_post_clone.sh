#!/bin/sh
# Xcode Cloud hook: runs after checkout, before xcodebuild. The app's
# "Stage WebRoot and SeedVault" build phase needs dist/webroot to exist,
# so build the web layer (engine worker, app bundle, preview clients)
# here. Vendor mirrors are committed, so no upstream checkout is needed —
# sync-upstream no-ops without ../Clew-app.
set -e
export HOMEBREW_NO_AUTO_UPDATE=1
brew install node
cd "$CI_PRIMARY_REPOSITORY_PATH"
node --version
npm ci
# The wasm TikZ/MetaPost engines (74 MB) are never committed: fetched from
# the SHA256-pinned release named in vendor/clew/shared/mptikz-manifest.json.
# --require: fail here rather than ship an app whose figures cannot render.
node scripts/stage-mptikz.js --require
npm run build
