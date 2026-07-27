/**
 * Domain entity shapes, defined once as zod schemas and re-exported as types.
 *
 * These mirror `src/db/migrations/001_init.sql` exactly. The schema is frozen —
 * downstream builders write queries against it but never alter it.
 */

import { z } from 'zod';

/** ISO-8601 UTC timestamp, e.g. `2026-07-27T10:15:00.000Z`. */
export const IsoTimestamp = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/,
    'expected an ISO-8601 UTC timestamp',
  );

/** Calendar date with no time component, e.g. `2026-07-27`. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'expected a YYYY-MM-DD date');

/** Opaque row identifier (UUID v4 in practice, but not enforced at the boundary). */
export const Id = z.string().min(1).max(64);

/** ISO-4217 alphabetic currency code. */
export const CurrencyCode = z
  .string()
  .regex(/^[A-Z]{3}$/, 'expected a 3-letter ISO-4217 currency code');

/** Integer cents. Negative values are legal (credits, adjustments). */
export const Cents = z.number().int().safe();

/** Integer milli-units: 1500 === 1.5. */
export const QuantityMilli = z.number().int().safe();

/** Integer basis points: 825 === 8.25%. */
export const Bps = z.number().int().min(0).max(1_000_000);

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'] as const;
export const InvoiceStatus = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof InvoiceStatus>;

export const MODEL_STATUSES = ['available', 'downloading', 'ready', 'error'] as const;
export const ModelStatus = z.enum(MODEL_STATUSES);
export type ModelStatus = z.infer<typeof ModelStatus>;

export const CHAT_ROLES = ['system', 'user', 'assistant', 'tool'] as const;
export const ChatRole = z.enum(CHAT_ROLES);
export type ChatRole = z.infer<typeof ChatRole>;

// ---------------------------------------------------------------------------
// clients
// ---------------------------------------------------------------------------

export const Client = z.object({
  id: Id,
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).nullable(),
  phone: z.string().max(64).nullable(),
  addressLine1: z.string().max(200).nullable(),
  addressLine2: z.string().max(200).nullable(),
  city: z.string().max(120).nullable(),
  region: z.string().max(120).nullable(),
  postalCode: z.string().max(32).nullable(),
  country: z.string().max(120).nullable(),
  taxId: z.string().max(64).nullable(),
  notes: z.string().max(10_000).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Client = z.infer<typeof Client>;

/** Fields a caller may supply when creating a client. */
export const ClientInput = Client.omit({ id: true, createdAt: true, updatedAt: true }).partial({
  email: true,
  phone: true,
  addressLine1: true,
  addressLine2: true,
  city: true,
  region: true,
  postalCode: true,
  country: true,
  taxId: true,
  notes: true,
});
export type ClientInput = z.infer<typeof ClientInput>;

// ---------------------------------------------------------------------------
// invoices
// ---------------------------------------------------------------------------

export const InvoiceItem = z.object({
  id: Id,
  invoiceId: Id,
  position: z.number().int().min(0),
  description: z.string().min(1).max(2000),
  quantityMilli: QuantityMilli,
  unitPriceCents: Cents,
  amountCents: Cents,
});
export type InvoiceItem = z.infer<typeof InvoiceItem>;

export const InvoiceItemInput = InvoiceItem.omit({
  id: true,
  invoiceId: true,
  amountCents: true,
}).partial({ position: true });
export type InvoiceItemInput = z.infer<typeof InvoiceItemInput>;

export const Invoice = z.object({
  id: Id,
  number: z.string().min(1).max(64),
  clientId: Id,
  status: InvoiceStatus,
  issueDate: IsoDate,
  dueDate: IsoDate,
  currency: CurrencyCode,
  taxRateBps: Bps,
  notes: z.string().max(10_000).nullable(),
  subtotalCents: Cents,
  taxCents: Cents,
  totalCents: Cents,
  paidAt: IsoTimestamp.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type Invoice = z.infer<typeof Invoice>;

/** An invoice with its line items and (optionally) its client joined in. */
export const InvoiceWithItems = Invoice.extend({
  items: z.array(InvoiceItem),
  client: Client.nullable(),
});
export type InvoiceWithItems = z.infer<typeof InvoiceWithItems>;

export const InvoiceInput = Invoice.omit({
  id: true,
  subtotalCents: true,
  taxCents: true,
  totalCents: true,
  paidAt: true,
  createdAt: true,
  updatedAt: true,
})
  .partial({ number: true, status: true, currency: true, taxRateBps: true, notes: true })
  .extend({ items: z.array(InvoiceItemInput) });
export type InvoiceInput = z.infer<typeof InvoiceInput>;

// ---------------------------------------------------------------------------
// models (local LLM weights)
// ---------------------------------------------------------------------------

export const ModelRecord = z.object({
  id: Id,
  repo: z.string().min(1).max(200),
  filename: z.string().min(1).max(300),
  quant: z.string().max(32).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  sha256: z.string().max(64).nullable(),
  localPath: z.string().max(4096).nullable(),
  status: ModelStatus,
  downloadedBytes: z.number().int().nonnegative(),
  error: z.string().max(4000).nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type ModelRecord = z.infer<typeof ModelRecord>;

// ---------------------------------------------------------------------------
// chat
// ---------------------------------------------------------------------------

export const ChatThread = z.object({
  id: Id,
  title: z.string().max(200).nullable(),
  modelId: Id.nullable(),
  createdAt: IsoTimestamp,
  updatedAt: IsoTimestamp,
});
export type ChatThread = z.infer<typeof ChatThread>;

export const ChatMessage = z.object({
  id: Id,
  threadId: Id,
  role: ChatRole,
  content: z.string(),
  /** JSON-encoded tool call payload, or null. */
  toolCalls: z.string().nullable(),
  createdAt: IsoTimestamp,
});
export type ChatMessage = z.infer<typeof ChatMessage>;

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------

/**
 * Settings keys owned by the shell. Downstream features may write other keys —
 * the store is an open key/value table — but these are the ones the Settings
 * page and the theme toggle read and write.
 */
export const SETTINGS_KEYS = {
  businessName: 'business.name',
  businessAddress: 'business.address',
  defaultCurrency: 'invoice.defaultCurrency',
  defaultTaxRateBps: 'invoice.defaultTaxRateBps',
  invoiceNumberPrefix: 'invoice.numberPrefix',
  themeMode: 'ui.themeMode',
} as const;

export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

export const THEME_MODES = ['light', 'dark', 'system'] as const;
export const ThemeMode = z.enum(THEME_MODES);
export type ThemeMode = z.infer<typeof ThemeMode>;
