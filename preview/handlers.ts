/**
 * Channel dispatch for the browser preview.
 *
 * This is the preview's answer to `src/main/ipc/registry.ts`. It deliberately
 * mirrors that file's rules rather than inventing its own:
 *
 *   1. A channel that is not in `IPC_CONTRACT` is unreachable.
 *   2. Every payload is validated with `IPC_CONTRACT[channel].request` — the
 *      contract's own zod schema, the same object the Electron registry hands to
 *      `registerHandler`. There is no second validation path.
 *   3. Handlers call the same `src/domain/**` repositories the Electron handlers
 *      call, with a `Db` passed in. That is the whole reason a preview is
 *      possible without forking the app.
 *
 * Two groups of channels cannot work in a browser and are not faked:
 * `invoices:exportPdf` needs Electron's `printToPDF`, and every `llm:*` channel
 * needs the desktop app's native llama.cpp runtime. Both return a typed
 * `DESKTOP_ONLY` error. A preview that pretends to run a local model would be
 * worse than one that says plainly that it cannot.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { Db } from '../src/db/client';
import {
  createClient,
  deleteClient,
  getClient,
  listClients,
  updateClient,
} from '../src/domain/clients/repository';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
} from '../src/domain/invoices/repository';
import { byClient, outstanding, revenueByPeriod, summary } from '../src/domain/reports/queries';
import { IPC_CONTRACT, isInvokeChannel, type IpcChannel } from '../src/shared/ipc-contract';

export interface PreviewErrorBody {
  readonly code: string;
  readonly message: string;
}

export type PreviewResult =
  | { readonly ok: true; readonly data: unknown }
  | { readonly ok: false; readonly error: PreviewErrorBody };

/** HTTP status to send alongside each error code. */
export const STATUS_FOR_CODE: Readonly<Record<string, number>> = {
  UNKNOWN_CHANNEL: 400,
  INVALID_PAYLOAD: 400,
  DESKTOP_ONLY: 501,
  INTERNAL: 500,
};

// ---------------------------------------------------------------------------
// Desktop-only channels
// ---------------------------------------------------------------------------

const PDF_DESKTOP_MESSAGE =
  'PDF export is desktop-only. It renders through Electron’s printToPDF, which has no browser equivalent. ' +
  'Download the macOS app to export invoices.';

const LLM_DESKTOP_MESSAGE =
  'Local models are desktop-only. They run on the app’s native llama.cpp runtime, on your own machine. ' +
  'The browser preview cannot download or run a model. Download the macOS app to use the assistant.';

/**
 * Channels the preview refuses, with the reason the UI shows the user.
 * Derived from the contract so a new `llm:*` channel is covered automatically.
 */
export const DESKTOP_ONLY_CHANNELS: ReadonlyMap<IpcChannel, string> = new Map<IpcChannel, string>([
  ['invoices:exportPdf', PDF_DESKTOP_MESSAGE],
  ...(Object.keys(IPC_CONTRACT) as IpcChannel[])
    .filter((channel) => channel.startsWith('llm:'))
    .map((channel) => [channel, LLM_DESKTOP_MESSAGE] as [IpcChannel, string]),
]);

export function isDesktopOnly(channel: IpcChannel): boolean {
  return DESKTOP_ONLY_CHANNELS.has(channel);
}

// ---------------------------------------------------------------------------
// Real handlers
// ---------------------------------------------------------------------------

function readSetting(db: Db, key: string): string | null {
  const row = db
    .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
    .get(key);
  return row?.value ?? null;
}

function writeSetting(db: Db, key: string, value: string): void {
  db.prepare<[string, string]>(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

function appVersion(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const raw = readFileSync(path.resolve(here, '../package.json'), 'utf8');
  return (JSON.parse(raw) as { version?: string }).version ?? '0.0.0';
}

/**
 * `payload` is already parsed by the channel's contract schema, so each handler
 * receives exactly what the Electron handler for the same channel receives.
 */
type PreviewHandler = (db: Db, payload: never) => unknown;

const HANDLERS: Partial<Record<IpcChannel, PreviewHandler>> = {
  'settings:get': (db, { key }: { key: string }) => ({ key, value: readSetting(db, key) }),
  'settings:set': (db, { key, value }: { key: string; value: string }) => {
    writeSetting(db, key, value);
    return { key, value };
  },
  'app:version': () => ({
    app: appVersion(),
    // Honest about what is running: this is Node behind a browser, not Electron.
    electron: 'n/a (browser preview)',
    chrome: 'n/a (browser preview)',
    node: process.versions.node,
    platform: `${process.platform} (preview server)`,
    arch: process.arch,
  }),

  'clients:list': (db, payload: Parameters<typeof listClients>[1]) => listClients(db, payload),
  'clients:get': (db, { id }: { id: string }) => getClient(db, id),
  'clients:create': (db, payload: Parameters<typeof createClient>[1]) => createClient(db, payload),
  'clients:update': (db, { id, patch }: { id: string; patch: Parameters<typeof updateClient>[2] }) =>
    updateClient(db, id, patch),
  'clients:delete': (db, { id }: { id: string }) => deleteClient(db, id),

  'invoices:list': (db, payload: Parameters<typeof listInvoices>[1]) => listInvoices(db, payload),
  'invoices:get': (db, { id }: { id: string }) => getInvoice(db, id),
  'invoices:create': (db, payload: Parameters<typeof createInvoice>[1]) => createInvoice(db, payload),
  'invoices:update': (
    db,
    { id, patch }: { id: string; patch: Parameters<typeof updateInvoice>[2] },
  ) => updateInvoice(db, id, patch),
  'invoices:delete': (db, { id }: { id: string }) => deleteInvoice(db, id),
  'invoices:setStatus': (
    db,
    { id, status }: { id: string; status: Parameters<typeof setInvoiceStatus>[2] },
  ) => setInvoiceStatus(db, id, status),

  'reports:summary': (db, payload: { from?: string; to?: string } | undefined) =>
    summary(db, payload ?? {}),
  'reports:revenueByPeriod': (
    db,
    { period, from, to }: { period: Parameters<typeof revenueByPeriod>[1]; from?: string; to?: string },
  ) => revenueByPeriod(db, period, { from, to }),
  'reports:byClient': (db, payload: { from?: string; to?: string; limit?: number } | undefined) =>
    byClient(db, { from: payload?.from, to: payload?.to }, payload?.limit ?? 50),
  'reports:outstanding': (db, payload: { asOf?: string } | undefined) =>
    outstanding(db, payload?.asOf),
};

/** Channels this preview answers for real. Everything else is DESKTOP_ONLY. */
export const REAL_CHANNELS: readonly IpcChannel[] = Object.keys(HANDLERS) as IpcChannel[];

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

/**
 * Same policy as `describeForRenderer` in the Electron registry: a domain error
 * carries a `code` and a message written for a user, so it passes through.
 * Anything else may quote SQL or a file path, so the browser gets a generic
 * string and the detail stays in the server log.
 */
function describe(error: unknown): PreviewErrorBody {
  if (
    error instanceof Error &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
  ) {
    return { code: (error as { code: string }).code, message: error.message };
  }
  return { code: 'INTERNAL', message: 'an internal error occurred' };
}

export async function dispatch(db: Db, channel: unknown, payload: unknown): Promise<PreviewResult> {
  if (!isInvokeChannel(channel)) {
    return {
      ok: false,
      error: {
        code: 'UNKNOWN_CHANNEL',
        message: `Blocked invoke on undeclared channel: ${String(channel)}`,
      },
    };
  }

  const desktopOnly = DESKTOP_ONLY_CHANNELS.get(channel);
  if (desktopOnly !== undefined) {
    return { ok: false, error: { code: 'DESKTOP_ONLY', message: desktopOnly } };
  }

  // The contract's own schema, exactly as `registerHandler` uses it.
  const parsed = IPC_CONTRACT[channel].request.safeParse(payload);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return {
      ok: false,
      error: { code: 'INVALID_PAYLOAD', message: `Invalid payload for ${channel} — ${detail}` },
    };
  }

  const handler = HANDLERS[channel];
  if (!handler) {
    // Unreachable: every contract channel is either handled or desktop-only.
    return {
      ok: false,
      error: { code: 'DESKTOP_ONLY', message: `${channel} is not available in the preview.` },
    };
  }

  try {
    const data = await (handler as (db: Db, payload: unknown) => unknown)(db, parsed.data);
    return { ok: true, data };
  } catch (error) {
    console.error(`[preview] ${channel} failed:`, error);
    const described = describe(error);
    return {
      ok: false,
      error: { code: described.code, message: `${channel} failed: ${described.message}` },
    };
  }
}
