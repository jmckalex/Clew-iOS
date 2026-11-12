# Material Icon Theme's file icons — DO NOT EDIT

The file explorer's icons (components/panels/clew-file-explorer.js,
lib/file-icons.js). Written by `node scripts/vendor-file-icons.js` from the
owner's copy of Material Icon Theme 5.35.0 (MIT, see LICENSE here; Material
Extensions, https://github.com/material-extensions/vscode-material-icon-theme),
vendored in jmacs. Only the icons a FILE can be given are here, with the
generic folder and open folder and every `_light` variant of those; the
theme's per-name folder icons are not. Which name gets which icon is
src/renderer/lib/file-icons-data.js, written by the same script. Change the
script and re-run it; never edit this folder by hand.

scripts/build.js copies this folder to dist/renderer/file-icons/.
