/**
 * The assistant's tool surface.
 *
 * Every tool is a thin, validated shim over a channel in the frozen IPC
 * contract. Nothing here imports another builder's modules — dispatch goes
 * through `invokeChannel`, which is the same code path the renderer takes, with
 * the same zod validation. That means the assistant cannot do anything the user
 * could not do by clicking, and it keeps working (minus the missing tools) if a
 * handler module has not shipped yet.
 *
 * Two rules are load-bearing:
 *   1. Arguments are validated against the tool's own schema before dispatch.
 *      A model hallucinating a field name gets a typed error, not a bad write.
 *   2. Mutating tools do not execute without `isConfirmed`. The model proposes,
 *      the renderer shows an approval card, the user decides. There is no path
 *      through this module that writes without that flag.
 */

import { z } from 'zod';

import { ChannelUnavailableError, hasHandler, invokeChannel } from '../ipc/registry';
import { IPC_CONTRACT, type IpcChannel } from '../../shared/ipc-contract';
import { Id, INVOICE_STATUSES, IsoDate } from '../../shared/types';

export const TOOL_NAMES = [
  'list_clients',
  'create_client',
  'list_invoices',
  'get_invoice',
  'create_invoice',
  'update_invoice_status',
  'get_reports_summary',
  'export_invoice_pdf',
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];

export function isToolName(value: unknown): value is ToolName {
  return typeof value === 'string' && (TOOL_NAMES as readonly string[]).includes(value);
}

export interface ToolDefinition {
  readonly name: ToolName;
  /** The contract channel this tool runs through. */
  readonly channel: IpcChannel;
  /** Mutating tools require explicit user approval. Read-only ones do not. */
  readonly isMutating: boolean;
  readonly description: string;
  /** The schema the model's arguments are checked against. */
  readonly parameters: z.ZodTypeAny;
  /** Map validated tool arguments onto the channel's request payload. */
  readonly toPayload: (args: never) => unknown;
  /** One line describing what approving this call will actually do. */
  readonly summarize: (args: never) => string;
}

// ---------------------------------------------------------------------------
// Argument schemas
// ---------------------------------------------------------------------------

const ListClientsArgs = z.object({
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const CreateClientArgs = z.object({
  name: z.string().min(1).max(200),
  email: z.string().email().max(320).optional(),
  phone: z.string().max(64).optional(),
  addressLine1: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  country: z.string().max(120).optional(),
  notes: z.string().max(2000).optional(),
});

const ListInvoicesArgs = z.object({
  search: z.string().max(200).optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  clientId: Id.optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const GetInvoiceArgs = z.object({ id: Id });

const CreateInvoiceArgs = z.object({
  clientId: Id,
  issueDate: IsoDate,
  dueDate: IsoDate,
  currency: z.string().regex(/^[A-Z]{3}$/).optional(),
  taxRateBps: z.number().int().min(0).max(1_000_000).optional(),
  notes: z.string().max(2000).optional(),
  items: z
    .array(
      z.object({
        description: z.string().min(1).max(2000),
        /** Plain decimal quantity — converted to integer milli-units on the way in. */
        quantity: z.number().min(0).max(1_000_000),
        unitPriceCents: z.number().int().min(-1_000_000_000).max(1_000_000_000),
      }),
    )
    .min(1)
    .max(50),
});

const UpdateInvoiceStatusArgs = z.object({
  id: Id,
  status: z.enum(INVOICE_STATUSES),
});

const ReportsSummaryArgs = z.object({
  from: IsoDate.optional(),
  to: IsoDate.optional(),
});

const ExportInvoicePdfArgs = z.object({
  id: Id,
  targetPath: z.string().max(4096).optional(),
});

// ---------------------------------------------------------------------------
// Definitions
// ---------------------------------------------------------------------------

function define<S extends z.ZodTypeAny>(definition: {
  name: ToolName;
  channel: IpcChannel;
  isMutating: boolean;
  description: string;
  parameters: S;
  toPayload: (args: z.infer<S>) => unknown;
  summarize: (args: z.infer<S>) => string;
}): ToolDefinition {
  return definition as unknown as ToolDefinition;
}

export const TOOLS: readonly ToolDefinition[] = [
  define({
    name: 'list_clients',
    channel: 'clients:list',
    isMutating: false,
    description: 'List saved clients, optionally filtered by a name or email substring.',
    parameters: ListClientsArgs,
    toPayload: (args) => ({ search: args.search, limit: args.limit ?? 25, offset: 0 }),
    summarize: (args) => (args.search ? `List clients matching "${args.search}"` : 'List clients'),
  }),
  define({
    name: 'create_client',
    channel: 'clients:create',
    isMutating: true,
    description: 'Create a new client record.',
    parameters: CreateClientArgs,
    toPayload: (args) => ({ ...args }),
    summarize: (args) => `Create a new client named "${args.name}"${args.email ? ` (${args.email})` : ''}`,
  }),
  define({
    name: 'list_invoices',
    channel: 'invoices:list',
    isMutating: false,
    description: 'List invoices, optionally filtered by status, client, or a text search.',
    parameters: ListInvoicesArgs,
    toPayload: (args) => ({
      search: args.search,
      status: args.status,
      clientId: args.clientId,
      limit: args.limit ?? 25,
      offset: 0,
    }),
    summarize: (args) => `List invoices${args.status ? ` with status ${args.status}` : ''}`,
  }),
  define({
    name: 'get_invoice',
    channel: 'invoices:get',
    isMutating: false,
    description: 'Fetch a single invoice with its line items and client.',
    parameters: GetInvoiceArgs,
    toPayload: (args) => ({ id: args.id }),
    summarize: (args) => `Read invoice ${args.id}`,
  }),
  define({
    name: 'create_invoice',
    channel: 'invoices:create',
    isMutating: true,
    description:
      'Create a draft invoice for a client. Quantities are plain decimals and prices are integer cents.',
    parameters: CreateInvoiceArgs,
    toPayload: (args) => ({
      clientId: args.clientId,
      issueDate: args.issueDate,
      dueDate: args.dueDate,
      currency: args.currency,
      taxRateBps: args.taxRateBps,
      notes: args.notes,
      items: args.items.map((item, index) => ({
        position: index,
        description: item.description,
        // The domain stores quantity as integer milli-units so the totals never
        // touch a float. Rounding here, once, is the whole conversion.
        quantityMilli: Math.round(item.quantity * 1000),
        unitPriceCents: item.unitPriceCents,
      })),
    }),
    summarize: (args) =>
      `Create an invoice for client ${args.clientId} with ${args.items.length} line item(s), due ${args.dueDate}`,
  }),
  define({
    name: 'update_invoice_status',
    channel: 'invoices:setStatus',
    isMutating: true,
    description: 'Change an invoice status to draft, sent, paid, overdue, or void.',
    parameters: UpdateInvoiceStatusArgs,
    toPayload: (args) => ({ id: args.id, status: args.status }),
    summarize: (args) => `Set invoice ${args.id} to "${args.status}"`,
  }),
  define({
    name: 'get_reports_summary',
    channel: 'reports:summary',
    isMutating: false,
    description: 'Totals for draft, sent, paid, overdue, and outstanding invoices over a date range.',
    parameters: ReportsSummaryArgs,
    toPayload: (args) => ({ from: args.from, to: args.to }),
    summarize: () => 'Read the reports summary',
  }),
  define({
    name: 'export_invoice_pdf',
    channel: 'invoices:exportPdf',
    isMutating: true,
    description: 'Render an invoice to a PDF file on disk.',
    parameters: ExportInvoicePdfArgs,
    toPayload: (args) => ({ id: args.id, targetPath: args.targetPath }),
    summarize: (args) =>
      `Export invoice ${args.id} to PDF${args.targetPath ? ` at ${args.targetPath}` : ''} (writes a file)`,
  }),
];

export function findTool(name: string): ToolDefinition | undefined {
  return TOOLS.find((tool) => tool.name === name);
}

// ---------------------------------------------------------------------------
// The model-facing schema
// ---------------------------------------------------------------------------

export interface ToolSpec {
  readonly name: ToolName;
  readonly description: string;
  readonly isMutating: boolean;
  /** JSON Schema for the arguments, as handed to the model. */
  readonly parameters: unknown;
}

/**
 * A minimal zod -> JSON Schema conversion covering exactly the constructs used
 * above. A general converter is a dependency we do not need; anything it cannot
 * describe degrades to an open object rather than a wrong schema.
 */
function toJsonSchema(schema: z.ZodTypeAny): unknown {
  const def = schema._def as { typeName?: string; [key: string]: unknown };

  switch (def.typeName) {
    case 'ZodObject': {
      const shape = (schema as z.ZodObject<z.ZodRawShape>).shape;
      const properties: Record<string, unknown> = {};
      const required: string[] = [];
      for (const [key, value] of Object.entries(shape)) {
        properties[key] = toJsonSchema(value);
        if (!value.isOptional()) required.push(key);
      }
      return { type: 'object', properties, required, additionalProperties: false };
    }
    case 'ZodOptional':
    case 'ZodNullable':
    case 'ZodDefault':
      return toJsonSchema((def.innerType as z.ZodTypeAny) ?? z.unknown());
    case 'ZodArray':
      return { type: 'array', items: toJsonSchema(def.type as z.ZodTypeAny) };
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[] };
    case 'ZodString':
      return { type: 'string' };
    case 'ZodNumber':
      return { type: 'number' };
    case 'ZodBoolean':
      return { type: 'boolean' };
    default:
      return {};
  }
}

/**
 * The tools to advertise to the model right now.
 *
 * Filtered by `hasHandler`, so a model is never offered a tool whose owning
 * module has not registered. Offering it and failing would burn a turn and
 * teach the model nothing.
 */
export function availableTools(): ToolSpec[] {
  return TOOLS.filter((tool) => hasHandler(tool.channel)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    isMutating: tool.isMutating,
    parameters: toJsonSchema(tool.parameters),
  }));
}

export function unavailableToolNames(): ToolName[] {
  return TOOLS.filter((tool) => !hasHandler(tool.channel)).map((tool) => tool.name);
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export interface ToolCall {
  /** Correlates a proposal with the user's approval and the eventual result. */
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ToolErrorCode =
  | 'UNKNOWN_TOOL'
  | 'INVALID_ARGUMENTS'
  | 'TOOL_UNAVAILABLE'
  | 'CONFIRMATION_REQUIRED'
  | 'REJECTED_BY_USER'
  | 'EXECUTION_FAILED';

export type ToolResult =
  | {
      readonly callId: string;
      readonly name: string;
      readonly ok: true;
      readonly result: unknown;
      /** The result as it goes back into the model's context. */
      readonly content: string;
      readonly isTruncated: boolean;
    }
  | {
      readonly callId: string;
      readonly name: string;
      readonly ok: false;
      readonly code: ToolErrorCode;
      readonly message: string;
      readonly content: string;
    };

export interface DispatchOptions {
  /** Set only when the user pressed Approve on this specific call. */
  readonly isConfirmed?: boolean;
  /** Set when the user pressed Reject. Recorded, never executed. */
  readonly isRejected?: boolean;
  /** Roughly how many tokens of tool output may re-enter the context. */
  readonly maxResultTokens?: number;
}

const DEFAULT_RESULT_TOKEN_BUDGET = 400;
/** Deliberately conservative: GGUF tokenizers average well under this. */
const CHARS_PER_TOKEN = 4;

export function truncateForContext(value: string, maxTokens = DEFAULT_RESULT_TOKEN_BUDGET): {
  text: string;
  isTruncated: boolean;
} {
  const limit = Math.max(1, maxTokens) * CHARS_PER_TOKEN;
  if (value.length <= limit) return { text: value, isTruncated: false };
  const suffix = `\n… [truncated ${value.length - limit} characters]`;
  return { text: `${value.slice(0, limit)}${suffix}`, isTruncated: true };
}

function failure(
  call: ToolCall,
  code: ToolErrorCode,
  message: string,
): Extract<ToolResult, { ok: false }> {
  return {
    callId: call.id,
    name: call.name,
    ok: false,
    code,
    message,
    content: JSON.stringify({ error: code, message }),
  };
}

/**
 * Execute one tool call.
 *
 * Never throws: every failure mode is a typed result, because a thrown error in
 * the middle of a generation loop takes the whole assistant down with it.
 */
export async function dispatchToolCall(
  call: ToolCall,
  options: DispatchOptions = {},
): Promise<ToolResult> {
  const tool = findTool(call.name);
  if (!tool) {
    return failure(call, 'UNKNOWN_TOOL', `No such tool: ${call.name}`);
  }

  const parsed = tool.parameters.safeParse(call.arguments);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`)
      .join('; ');
    return failure(call, 'INVALID_ARGUMENTS', `Invalid arguments for ${call.name} — ${detail}`);
  }

  if (options.isRejected) {
    return failure(call, 'REJECTED_BY_USER', `The user rejected the ${call.name} call.`);
  }

  if (tool.isMutating && !options.isConfirmed) {
    return failure(
      call,
      'CONFIRMATION_REQUIRED',
      `${call.name} changes data and needs the user's approval before it runs.`,
    );
  }

  if (!hasHandler(tool.channel)) {
    return failure(
      call,
      'TOOL_UNAVAILABLE',
      `${call.name} is not available in this build (no handler for ${tool.channel}).`,
    );
  }

  try {
    const payload = (tool.toPayload as (args: unknown) => unknown)(parsed.data);
    // `invokeChannel` re-validates against the contract schema, so a payload
    // mapping bug is caught at the boundary rather than reaching a query.
    const result = await invokeChannel(tool.channel as never, payload as never);
    const { text, isTruncated } = truncateForContext(
      JSON.stringify(result) ?? 'null',
      options.maxResultTokens,
    );
    return { callId: call.id, name: call.name, ok: true, result, content: text, isTruncated };
  } catch (error) {
    if (error instanceof ChannelUnavailableError) {
      return failure(
        call,
        'TOOL_UNAVAILABLE',
        `${call.name} is not available in this build (no handler for ${tool.channel}).`,
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    return failure(call, 'EXECUTION_FAILED', `${call.name} failed: ${message}`);
  }
}

/** Human-readable description of a proposed call, for the approval card. */
export function describeToolCall(call: ToolCall): string {
  const tool = findTool(call.name);
  if (!tool) return `Unknown tool: ${call.name}`;
  const parsed = tool.parameters.safeParse(call.arguments);
  if (!parsed.success) return `${call.name} (arguments are not valid)`;
  return (tool.summarize as (args: unknown) => string)(parsed.data);
}

export function isMutatingTool(name: string): boolean {
  return findTool(name)?.isMutating ?? false;
}

/**
 * A system prompt fragment listing the live tools. Kept here rather than in the
 * runtime so the tool list and its description can never drift apart.
 */
export function toolSystemPrompt(): string {
  const specs = availableTools();
  if (specs.length === 0) {
    return 'You have no tools available in this build. Answer from the conversation alone and say so if the user asks you to change data.';
  }

  const lines = specs.map((spec) => {
    const marker = spec.isMutating ? ' [requires user approval]' : '';
    return `- ${spec.name}${marker}: ${spec.description}\n  arguments: ${JSON.stringify(spec.parameters)}`;
  });

  return [
    'You are the assistant inside an offline invoicing app. You can call these tools:',
    ...lines,
    '',
    'To call a tool, emit a single JSON object on its own line:',
    '{"tool_call": {"name": "<tool>", "arguments": { ... }}}',
    'Call one tool at a time and wait for its result. Tools marked [requires user approval] are only executed after the user approves them in the UI; if the user rejects one, do not retry it.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Wire formats
// ---------------------------------------------------------------------------

export interface ToolCallProposal {
  readonly name: string;
  readonly arguments: unknown;
}

/**
 * Pull a `{"tool_call": {...}}` object out of a model's reply.
 *
 * These models emit tool calls as text, sometimes wrapped in a fenced code
 * block and usually with prose around them, so this scans for the first
 * balanced JSON object containing the key rather than trying to parse the whole
 * reply. Returns null when there is nothing that parses.
 */
export function parseToolCallProposal(text: string): ToolCallProposal | null {
  const marker = '"tool_call"';
  let searchFrom = 0;

  for (;;) {
    const markerAt = text.indexOf(marker, searchFrom);
    if (markerAt === -1) return null;
    searchFrom = markerAt + marker.length;

    const start = text.lastIndexOf('{', markerAt);
    if (start === -1) continue;

    const candidate = balancedObjectAt(text, start);
    if (!candidate) continue;

    try {
      const parsed = JSON.parse(candidate) as { tool_call?: { name?: unknown; arguments?: unknown } };
      const call = parsed.tool_call;
      if (call && typeof call.name === 'string') {
        return { name: call.name, arguments: call.arguments ?? {} };
      }
    } catch {
      // Not valid JSON — keep looking further along the reply.
    }
  }
}

function balancedObjectAt(text: string, start: number): string | null {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}

/**
 * The renderer's approve/reject decision, carried on a `tool` role message.
 *
 * The frozen contract has no channel for "the user approved tool call X", and
 * `llm:chat` messages only carry a role and a string. So the decision travels
 * as a JSON body on a `tool` message, which the contract does allow. See the
 * report for the channel this would otherwise want.
 */
export interface ToolDecision {
  readonly callId: string;
  readonly decision: 'approve' | 'reject';
}

export function encodeToolDecision(decision: ToolDecision): string {
  return JSON.stringify({ tool_decision: decision });
}

export function parseToolDecision(content: string): ToolDecision | null {
  try {
    const parsed = JSON.parse(content) as {
      tool_decision?: { callId?: unknown; decision?: unknown };
    };
    const value = parsed.tool_decision;
    if (!value || typeof value.callId !== 'string') return null;
    if (value.decision !== 'approve' && value.decision !== 'reject') return null;
    return { callId: value.callId, decision: value.decision };
  } catch {
    return null;
  }
}

/** Channels the tool layer depends on. Exported for diagnostics and tests. */
export const TOOL_CHANNELS: readonly IpcChannel[] = TOOLS.map((tool) => tool.channel);

/** Guard: every channel a tool targets must exist in the frozen contract. */
for (const channel of TOOL_CHANNELS) {
  if (!(channel in IPC_CONTRACT)) {
    throw new Error(`Tool targets a channel that is not in the contract: ${channel}`);
  }
}
