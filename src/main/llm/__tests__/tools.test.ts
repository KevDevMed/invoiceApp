import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The tool dispatcher is tested against a fake registry, not the real one.
 *
 * The clients/invoices/reports handlers belong to the other builder and may not
 * exist at all while this runs — mocking the registry module is what makes this
 * suite independent of that, and it is also the only way to assert the
 * `TOOL_UNAVAILABLE` path deterministically.
 */

class FakeChannelUnavailableError extends Error {
  readonly code = 'CHANNEL_UNAVAILABLE';
  constructor(readonly channel: string) {
    super(`No handler registered for IPC channel: ${channel}`);
    this.name = 'ChannelUnavailableError';
  }
}

const registered = new Set<string>();
const invocations: { channel: string; payload: unknown }[] = [];
let invokeResult: unknown = { ok: true };
let invokeError: Error | null = null;

vi.mock('../../ipc/registry', () => ({
  ChannelUnavailableError: FakeChannelUnavailableError,
  hasHandler: (channel: string) => registered.has(channel),
  invokeChannel: async (channel: string, payload: unknown) => {
    invocations.push({ channel, payload });
    if (!registered.has(channel)) throw new FakeChannelUnavailableError(channel);
    if (invokeError) throw invokeError;
    return invokeResult;
  },
}));

const {
  availableTools,
  describeToolCall,
  dispatchToolCall,
  encodeToolDecision,
  isMutatingTool,
  parseToolCallProposal,
  parseToolDecision,
  TOOL_NAMES,
  toolSystemPrompt,
  truncateForContext,
  unavailableToolNames,
} = await import('../tools');

const ALL_CHANNELS = [
  'clients:list',
  'clients:create',
  'invoices:list',
  'invoices:get',
  'invoices:create',
  'invoices:setStatus',
  'reports:summary',
  'invoices:exportPdf',
];

function registerAll(): void {
  for (const channel of ALL_CHANNELS) registered.add(channel);
}

beforeEach(() => {
  registered.clear();
  invocations.length = 0;
  invokeResult = { ok: true };
  invokeError = null;
});

describe('tool advertisement', () => {
  it('advertises nothing when no handler has registered', () => {
    expect(availableTools()).toHaveLength(0);
    expect(unavailableToolNames()).toEqual([...TOOL_NAMES]);
  });

  it('advertises only the tools whose channel is live', () => {
    registered.add('clients:list');
    registered.add('reports:summary');

    expect(availableTools().map((tool) => tool.name).sort()).toEqual([
      'get_reports_summary',
      'list_clients',
    ]);
    expect(unavailableToolNames()).not.toContain('list_clients');
  });

  it('emits a JSON Schema for each advertised tool', () => {
    registerAll();
    const createClient = availableTools().find((tool) => tool.name === 'create_client');
    expect(createClient?.isMutating).toBe(true);
    expect(createClient?.parameters).toMatchObject({
      type: 'object',
      required: ['name'],
      properties: { name: { type: 'string' }, email: { type: 'string' } },
    });
  });

  it('tells the model there are no tools when none are live', () => {
    expect(toolSystemPrompt()).toContain('no tools available');
  });

  it('lists the live tools and flags the ones needing approval', () => {
    registerAll();
    const prompt = toolSystemPrompt();
    expect(prompt).toContain('list_clients');
    expect(prompt).toContain('create_invoice [requires user approval]');
    expect(prompt).not.toContain('list_clients [requires user approval]');
  });
});

describe('validation', () => {
  it('rejects an unknown tool name', async () => {
    registerAll();
    const result = await dispatchToolCall({ id: 'c1', name: 'drop_database', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('UNKNOWN_TOOL');
    expect(invocations).toHaveLength(0);
  });

  it('rejects a malformed tool call before it can reach a handler', async () => {
    registerAll();
    const result = await dispatchToolCall({
      id: 'c2',
      name: 'update_invoice_status',
      arguments: { id: 'inv-1', status: 'exploded' },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ARGUMENTS');
    expect(result.message).toContain('status');
    expect(invocations).toHaveLength(0);
  });

  it('rejects missing required arguments', async () => {
    registerAll();
    const result = await dispatchToolCall({ id: 'c3', name: 'get_invoice', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('INVALID_ARGUMENTS');
  });
});

describe('confirmation', () => {
  it.each(['create_client', 'create_invoice', 'update_invoice_status', 'export_invoice_pdf'])(
    'blocks %s without explicit confirmation',
    async (name) => {
      registerAll();
      expect(isMutatingTool(name)).toBe(true);

      const result = await dispatchToolCall({
        id: 'c4',
        name,
        arguments: validArgumentsFor(name),
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.code).toBe('CONFIRMATION_REQUIRED');
      expect(invocations).toHaveLength(0);
    },
  );

  it('runs a mutating tool once the user has approved it', async () => {
    registerAll();
    invokeResult = { id: 'client-1', name: 'Acme' };

    const result = await dispatchToolCall(
      { id: 'c5', name: 'create_client', arguments: { name: 'Acme' } },
      { isConfirmed: true },
    );

    expect(result.ok).toBe(true);
    expect(invocations).toEqual([{ channel: 'clients:create', payload: { name: 'Acme' } }]);
  });

  it('records a rejection without executing anything', async () => {
    registerAll();
    const result = await dispatchToolCall(
      { id: 'c6', name: 'create_client', arguments: { name: 'Acme' } },
      { isRejected: true, isConfirmed: true },
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('REJECTED_BY_USER');
    expect(invocations).toHaveLength(0);
  });

  it.each(['list_clients', 'list_invoices', 'get_invoice', 'get_reports_summary'])(
    'runs the read-only tool %s with no confirmation',
    async (name) => {
      registerAll();
      expect(isMutatingTool(name)).toBe(false);
      const result = await dispatchToolCall({ id: 'c7', name, arguments: validArgumentsFor(name) });
      expect(result.ok).toBe(true);
    },
  );
});

describe('availability', () => {
  it('returns TOOL_UNAVAILABLE when the handler module has not shipped', async () => {
    // Nothing registered: this is exactly the state while the other builder works.
    const result = await dispatchToolCall({ id: 'c8', name: 'list_clients', arguments: {} });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOOL_UNAVAILABLE');
    expect(result.message).toContain('clients:list');
    expect(invocations).toHaveLength(0);
  });

  it('maps a ChannelUnavailableError thrown mid-dispatch to TOOL_UNAVAILABLE', async () => {
    registered.add('clients:list');
    invokeError = new FakeChannelUnavailableError('clients:list');

    const result = await dispatchToolCall({ id: 'c9', name: 'list_clients', arguments: {} });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('TOOL_UNAVAILABLE');
  });

  it('maps any other handler failure to EXECUTION_FAILED', async () => {
    registerAll();
    invokeError = new Error('invoices:get failed: database is locked');

    const result = await dispatchToolCall({ id: 'c10', name: 'get_invoice', arguments: { id: 'i1' } });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('EXECUTION_FAILED');
    expect(result.message).toContain('database is locked');
  });
});

describe('dispatch payloads', () => {
  beforeEach(() => {
    registerAll();
  });

  it('list_clients defaults the page size and offset', async () => {
    await dispatchToolCall({ id: 'd1', name: 'list_clients', arguments: { search: 'acme' } });
    expect(invocations[0]).toEqual({
      channel: 'clients:list',
      payload: { search: 'acme', limit: 25, offset: 0 },
    });
  });

  it('list_invoices passes the filters through', async () => {
    await dispatchToolCall({
      id: 'd2',
      name: 'list_invoices',
      arguments: { status: 'overdue', clientId: 'c-1', limit: 5 },
    });
    expect(invocations[0]).toEqual({
      channel: 'invoices:list',
      payload: { search: undefined, status: 'overdue', clientId: 'c-1', limit: 5, offset: 0 },
    });
  });

  it('get_invoice dispatches to invoices:get', async () => {
    await dispatchToolCall({ id: 'd3', name: 'get_invoice', arguments: { id: 'inv-9' } });
    expect(invocations[0]).toEqual({ channel: 'invoices:get', payload: { id: 'inv-9' } });
  });

  it('create_client dispatches to clients:create', async () => {
    await dispatchToolCall(
      { id: 'd4', name: 'create_client', arguments: { name: 'Acme', email: 'a@b.test' } },
      { isConfirmed: true },
    );
    expect(invocations[0]).toEqual({
      channel: 'clients:create',
      payload: { name: 'Acme', email: 'a@b.test' },
    });
  });

  it('create_invoice converts decimal quantities to integer milli-units', async () => {
    await dispatchToolCall(
      {
        id: 'd5',
        name: 'create_invoice',
        arguments: {
          clientId: 'c-1',
          issueDate: '2026-07-01',
          dueDate: '2026-07-31',
          items: [
            { description: 'Consulting', quantity: 1.5, unitPriceCents: 25_000 },
            { description: 'Travel', quantity: 2, unitPriceCents: 4_999 },
          ],
        },
      },
      { isConfirmed: true },
    );

    expect(invocations[0]).toEqual({
      channel: 'invoices:create',
      payload: {
        clientId: 'c-1',
        issueDate: '2026-07-01',
        dueDate: '2026-07-31',
        currency: undefined,
        taxRateBps: undefined,
        notes: undefined,
        items: [
          { position: 0, description: 'Consulting', quantityMilli: 1500, unitPriceCents: 25_000 },
          { position: 1, description: 'Travel', quantityMilli: 2000, unitPriceCents: 4_999 },
        ],
      },
    });
  });

  it('update_invoice_status dispatches to invoices:setStatus', async () => {
    await dispatchToolCall(
      { id: 'd6', name: 'update_invoice_status', arguments: { id: 'inv-2', status: 'paid' } },
      { isConfirmed: true },
    );
    expect(invocations[0]).toEqual({
      channel: 'invoices:setStatus',
      payload: { id: 'inv-2', status: 'paid' },
    });
  });

  it('get_reports_summary dispatches to reports:summary', async () => {
    await dispatchToolCall({
      id: 'd7',
      name: 'get_reports_summary',
      arguments: { from: '2026-01-01', to: '2026-12-31' },
    });
    expect(invocations[0]).toEqual({
      channel: 'reports:summary',
      payload: { from: '2026-01-01', to: '2026-12-31' },
    });
  });

  it('export_invoice_pdf dispatches to invoices:exportPdf', async () => {
    await dispatchToolCall(
      { id: 'd8', name: 'export_invoice_pdf', arguments: { id: 'inv-3', targetPath: '/tmp/a.pdf' } },
      { isConfirmed: true },
    );
    expect(invocations[0]).toEqual({
      channel: 'invoices:exportPdf',
      payload: { id: 'inv-3', targetPath: '/tmp/a.pdf' },
    });
  });

  it('covers every declared tool', () => {
    expect(TOOL_NAMES).toHaveLength(8);
  });
});

describe('result truncation', () => {
  it('leaves a small result alone', () => {
    const { text, isTruncated } = truncateForContext('short');
    expect(text).toBe('short');
    expect(isTruncated).toBe(false);
  });

  it('cuts a large result down to the token budget', () => {
    const { text, isTruncated } = truncateForContext('x'.repeat(10_000), 100);
    expect(isTruncated).toBe(true);
    expect(text).toContain('truncated');
    expect(text.length).toBeLessThan(600);
  });

  it('truncates a huge tool result before it goes back into context', async () => {
    registerAll();
    invokeResult = { items: Array.from({ length: 500 }, (_, index) => ({ id: `client-${index}` })) };

    const result = await dispatchToolCall(
      { id: 'd9', name: 'list_clients', arguments: {} },
      { maxResultTokens: 50 },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.isTruncated).toBe(true);
    expect(result.content.length).toBeLessThan(400);
  });
});

describe('wire formats', () => {
  it('pulls a tool call out of a reply with prose around it', () => {
    const reply = [
      'Let me look that up.',
      '```json',
      '{"tool_call": {"name": "list_invoices", "arguments": {"status": "overdue"}}}',
      '```',
    ].join('\n');

    expect(parseToolCallProposal(reply)).toEqual({
      name: 'list_invoices',
      arguments: { status: 'overdue' },
    });
  });

  it('handles nested objects and braces inside strings', () => {
    const reply =
      'ok {"tool_call": {"name": "create_client", "arguments": {"name": "A } B", "notes": "{}"}}} done';
    expect(parseToolCallProposal(reply)).toEqual({
      name: 'create_client',
      arguments: { name: 'A } B', notes: '{}' },
    });
  });

  it('returns null when there is no tool call', () => {
    expect(parseToolCallProposal('Your total outstanding is $4,200.')).toBeNull();
    expect(parseToolCallProposal('{"tool_call": broken')).toBeNull();
  });

  it('round-trips an approval decision', () => {
    const encoded = encodeToolDecision({ callId: 'call-7', decision: 'approve' });
    expect(parseToolDecision(encoded)).toEqual({ callId: 'call-7', decision: 'approve' });
    expect(parseToolDecision('just text')).toBeNull();
    expect(parseToolDecision('{"tool_decision":{"callId":"x","decision":"maybe"}}')).toBeNull();
  });

  it('describes a proposed call in words a user can approve', () => {
    expect(
      describeToolCall({ id: 'x', name: 'update_invoice_status', arguments: { id: 'inv-1', status: 'paid' } }),
    ).toBe('Set invoice inv-1 to "paid"');
    expect(describeToolCall({ id: 'x', name: 'nope', arguments: {} })).toContain('Unknown tool');
  });
});

function validArgumentsFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'create_client':
      return { name: 'Acme' };
    case 'create_invoice':
      return {
        clientId: 'c-1',
        issueDate: '2026-07-01',
        dueDate: '2026-07-31',
        items: [{ description: 'Work', quantity: 1, unitPriceCents: 100 }],
      };
    case 'update_invoice_status':
      return { id: 'inv-1', status: 'paid' };
    case 'export_invoice_pdf':
      return { id: 'inv-1' };
    case 'get_invoice':
      return { id: 'inv-1' };
    default:
      return {};
  }
}
