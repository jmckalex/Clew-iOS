// App bundle entry. Import order is load-bearing: install-shim.js must
// fully evaluate (window.clew installed) before the renderer's module graph
// does — renderer/ipc.js captures window.clew at module scope.
import './install-shim.js';
import '../../vendor/clew/renderer/main.js';
import './ios-ui.js';
import './vault-switcher.js';
