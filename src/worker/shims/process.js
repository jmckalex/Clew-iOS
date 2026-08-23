// `node:process` as a module (commander imports it); the injected global in
// globals.js is the same object.
import { process } from './globals.js';
export default process;
