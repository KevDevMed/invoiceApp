/**
 * THE FROZEN IPC CONTRACT.
 *
 * Every renderer -> main call and every main -> renderer event in this app is
 * declared here, with a zod schema for the request and the response. Nothing
 * else crosses the process boundary.
 *
 * Rules for anyone adding a handler:
 *   1. The channel must already exist in `IPC_CONTRACT` below. `registerHandler`
 *      refuses unknown channels, and the preload allow-list refuses to forward
 *      them, so an undeclared channel is unreachable by construction.
 *   2. The request schema declared here is what validates the payload in main.
 *      Handlers receive already-parsed, already-typed data.
 *   3. Response schemas are the compile-time source of truth for the renderer.
 *      They are not re-validated at runtime on the way out.
 */

import { z } from 'zod';

import {
  ChatMessage,
  ChatThread,
  Client,
  ClientInput,
  CurrencyCode,
  Id,
  Invoice,
  InvoiceInput,
  InvoiceStatus,
  InvoiceWithItems,
  IsoDate,
  ModelRecord,
} from './types';

const NoPayload = z.void();

// ---------------------------------------------------------------------------
// Shared request/response fragments
// ---------------------------------------------------------------------------

const Pagination = z.object({
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});

const DateRange = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

const DeleteResult = z.object({ id: Id, deleted: z.boolean() });

const REVENUE_PERIODS = ['day', 'week', 'month', 'quarter', 'year'] as const;
export const RevenuePeriod = z.enum(REVENUE_PERIODS);
export type RevenuePeriod = z.infer<typeof RevenuePeriod>;

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const IPC_CONTRACT = {
  // --- clients (implemented by the domain builder) -------------------------
  'clients:list': {
    request: Pagination.extend({ search: z.string().max(200).optional() }).partial(),
    response: z.object({ items: z.array(Client), total: z.number().int().nonnegative() }),
  },
  'clients:get': {
    request: z.object({ id: Id }),
    response: Client.nullable(),
  },
  'clients:create': {
    request: ClientInput,
    response: Client,
  },
  'clients:update': {
    request: z.object({ id: Id, patch: ClientInput.partial() }),
    response: Client,
  },
  'clients:delete': {
    request: z.object({ id: Id }),
    response: DeleteResult,
  },

  // --- invoices (implemented by the domain builder) ------------------------
  'invoices:list': {
    request: Pagination.extend({
      search: z.string().max(200).optional(),
      status: InvoiceStatus.optional(),
      clientId: Id.optional(),
      issuedBetween: DateRange.optional(),
    }).partial(),
    response: z.object({ items: z.array(Invoice), total: z.number().int().nonnegative() }),
  },
  'invoices:get': {
    request: z.object({ id: Id }),
    response: InvoiceWithItems.nullable(),
  },
  'invoices:create': {
    request: InvoiceInput,
    response: InvoiceWithItems,
  },
  'invoices:update': {
    request: z.object({ id: Id, patch: InvoiceInput.partial() }),
    response: InvoiceWithItems,
  },
  'invoices:delete': {
    request: z.object({ id: Id }),
    response: DeleteResult,
  },
  'invoices:setStatus': {
    request: z.object({ id: Id, status: InvoiceStatus }),
    response: Invoice,
  },
  'invoices:exportPdf': {
    request: z.object({
      id: Id,
      /** Absolute path to write to. When omitted, main shows a save dialog. */
      targetPath: z.string().max(4096).optional(),
    }),
    response: z.object({ path: z.string(), bytes: z.number().int().nonnegative() }),
  },

  // --- reports (implemented by the domain builder) -------------------------
  'reports:summary': {
    request: DateRange.partial(),
    response: z.object({
      currency: CurrencyCode,
      invoiceCount: z.number().int().nonnegative(),
      draftCents: z.number().int(),
      sentCents: z.number().int(),
      paidCents: z.number().int(),
      overdueCents: z.number().int(),
      outstandingCents: z.number().int(),
    }),
  },
  'reports:revenueByPeriod': {
    request: DateRange.extend({ period: RevenuePeriod }).partial({ from: true, to: true }),
    response: z.object({
      currency: CurrencyCode,
      period: RevenuePeriod,
      buckets: z.array(
        z.object({
          /** Bucket start, `YYYY-MM-DD`. */
          bucket: IsoDate,
          invoiceCount: z.number().int().nonnegative(),
          totalCents: z.number().int(),
          paidCents: z.number().int(),
        }),
      ),
    }),
  },
  'reports:byClient': {
    request: DateRange.extend({ limit: z.number().int().min(1).max(500) }).partial(),
    response: z.object({
      currency: CurrencyCode,
      rows: z.array(
        z.object({
          clientId: Id,
          clientName: z.string(),
          invoiceCount: z.number().int().nonnegative(),
          totalCents: z.number().int(),
          paidCents: z.number().int(),
          outstandingCents: z.number().int(),
        }),
      ),
    }),
  },
  'reports:outstanding': {
    request: z.object({ asOf: IsoDate.optional() }).partial(),
    response: z.object({
      currency: CurrencyCode,
      asOf: IsoDate,
      totalOutstandingCents: z.number().int(),
      rows: z.array(
        z.object({
          invoiceId: Id,
          number: z.string(),
          clientId: Id,
          clientName: z.string(),
          dueDate: IsoDate,
          daysOverdue: z.number().int(),
          totalCents: z.number().int(),
        }),
      ),
    }),
  },

  // --- llm (implemented by the LLM builder) --------------------------------
  'llm:catalog': {
    request: z.object({ refresh: z.boolean().optional() }).partial(),
    response: z.object({
      entries: z.array(
        z.object({
          id: Id,
          repo: z.string(),
          filename: z.string(),
          quant: z.string().nullable(),
          sizeBytes: z.number().int().nonnegative().nullable(),
          description: z.string().nullable(),
        }),
      ),
    }),
  },
  'llm:download': {
    request: z.object({
      repo: z.string().min(1).max(200),
      filename: z.string().min(1).max(300),
      quant: z.string().max(32).optional(),
    }),
    response: z.object({ modelId: Id }),
  },
  'llm:cancelDownload': {
    request: z.object({ modelId: Id }),
    response: z.object({ modelId: Id, cancelled: z.boolean() }),
  },
  'llm:removeModel': {
    request: z.object({ modelId: Id }),
    response: DeleteResult,
  },
  'llm:listLocal': {
    request: NoPayload,
    response: z.object({ models: z.array(ModelRecord) }),
  },
  'llm:load': {
    request: z.object({
      modelId: Id,
      contextSize: z.number().int().min(256).max(1_048_576).optional(),
      gpuLayers: z.number().int().min(0).max(1000).optional(),
    }),
    response: z.object({ modelId: Id, loaded: z.boolean(), contextSize: z.number().int() }),
  },
  'llm:unload': {
    request: NoPayload,
    response: z.object({ unloaded: z.boolean() }),
  },
  'llm:chat': {
    request: z.object({
      threadId: Id.optional(),
      /** Correlates streamed `llm:chatToken` events with this request. */
      requestId: Id,
      messages: z.array(
        z.object({
          role: z.enum(['system', 'user', 'assistant', 'tool']),
          content: z.string(),
        }),
      ),
      temperature: z.number().min(0).max(2).optional(),
      maxTokens: z.number().int().min(1).max(131_072).optional(),
    }),
    response: z.object({
      requestId: Id,
      threadId: Id,
      message: ChatMessage,
      thread: ChatThread,
      stopReason: z.enum(['stop', 'length', 'cancelled', 'error']),
    }),
  },
  'llm:cancelChat': {
    request: z.object({ requestId: Id }),
    response: z.object({ requestId: Id, cancelled: z.boolean() }),
  },

  // --- shell-owned handlers (implemented in src/main/ipc/registry.ts) ------
  'settings:get': {
    request: z.object({ key: z.string().min(1).max(200) }),
    response: z.object({ key: z.string(), value: z.string().nullable() }),
  },
  'settings:set': {
    request: z.object({ key: z.string().min(1).max(200), value: z.string().max(100_000) }),
    response: z.object({ key: z.string(), value: z.string() }),
  },
  'app:version': {
    request: NoPayload,
    response: z.object({
      app: z.string(),
      electron: z.string(),
      chrome: z.string(),
      node: z.string(),
      platform: z.string(),
      arch: z.string(),
    }),
  },
} as const satisfies Record<string, { request: z.ZodTypeAny; response: z.ZodTypeAny }>;

export type IpcContract = typeof IPC_CONTRACT;
export type IpcChannel = keyof IpcContract;

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>;
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>;

/** Runtime allow-list of every invokable channel. */
export const INVOKE_CHANNELS = Object.keys(IPC_CONTRACT) as IpcChannel[];

export function isInvokeChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(IPC_CONTRACT, value);
}

/**
 * Channels owned by this piece. Everything else in the contract is a promise to
 * the downstream builders, not an implementation.
 */
export const SHELL_OWNED_CHANNELS = ['settings:get', 'settings:set', 'app:version'] as const;

// ---------------------------------------------------------------------------
// main -> renderer events
// ---------------------------------------------------------------------------

export const IPC_EVENTS = {
  'llm:downloadProgress': z.object({
    modelId: Id,
    receivedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative().nullable(),
    status: z.enum(['downloading', 'ready', 'error', 'cancelled']),
    error: z.string().nullable(),
  }),
  'llm:chatToken': z.object({
    requestId: Id,
    token: z.string(),
    done: z.boolean(),
  }),
} as const satisfies Record<string, z.ZodTypeAny>;

export type IpcEvents = typeof IPC_EVENTS;
export type IpcEventChannel = keyof IpcEvents;
export type IpcEventPayload<C extends IpcEventChannel> = z.infer<IpcEvents[C]>;

/** Runtime allow-list of every subscribable event channel. */
export const EVENT_CHANNELS = Object.keys(IPC_EVENTS) as IpcEventChannel[];

export function isEventChannel(value: unknown): value is IpcEventChannel {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(IPC_EVENTS, value);
}
