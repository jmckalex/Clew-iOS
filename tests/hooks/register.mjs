// `node --import ./tests/hooks/register.mjs --test`: installs the resolver
// below for every suite, so upstream modules vendored under vendor/clew/
// can reach the engine mirror the way they do in ../Clew-app.
import { register } from 'node:module';

register('./vendor-jmarkdown.mjs', import.meta.url);
