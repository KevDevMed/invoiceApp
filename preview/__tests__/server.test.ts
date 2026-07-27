/**
 * Behaviour of `POST /api/invoke`, exercised over a real HTTP server rather
 * than by calling `dispatch` directly — the browser only ever sees the HTTP
 * surface, so that is what these assert.
 */

import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { openDatabase, type Db } from '../../src/db/client';
import { migrate } from '../../src/db/migrate';
import { IPC_CONTRACT } from '../../src/shared/ipc-contract';
import { DESKTOP_ONLY_CHANNELS, REAL_CHANNELS } from '../handlers';
import { createPreviewServer } from '../server';

const DIST_INDEX = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../dist/index.html',
);

/** Stand-in for the built renderer, carrying the mount point the real one has. */
const SPA_MARKER_DOCUMENT =
  '<!doctype html><html><body><div id="root" class="app-root"></div></body></html>\n';

let db: Db;
let server: Server;
let origin: string;

beforeAll(async () => {
  db = openDatabase(':memory:');
  migrate(db);
  server = createPreviewServer(db);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  db.close();
});

interface Envelope {
  ok: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

async function invoke(
  channel: unknown,
  payload?: unknown,
): Promise<{ status: number; body: Envelope }> {
  const response = await fetch(`${origin}/api/invoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ channel, payload }),
  });
  return { status: response.status, body: (await response.json()) as Envelope };
}

/**
 * Send a request line verbatim, with no URL parsing in between. `fetch` cannot
 * do this: it normalises `../` and `%2e` away before the bytes leave the process.
 */
function rawGet(rawPath: string): Promise<string> {
  const { port } = server.address() as AddressInfo;
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n`);
    });
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    socket.on('error', reject);
  });
}

describe('channel allow-list', () => {
  it('rejects a channel that is not in the contract', async () => {
    const { status, body } = await invoke('clients:drop', {});

    expect(status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('UNKNOWN_CHANNEL');
    expect(body.error?.message).toContain('clients:drop');
  });

  it('rejects a channel that only looks like a real one', async () => {
    for (const channel of ['', 'toString', '__proto__', 'settings:getAll', null, 42]) {
      const { body } = await invoke(channel, {});
      expect(body.error?.code, `channel ${String(channel)}`).toBe('UNKNOWN_CHANNEL');
    }
  });
});

describe('payload validation', () => {
  it("rejects a malformed payload with the contract's own zod message", async () => {
    const bad = { name: '', email: 'not-an-email' };
    const { status, body } = await invoke('clients:create', bad);

    expect(status).toBe(400);
    expect(body.error?.code).toBe('INVALID_PAYLOAD');

    // The decisive assertion: the message the server produced is built from the
    // issues the contract's own schema produces for this payload. Nothing here
    // hand-rolls a second validation path.
    const parsed = IPC_CONTRACT['clients:create'].request.safeParse(bad);
    expect(parsed.success).toBe(false);
    if (parsed.success) throw new Error('unreachable');
    for (const issue of parsed.error.issues) {
      expect(body.error?.message).toContain(`${issue.path.join('.')}: ${issue.message}`);
    }
  });

  it('rejects a payload of the wrong type entirely', async () => {
    const { body } = await invoke('settings:get', 'not-an-object');
    expect(body.error?.code).toBe('INVALID_PAYLOAD');
  });

  it('accepts the void-payload channels with no payload at all', async () => {
    const { status, body } = await invoke('app:version');
    expect(status).toBe(200);
    expect(body.ok).toBe(true);
    expect((body.data as { app: string }).app).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe('desktop-only channels', () => {
  it('refuses invoices:exportPdf instead of returning a fake path', async () => {
    const { status, body } = await invoke('invoices:exportPdf', {
      id: 'whatever',
      targetPath: '/tmp/x.pdf',
    });

    expect(status).toBe(501);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('DESKTOP_ONLY');
    expect(body.error?.message).toMatch(/printToPDF/);
    expect(body.data).toBeUndefined();
  });

  it('refuses llm:listLocal instead of returning a fake model list', async () => {
    const { status, body } = await invoke('llm:listLocal');

    expect(status).toBe(501);
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('DESKTOP_ONLY');
    expect(body.error?.message).toMatch(/llama\.cpp/);
    expect(body.data).toBeUndefined();
  });

  it('refuses every llm:* channel in the contract', async () => {
    const llmChannels = Object.keys(IPC_CONTRACT).filter((channel) => channel.startsWith('llm:'));
    expect(llmChannels.length).toBeGreaterThan(0);

    for (const channel of llmChannels) {
      const { body } = await invoke(channel, {});
      expect(body.error?.code, channel).toBe('DESKTOP_ONLY');
    }
  });

  it('covers every contract channel exactly once, as real or desktop-only', () => {
    const all = Object.keys(IPC_CONTRACT).sort();
    const covered = [...REAL_CHANNELS, ...DESKTOP_ONLY_CHANNELS.keys()].sort();
    expect(covered).toEqual(all);
  });
});

describe('a real round trip through the domain repositories', () => {
  it('creates a client and an invoice and persists exact cent values', async () => {
    const created = await invoke('clients:create', {
      name: 'Roundtrip Ltd',
      email: 'ap@roundtrip.example',
      addressLine1: '1 Test Way',
      city: 'Bristol',
      country: 'United Kingdom',
    });
    expect(created.status).toBe(200);
    const client = created.body.data as { id: string; name: string };
    expect(client.name).toBe('Roundtrip Ltd');

    const invoiceResponse = await invoke('invoices:create', {
      clientId: client.id,
      status: 'sent',
      issueDate: '2026-03-02',
      dueDate: '2026-04-01',
      currency: 'USD',
      taxRateBps: 825,
      items: [
        // 1.5 x 19.99 = 29.985 -> 2999 cents, half-up.
        { description: 'Fractional hours at an awkward price', quantityMilli: 1500, unitPriceCents: 1999 },
        // 3.25 x 125.00 = 406.25 -> exact.
        { description: 'Consulting', quantityMilli: 3250, unitPriceCents: 12500 },
        // 1 x 87.50 -> exact.
        { description: 'Licence', quantityMilli: 1000, unitPriceCents: 8750 },
      ],
    });
    expect(invoiceResponse.status).toBe(200);

    const invoice = invoiceResponse.body.data as {
      id: string;
      subtotalCents: number;
      taxCents: number;
      totalCents: number;
      items: Array<{ description: string; amountCents: number }>;
    };

    expect(invoice.items.map((item) => item.amountCents)).toEqual([2999, 40625, 8750]);
    expect(invoice.subtotalCents).toBe(52374);
    // 52374 * 825 / 10000 = 4320.855 -> 4321, half-up.
    expect(invoice.taxCents).toBe(4321);
    expect(invoice.totalCents).toBe(56695);

    // Read it back over the wire: the persisted row, not the in-memory result.
    const fetched = await invoke('invoices:get', { id: invoice.id });
    const stored = fetched.body.data as typeof invoice;
    expect(stored.subtotalCents).toBe(52374);
    expect(stored.taxCents).toBe(4321);
    expect(stored.totalCents).toBe(56695);
    expect(stored.items.map((item) => item.amountCents)).toEqual([2999, 40625, 8750]);

    // And straight out of SQLite, so nothing in the response path can flatter it.
    const row = db
      .prepare<[string], { subtotal_cents: number; tax_cents: number; total_cents: number }>(
        'SELECT subtotal_cents, tax_cents, total_cents FROM invoices WHERE id = ?',
      )
      .get(invoice.id);
    expect(row).toEqual({ subtotal_cents: 52374, tax_cents: 4321, total_cents: 56695 });
  });

  it('surfaces a domain error with its code rather than a stack trace', async () => {
    const { body } = await invoke('invoices:get', { id: 'does-not-exist' });
    expect(body.ok).toBe(true);
    expect(body.data).toBeNull();

    const missing = await invoke('invoices:setStatus', { id: 'does-not-exist', status: 'paid' });
    expect(missing.body.ok).toBe(false);
    expect(missing.body.error?.message).not.toMatch(/SELECT|INSERT|node_modules/);
  });
});

describe('other routes', () => {
  it('answers /healthz', async () => {
    const response = await fetch(`${origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, status: 'healthy' });
  });

  it('serves the download page at /download', async () => {
    const response = await fetch(`${origin}/download`);
    expect(response.status).toBe(200);
    const html = await response.text();
    // The primary Gatekeeper route: System Settings > Privacy & Security > Open
    // Anyway. The build is signed but not notarised, so this is the path that
    // actually works — the old right-click advice must not come back as step one.
    expect(html).toContain('Privacy &amp; Security');
    expect(html).toContain('Open Anyway');
    // The Terminal fallback stays, as a fallback.
    expect(html).toContain('xattr -dr com.apple.quarantine /Applications/InvoiceApp.app');
    // Recovery path for the unsigned v0.1.0 build, which those steps cannot fix.
    expect(html).toContain('v0.1.0');
    expect(html).toContain('https://github.com/KevDevMed/invoiceApp/releases/latest');
  });

  it('refuses GET on /api/invoke', async () => {
    const response = await fetch(`${origin}/api/invoke`);
    expect(response.status).toBe(405);
  });

  it('never serves a file from outside the bundle directory', async () => {
    // Whether the bundle has been built or not, this must never return the
    // repository's package.json.
    const response = await fetch(`${origin}/%2e%2e%2f%2e%2e%2fpackage.json`);
    expect(await response.text()).not.toContain('"better-sqlite3"');
    expect(response.status).not.toBe(500);
  });
});

describe('the page routes: landing at /, renderer at /app', () => {
  // `/app` must serve the built renderer, and the assertion has to be the same
  // one whether or not `npm run preview:build` has run in this checkout. So if
  // the bundle is absent, stand a minimal index.html in its place for the
  // duration of this block and take it away again afterwards. The marker below
  // is in preview/index.html, so a real build satisfies it too.
  let fixtureWritten = false;

  beforeAll(() => {
    if (existsSync(DIST_INDEX)) return;
    mkdirSync(path.dirname(DIST_INDEX), { recursive: true });
    writeFileSync(DIST_INDEX, SPA_MARKER_DOCUMENT, 'utf8');
    fixtureWritten = true;
  });

  afterAll(() => {
    if (fixtureWritten) rmSync(DIST_INDEX, { force: true });
  });

  it('serves the landing page at /', async () => {
    const response = await fetch(`${origin}/`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('Invoicing that never');
    expect(html).toContain('<title>InvoiceApp — offline-first invoicing for macOS</title>');
    // The landing page is not the app.
    expect(html).not.toContain('id="root"');
  });

  it('serves the renderer document at /app', async () => {
    const response = await fetch(`${origin}/app`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(await response.text()).toContain('id="root"');
  });

  it('serves the same renderer document for an /app deep link', async () => {
    const shallow = await fetch(`${origin}/app`);
    const deep = await fetch(`${origin}/app/some/deep/link`);

    expect(deep.status).toBe(shallow.status);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toBe(await shallow.text());
  });

  it('still serves the download page at /download', async () => {
    const response = await fetch(`${origin}/download`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/html; charset=utf-8');
    const html = await response.text();
    expect(html).toContain('Open Anyway');
    expect(html).toContain('xattr -dr com.apple.quarantine /Applications/InvoiceApp.app');
  });

  it('serves the landing page image, and does not mark it immutable', async () => {
    const response = await fetch(`${origin}/landing/assets/invoices-hero.png`);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // Hand-written filename, edited in place — caching it forever would strand
    // every visitor on the old picture.
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect((await response.arrayBuffer()).byteLength).toBeGreaterThan(0);
  });

  it('refuses a plain ../ escape from the landing assets directory', async () => {
    const response = await fetch(`${origin}/landing/assets/../../../etc/passwd`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const text = await response.text();
    expect(text).not.toContain('root:x:');
    const body = JSON.parse(text) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  it('refuses a percent-encoded escape from the landing assets directory', async () => {
    const response = await fetch(`${origin}/landing/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd`);

    expect(response.status).toBe(404);
    const text = await response.text();
    expect(text).not.toContain('root:x:');
    expect((JSON.parse(text) as Envelope).error?.code).toBe('NOT_FOUND');
  });

  it('refuses an escape that never passes through a URL parser at all', async () => {
    // Both cases above are normalised by the client before they hit the wire —
    // WHATWG URL parsing collapses `../` and treats `%2e` as a dot. So neither
    // actually reaches `resolveStaticPath` with the traversal intact. This one
    // is written straight to the socket so it does, which is the only version
    // that exercises the guard itself.
    for (const rawPath of [
      '/landing/assets/../../../etc/passwd',
      '/landing/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fetc/passwd',
      '/landing/assets/..%2f..%2f..%2fetc%2fpasswd',
    ]) {
      const raw = await rawGet(rawPath);

      expect(raw, rawPath).not.toContain('root:x:');
      // `resolveStaticPath` clamps the traversal against the assets root rather
      // than escaping it, so the file is simply not there.
      expect(raw.split('\r\n')[0], rawPath).toBe('HTTP/1.1 404 Not Found');
      expect(raw, rawPath).toContain('"code":"NOT_FOUND"');
    }
  });

  it('400s an undecodable landing-asset path instead of throwing a 500', async () => {
    for (const rawPath of ['/landing/assets/%', '/landing/assets/%zz', '/landing/assets/%E0%A4']) {
      const raw = await rawGet(rawPath);

      // The decisive part: `decodeURIComponent` throws URIError on all three, and
      // that must land on the existing BAD_PATH branch, not the 500 catch-all.
      expect(raw.split('\r\n')[0], rawPath).toBe('HTTP/1.1 400 Bad Request');
      expect(raw.split('\r\n')[0], rawPath).not.toContain('500');
      expect(raw, rawPath).toContain('application/json; charset=utf-8');

      const body = JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')) as Envelope;
      expect(body.ok, rawPath).toBe(false);
      expect(body.error?.code, rawPath).toBe('BAD_PATH');
      expect(body.error?.message, rawPath).toBe('invalid path');
    }
  });

  it('400s an undecodable path on the dist static branch too', async () => {
    // No `/landing/assets/` prefix, no `/app` prefix — this one falls through to
    // the second `resolveStaticPath` call site, rooted at preview/dist.
    for (const rawPath of ['/%', '/%zz', '/assets/%E0%A4']) {
      const raw = await rawGet(rawPath);

      expect(raw.split('\r\n')[0], rawPath).toBe('HTTP/1.1 400 Bad Request');
      expect(raw.split('\r\n')[0], rawPath).not.toContain('500');

      const body = JSON.parse(raw.split('\r\n\r\n').slice(1).join('\r\n\r\n')) as Envelope;
      expect(body.ok, rawPath).toBe(false);
      expect(body.error?.code, rawPath).toBe('BAD_PATH');
    }
  });

  it('404s an unmatched path instead of falling back to the renderer', async () => {
    const response = await fetch(`${origin}/nope`);

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/json; charset=utf-8');
    const text = await response.text();
    // The decisive part: not the app, and not the landing page either.
    expect(text).not.toContain('id="root"');
    expect(text).not.toContain('Invoicing that never');
    const body = JSON.parse(text) as Envelope;
    expect(body.ok).toBe(false);
    expect(body.error?.code).toBe('NOT_FOUND');
  });

  it('refuses a non-GET method on a static route with an allow header', async () => {
    const response = await fetch(`${origin}/`, { method: 'POST' });

    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET, HEAD');
    const body = (await response.json()) as Envelope;
    expect(body.error?.code).toBe('METHOD_NOT_ALLOWED');
  });
});
