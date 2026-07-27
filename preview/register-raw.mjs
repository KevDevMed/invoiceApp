/**
 * Installs the `?raw` module hooks. Passed to node with `--import` *after*
 * `tsx`, so it sits in front of tsx in the hook chain and claims `.sql?raw`
 * specifiers before tsx's esbuild transform ever sees them.
 */

import { register } from 'node:module';

register('./raw-loader.mjs', import.meta.url);
