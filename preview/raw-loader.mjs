/**
 * Node module hooks that teach plain Node about Vite's `?raw` import suffix.
 *
 * `src/db/migrate.ts` imports its migration SQL as `./migrations/001_init.sql?raw`
 * so the statements are bundled into the packaged main process. That is a Vite
 * feature; under `tsx` the specifier is just an unknown extension and the import
 * throws. Rather than fork the migration runner — the preview must run the *real*
 * migrations — these hooks resolve `*?raw` to the file and hand back a module
 * whose default export is its text, which is exactly what Vite does.
 *
 * Registered by `preview/register-raw.mjs`, which the preview scripts pass to
 * node via `--import`.
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAW_SUFFIX = '?raw';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith(RAW_SUFFIX)) {
    const bare = specifier.slice(0, -RAW_SUFFIX.length);
    const parentDir = context.parentURL
      ? path.dirname(fileURLToPath(context.parentURL))
      : process.cwd();
    const absolute = path.resolve(parentDir, bare);
    return {
      url: `${pathToFileURL(absolute).href}${RAW_SUFFIX}`,
      format: 'module',
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (url.endsWith(RAW_SUFFIX)) {
    const filePath = fileURLToPath(url.slice(0, -RAW_SUFFIX.length));
    const source = await readFile(filePath, 'utf8');
    return {
      format: 'module',
      shortCircuit: true,
      source: `export default ${JSON.stringify(source)};`,
    };
  }
  return nextLoad(url, context);
}
