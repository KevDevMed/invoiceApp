/**
 * The preview HTTP server.
 *
 * Route table:
 *   GET  /healthz                  liveness, and a real SQLite round trip
 *   POST /api/invoke               the browser's stand-in for Electron IPC
 *   GET  /                         the marketing landing page, preview/landing
 *   GET  /landing/assets/<file>    landing page images (not fingerprinted)
 *   GET  /app, /app/, /app/<any>   the built renderer, preview/dist/index.html
 *   GET  /assets/<file>, …         fingerprinted bundle files from preview/dist
 *   GET  /download[/index.html]    the macOS download page
 *   anything else                  a JSON 404 envelope
 *
 * There is no site-wide SPA fallback: only `/app*` falls back to the renderer's
 * index.html, so an unmatched path is a 404 rather than a page that looks like
 * the app. Renderer routing is hash-based, so `/app` alone is enough for it.
 *
 * The database lives at `PREVIEW_DB_PATH` (default `./preview-data/preview.db`)
 * and is created and migrated on boot. It never goes near the desktop app's own
 * data directory: `src/main/paths.ts` is not imported here, and cannot be — it
 * imports `electron`.
 */

import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { openDatabase, type Db } from '../src/db/client';
import { migrate } from '../src/db/migrate';
import { dispatch, STATUS_FOR_CODE } from './handlers';
import { seedOnBoot } from './seed';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST_DIR = path.resolve(HERE, 'dist');
const DOWNLOAD_PAGE = path.resolve(HERE, 'download/index.html');
const LANDING_PAGE = path.resolve(HERE, 'landing/index.html');
const LANDING_ASSETS_DIR = path.resolve(HERE, 'landing/assets');

/** URL prefix the landing page uses for its own (unfingerprinted) images. */
const LANDING_ASSETS_PREFIX = '/landing/assets/';

/** Requests bigger than this are refused before anything is parsed. */
const MAX_BODY_BYTES = 1_000_000;

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
};

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface PreviewConfig {
  readonly host: string;
  readonly port: number;
  readonly dbPath: string;
  readonly reset: boolean;
}

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): PreviewConfig {
  const port = Number.parseInt(env.PREVIEW_PORT ?? '', 10);
  return {
    host: env.PREVIEW_HOST ?? '0.0.0.0',
    port: Number.isFinite(port) && port > 0 ? port : 4300,
    dbPath: env.PREVIEW_DB_PATH ?? path.resolve(process.cwd(), 'preview-data/preview.db'),
    reset: env.PREVIEW_RESET === '1',
  };
}

/** Open, migrate and seed the preview-only database. */
export function openPreviewDatabase(config: PreviewConfig): Db {
  mkdirSync(path.dirname(config.dbPath), { recursive: true });
  const db = openDatabase(config.dbPath);
  migrate(db);
  const result = seedOnBoot(db, config.reset);
  console.log(
    result.seeded
      ? `[preview] seeded ${result.clients} clients and ${result.invoices} invoices`
      : `[preview] existing data kept: ${result.clients} clients, ${result.invoices} invoices`,
  );
  return db;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Stream a file, or return false if it is not there.
 *
 * `cacheControl` overrides the default policy, which marks anything under an
 * `assets/` directory immutable. That default is right for the fingerprinted
 * Vite bundle and wrong for `preview/landing/assets`, whose filenames are
 * hand-written and get edited in place — those pass 'no-cache' explicitly.
 */
function sendFile(
  res: ServerResponse,
  filePath: string,
  status = 200,
  cacheControl?: string,
): boolean {
  let stats;
  try {
    stats = statSync(filePath);
  } catch {
    return false;
  }
  if (!stats.isFile()) return false;

  const extension = path.extname(filePath).toLowerCase();
  res.writeHead(status, {
    'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
    'content-length': stats.size,
    // Fingerprinted bundle assets are immutable; HTML must not be.
    'cache-control':
      cacheControl ??
      (filePath.includes(`${path.sep}assets${path.sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache'),
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * Map a URL path to a file inside `root`, refusing anything that escapes it.
 * Returns null for a traversal attempt rather than reading the file.
 */
export function resolveStaticPath(root: string, urlPath: string): string | null {
  const decoded = decodeURIComponent(urlPath);
  if (decoded.includes('\0')) return null;
  const candidate = path.resolve(root, `.${path.posix.normalize(decoded)}`);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (candidate !== root && !candidate.startsWith(rootWithSep)) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

export function createPreviewServer(db: Db): ReturnType<typeof createServer> {
  return createServer((req, res) => {
    void handle(db, req, res).catch((error: unknown) => {
      console.error('[preview] unhandled request failure:', error);
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: 'an internal error occurred' } });
      else res.end();
    });
  });
}

async function handle(db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const pathname = url.pathname;

  if (pathname === '/healthz') {
    // Touch the database so the healthcheck fails if SQLite is gone, not just
    // if the event loop is alive.
    db.prepare('SELECT 1').get();
    sendJson(res, 200, { ok: true, status: 'healthy' });
    return;
  }

  if (pathname === '/api/invoke') {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST');
      sendJson(res, 405, {
        ok: false,
        error: { code: 'METHOD_NOT_ALLOWED', message: 'POST /api/invoke' },
      });
      return;
    }
    await handleInvoke(db, req, res);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.setHeader('allow', 'GET, HEAD');
    sendJson(res, 405, {
      ok: false,
      error: { code: 'METHOD_NOT_ALLOWED', message: `${req.method ?? '?'} is not allowed here` },
    });
    return;
  }

  if (pathname === '/download' || pathname === '/download/' || pathname === '/download/index.html') {
    if (sendFile(res, DOWNLOAD_PAGE)) return;
    sendJson(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'download page missing' } });
    return;
  }

  if (pathname === '/') {
    if (sendFile(res, LANDING_PAGE)) return;
    sendJson(res, 404, {
      ok: false,
      error: { code: 'NO_LANDING_PAGE', message: 'preview/landing/index.html is missing' },
    });
    return;
  }

  if (pathname.startsWith(LANDING_ASSETS_PREFIX)) {
    // Same traversal guard the bundle uses — rooted at the landing assets
    // directory, so `%2e%2e%2f` and friends resolve to null rather than a file.
    const assetPath = resolveStaticPath(
      LANDING_ASSETS_DIR,
      pathname.slice(LANDING_ASSETS_PREFIX.length - 1),
    );
    if (assetPath === null) {
      sendJson(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'invalid path' } });
      return;
    }
    if (sendFile(res, assetPath, 200, 'no-cache')) return;
    sendJson(res, 404, {
      ok: false,
      error: { code: 'NOT_FOUND', message: `no such landing asset: ${pathname}` },
    });
    return;
  }

  // The renderer. Its own routing is hash-based, so every `/app/...` deep link
  // resolves to the same document — but only paths under `/app` do. There is
  // deliberately no site-wide fallback: `/nope` is a 404, not the app.
  if (pathname === '/app' || pathname === '/app/' || pathname.startsWith('/app/')) {
    if (sendFile(res, path.join(DIST_DIR, 'index.html'))) return;
    sendJson(res, 404, {
      ok: false,
      error: {
        code: 'NOT_BUILT',
        message: 'The renderer bundle is missing. Run `npm run preview:build` first.',
      },
    });
    return;
  }

  // Fingerprinted bundle files (`/assets/...`) and anything else real that Vite
  // emitted at the dist root — the built index.html references these absolutely.
  const staticPath = resolveStaticPath(DIST_DIR, pathname);
  if (staticPath === null) {
    sendJson(res, 400, { ok: false, error: { code: 'BAD_PATH', message: 'invalid path' } });
    return;
  }
  if (sendFile(res, staticPath)) return;

  sendJson(res, 404, {
    ok: false,
    error: { code: 'NOT_FOUND', message: `no route for ${pathname}` },
  });
}

async function handleInvoke(db: Db, req: IncomingMessage, res: ServerResponse): Promise<void> {
  let raw: string;
  try {
    raw = await readBody(req);
  } catch {
    sendJson(res, 413, {
      ok: false,
      error: { code: 'BODY_TOO_LARGE', message: 'request body too large' },
    });
    return;
  }

  let body: unknown;
  try {
    body = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'BAD_JSON', message: 'request body is not valid JSON' },
    });
    return;
  }

  if (typeof body !== 'object' || body === null) {
    sendJson(res, 400, {
      ok: false,
      error: { code: 'BAD_REQUEST', message: 'expected an object with { channel, payload }' },
    });
    return;
  }

  const { channel, payload } = body as { channel?: unknown; payload?: unknown };
  const result = await dispatch(db, channel, payload);
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  sendJson(res, STATUS_FOR_CODE[result.error.code] ?? 400, result);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export function start(config: PreviewConfig = configFromEnv()): ReturnType<typeof createServer> {
  const db = openPreviewDatabase(config);
  const server = createPreviewServer(db);

  server.listen(config.port, config.host, () => {
    console.log(`[preview] listening on http://${config.host}:${config.port}`);
    console.log(`[preview] database: ${config.dbPath}`);
    if (!existsSync(path.join(DIST_DIR, 'index.html'))) {
      console.warn('[preview] preview/dist/index.html is missing — run `npm run preview:build`.');
    }
  });

  const shutdown = (signal: string): void => {
    console.log(`[preview] ${signal} — shutting down`);
    server.close(() => {
      db.close();
      process.exit(0);
    });
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  return server;
}

// Only auto-start when run directly, so tests can import the pieces above.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(HERE, 'server.ts')) {
  start();
}
