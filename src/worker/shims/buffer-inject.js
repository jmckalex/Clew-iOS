// esbuild `inject` for the APP bundle (and the services test bundle): the
// free identifier `Buffer` in vendored main-process modules resolves to the
// shim — nothing else. The worker gets its Buffer from globals.js, which
// also installs process/global; the app page must not have those.
import { BufferShim } from './buffer.js';
export { BufferShim as Buffer };
