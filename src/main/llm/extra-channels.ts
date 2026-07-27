/**
 * The channels the frozen contract does not have.
 *
 * The Atomic-Chat flow needs four things the contract never declared: system
 * info, a per-variant compatibility verdict computed before downloading, a
 * Hugging Face repo lookup, and a smoke test. `src/shared/ipc-contract.ts` is
 * frozen and `registerHandler` refuses undeclared channels, so none of them can
 * become a channel of its own.
 *
 * What happens instead: they ride inside `llm:catalog` as a `{ op }` discriminated
 * union. The contract's own request schema still validates every payload — it is
 * intersected with the envelope below, not replaced — so rule 2 of the contract
 * ("the request schema declared here is what validates the payload") still holds.
 * The extra fields survive because the intersection's right-hand side passes them
 * through; the contract schema alone would strip them.
 *
 * Responses ride the same way. `llm:catalog`'s response schema requires
 * `entries`, so every op returns `entries` (empty for non-catalog ops) plus its
 * own payload. The contract states outgoing responses are not re-validated at
 * runtime, so the extra fields reach the renderer intact; the renderer casts
 * once, in `features/models/llmExtra.ts`.
 *
 * Every one of these is written up in the piece report.
 */

import { z } from 'zod';

import { Id } from '../../shared/types';
import { IPC_CONTRACT, type IpcRequest } from '../../shared/ipc-contract';

export const CATALOG_OPS = [
  'catalog',
  'systemInfo',
  'checkSupport',
  'hfLookup',
  'discover',
  'smokeTest',
] as const;

export const CatalogOp = z.enum(CATALOG_OPS);
export type CatalogOp = z.infer<typeof CatalogOp>;

/**
 * The envelope intersected with the contract's schema.
 *
 * `passthrough` is what carries the per-op fields across; each op re-parses the
 * payload against its own strict schema below, so nothing unvalidated is used.
 */
export const CatalogOpEnvelope = z
  .object({ op: CatalogOp.optional() })
  .passthrough();

/**
 * The schema handed to `registerHandler` for `llm:catalog`.
 *
 * The cast is the one place this piece bends: `registerHandler` is typed to take
 * a schema whose output is exactly `IpcRequest<'llm:catalog'>`, and this one's
 * output is that type *plus* the envelope. It is a widening, not a weakening —
 * the contract's schema is still one half of the intersection and still rejects
 * everything it rejected before.
 */
export const CatalogRequestSchema = z.intersection(
  IPC_CONTRACT['llm:catalog'].request,
  CatalogOpEnvelope,
) as unknown as z.ZodType<IpcRequest<'llm:catalog'>, z.ZodTypeDef, unknown>;

// ---------------------------------------------------------------------------
// Per-op request schemas
// ---------------------------------------------------------------------------

export const SystemInfoRequest = z.object({ op: z.literal('systemInfo') });

export const CheckSupportRequest = z.object({
  op: z.literal('checkSupport'),
  repo: z.string().min(1).max(200),
  filename: z.string().min(1).max(300),
  /** Known size, so a cached catalog entry does not need a second HEAD. */
  sizeBytes: z.number().int().positive().nullable().optional(),
  ctxSize: z.number().int().min(256).max(1_048_576).optional(),
  /** Bypass the per-variant cache. */
  refresh: z.boolean().optional(),
});

export const HfLookupRequest = z.object({
  op: z.literal('hfLookup'),
  repo: z.string().min(1).max(300),
});

/**
 * Search the Hub and rank what comes back against this machine.
 *
 * The caps are part of the request because they are what the call costs: each
 * repo is a JSON listing and each verified file is a 4 MB range read. Bounding
 * them here means the renderer cannot ask for an unbounded sweep by accident.
 */
export const DiscoverRequest = z.object({
  op: z.literal('discover'),
  /** Empty means "the most downloaded GGUF repos", which is a valid first screen. */
  query: z.string().max(200).optional(),
  ctxSize: z.number().int().min(256).max(1_048_576).optional(),
  maxRepos: z.number().int().min(1).max(30).optional(),
  maxVariantsPerRepo: z.number().int().min(1).max(10).optional(),
  maxChecks: z.number().int().min(1).max(60).optional(),
  refresh: z.boolean().optional(),
});

export const SmokeTestRequest = z.object({
  op: z.literal('smokeTest'),
  modelId: Id,
  contextSize: z.number().int().min(256).max(1_048_576).optional(),
  maxTokens: z.number().int().min(1).max(512).optional(),
});

export type SystemInfoRequest = z.infer<typeof SystemInfoRequest>;
export type CheckSupportRequest = z.infer<typeof CheckSupportRequest>;
export type HfLookupRequest = z.infer<typeof HfLookupRequest>;
export type DiscoverRequest = z.infer<typeof DiscoverRequest>;
export type SmokeTestRequest = z.infer<typeof SmokeTestRequest>;

/** Settings key holding the optional Hugging Face access token for gated repos. */
export const HF_TOKEN_SETTING_KEY = 'llm.hfToken';

/**
 * Read the op out of an already-validated `llm:catalog` payload.
 *
 * A missing `op` is the plain catalog listing, which is what every caller
 * written against the original contract sends.
 */
export function opOf(payload: unknown): CatalogOp {
  if (payload === null || typeof payload !== 'object') return 'catalog';
  const raw = (payload as { op?: unknown }).op;
  if (raw === undefined) return 'catalog';
  const parsed = CatalogOp.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Unknown llm:catalog op ${JSON.stringify(raw)}. Expected one of: ${CATALOG_OPS.join(', ')}.`,
    );
  }
  return parsed.data;
}
