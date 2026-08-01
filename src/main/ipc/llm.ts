/**
 * IPC surface for the local model subsystem.
 *
 * Discovered automatically by `registry.ts` — there is no list to edit. Every
 * channel here is declared in the frozen contract and validated by
 * `registerHandler` before this file sees a payload.
 *
 * Two places where the contract could not express what the feature needs, and
 * what was done instead (both are written up in the piece report):
 *
 *   1. `llm:downloadProgress` carries bytes but no rate or ETA. The downloader
 *      computes both; the renderer re-derives them from the byte deltas and the
 *      arrival times of these events.
 *   2. There is no channel for reading chat history back, and no channel for
 *      approving a tool call. History is mirrored into the `settings` table
 *      (an open key/value store the contract does expose), and approvals travel
 *      as a JSON body on a `tool`-role message inside `llm:chat`.
 */

import { randomUUID } from 'node:crypto';

import { BrowserWindow } from 'electron';

import { getDatabase } from '../../db/client';
import {
  IPC_CONTRACT,
  type IpcEventChannel,
  type IpcEventPayload,
  type IpcResponse,
} from '../../shared/ipc-contract';
import type { ChatMessage } from '../../shared/types';
import {
  CATALOG,
  describeEntry,
  findCatalogEntry,
  resolveModelPath,
} from '../llm/catalog';
import { ModelDownloader, removeLocalModel, type DownloadProgress } from '../llm/downloader';
import {
  CatalogRequestSchema,
  CheckSupportRequest,
  DiscoverRequest,
  HF_TOKEN_SETTING_KEY,
  HfLookupRequest,
  SmokeTestRequest,
  SystemInfoRequest,
  opOf,
} from '../llm/extra-channels';
import { discoverModels, type DiscoveryResult } from '../llm/discovery';
import type { CompatibilityHardware } from '../llm/compatibility';
import { clampContextSize } from '../llm/context-clamp';
import { readLocalGgufMetadata } from '../llm/gguf';
import { describeHardware, toCompatibilityHardware, type HardwareProfile } from '../llm/hardware';
import { lookupRepo, searchRepos, type HfRepoInfo } from '../llm/hf';
import { PendingToolCalls } from '../llm/pending-tool-calls';
import { SupportService, type VariantSupport } from '../llm/support-service';
import { runSmokeTest, saveSmokeTest, type SmokeTestRecord } from '../llm/smoke-test';
import {
  DEFAULT_CONTEXT_SIZE,
  FakeLlmRuntime,
  LlmRuntimeError,
  NodeLlamaCppRuntime,
  type ChatTurn,
  type GenerateStopReason,
  type LlmRuntime,
} from '../llm/runtime';
import {
  appendMessage,
  createDiskProbe,
  createThread,
  deleteModelRow,
  getModel,
  listMessages,
  listModels,
  listThreads,
  markInterrupted,
  reconcileOnBoot,
  requireThread,
  updateThread,
} from '../llm/store';
import {
  describeToolCall,
  dispatchToolCall,
  isMutatingTool,
  parseToolCallProposal,
  parseToolDecision,
  toolSystemPrompt,
  type ToolCall,
} from '../llm/tools';
import { modelsDir } from '../paths';
import { registerHandler } from './registry';

/** How many read-only tool round-trips one `llm:chat` call may make on its own. */
const MAX_TOOL_ITERATIONS = 4;

/** Settings keys the renderer reads chat history back from. */
const THREAD_INDEX_KEY = 'llm.threadIndex';
/** Which model is resident right now, so both renderer pages can agree on it. */
const ACTIVE_MODEL_KEY = 'llm.activeModelId';
const THREAD_TRANSCRIPT_PREFIX = 'llm.thread.';
/** `settings.value` is capped at 100k characters by the contract. Stay well under. */
const TRANSCRIPT_CHAR_BUDGET = 80_000;

// ---------------------------------------------------------------------------
// main -> renderer events
// ---------------------------------------------------------------------------

function broadcast<C extends IpcEventChannel>(channel: C, payload: IpcEventPayload<C>): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

function emitDownloadProgress(progress: DownloadProgress): void {
  // The contract's event has no rate/ETA fields, so only the byte counts and
  // status cross the boundary. The renderer differentiates them for the speed
  // readout — see the report for the field this event is missing.
  broadcast('llm:downloadProgress', {
    modelId: progress.modelId,
    receivedBytes: progress.receivedBytes,
    totalBytes: progress.totalBytes,
    status: progress.status,
    error: progress.error,
  });
}

// ---------------------------------------------------------------------------
// Lazily-built singletons
// ---------------------------------------------------------------------------

let downloader: ModelDownloader | null = null;

function getDownloader(): ModelDownloader {
  downloader ??= new ModelDownloader({
    db: () => getDatabase(),
    modelsRoot: () => modelsDir(),
    fetch: (url, init) => fetch(url, init),
    emit: emitDownloadProgress,
    // Non-catalog downloads get their expected digest from the Hub, using the
    // same token the repo lookup uses so gated repos still resolve.
    hfToken: readHfToken,
  });
  return downloader;
}

let runtime: LlmRuntime | null = null;

function getRuntime(): LlmRuntime {
  if (!runtime) {
    // The double exists so a machine with no working llama.cpp backend can still
    // exercise the UI. It is opt-in, never a silent fallback.
    runtime = process.env.INVOICEAPP_FAKE_LLM === '1' ? new FakeLlmRuntime() : new NodeLlamaCppRuntime();
  }
  return runtime;
}

/** Chat generations that can still be cancelled, keyed by `requestId`. */
const activeChats = new Map<string, AbortController>();

/**
 * Mutating tool calls waiting on the user, keyed by call id.
 *
 * Bounded by TTL and by count: the model can propose one of these every turn and
 * the user is never obliged to answer, so an unbounded map would grow for the
 * life of the process on model output alone.
 */
const pendingToolCalls = new PendingToolCalls<ToolCall>();

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export function register(): void {
  reconcileModelsAgainstDisk();

  // `llm:catalog` carries an `op` discriminator so the four undeclarable
  // channels (systemInfo, checkSupport, hfLookup, smokeTest) have somewhere to
  // live. See `../llm/extra-channels.ts` and the piece report.
  registerHandler('llm:catalog', CatalogRequestSchema, (payload) => handleCatalogOp(payload));

  registerHandler('llm:download', IPC_CONTRACT['llm:download'].request, (payload) => {
    const started = getDownloader().start({
      repo: payload.repo,
      filename: payload.filename,
      quant: payload.quant,
    });
    // The transfer outlives this call; progress and failures arrive as events.
    void started.completion;
    return { modelId: started.modelId };
  });

  registerHandler('llm:cancelDownload', IPC_CONTRACT['llm:cancelDownload'].request, ({ modelId }) => ({
    modelId,
    cancelled: getDownloader().cancel(modelId),
  }));

  registerHandler('llm:removeModel', IPC_CONTRACT['llm:removeModel'].request, async ({ modelId }) => {
    const db = getDatabase();
    getDownloader().cancel(modelId);
    await getDownloader().wait(modelId);

    const active = getRuntime().current();
    if (active?.modelId === modelId) {
      await getRuntime().unload();
      writeSetting(db, ACTIVE_MODEL_KEY, '');
    }

    const removed = await removeLocalModel(modelsDir(), modelId);
    const deleted = deleteModelRow(db, modelId);
    return { id: modelId, deleted: removed && deleted };
  });

  registerHandler('llm:listLocal', IPC_CONTRACT['llm:listLocal'].request, () => ({
    models: listModels(getDatabase()),
  }));

  registerHandler('llm:load', IPC_CONTRACT['llm:load'].request, async (payload) => {
    const db = getDatabase();
    const record = getModel(db, payload.modelId);
    if (!record || record.status !== 'ready' || !record.localPath) {
      throw new Error(`Model ${payload.modelId} is not downloaded yet.`);
    }
    if (record.verifiedSha256 === null) {
      // Belt and braces: `reconcileOnBoot` already refuses to promote unverified
      // bytes, and this is the last gate before llama.cpp's native GGUF parser.
      throw new Error(
        `Model ${payload.modelId} has not been checksum-verified on this machine. Download it again before loading it.`,
      );
    }

    // Re-derive the path rather than trusting the stored one: the row survives
    // upgrades, the allow-list is the thing that has to hold.
    const modelPath = resolveModelPath(modelsDir(), record.id, record.filename);
    const entry = findCatalogEntry(record.id);
    const requested = payload.contextSize ?? entry?.defaultContextSize ?? DEFAULT_CONTEXT_SIZE;

    const clamp = await clampRequestedContext({
      requested,
      modelPath,
      modelSizeBytes: record.sizeBytes,
      fallbackMax: entry?.defaultContextSize ?? DEFAULT_CONTEXT_SIZE,
    });

    const loaded = await getRuntime().load({
      modelId: record.id,
      modelPath,
      contextSize: clamp.contextSize,
      gpuLayers: payload.gpuLayers,
    });

    writeSetting(db, ACTIVE_MODEL_KEY, loaded.modelId);
    // `contextSize` is the contract's field and reports what was actually
    // allocated. The clamp fields ride alongside so the UI can say why.
    return {
      modelId: loaded.modelId,
      loaded: true,
      contextSize: loaded.contextSize,
      requestedContextSize: clamp.requestedContextSize,
      contextClamped: clamp.clamped,
      contextClampReason: clamp.reason,
    };
  });

  registerHandler('llm:unload', IPC_CONTRACT['llm:unload'].request, async () => {
    const unloaded = await getRuntime().unload();
    writeSetting(getDatabase(), ACTIVE_MODEL_KEY, '');
    return { unloaded };
  });

  registerHandler('llm:chat', IPC_CONTRACT['llm:chat'].request, (payload) => handleChat(payload));

  registerHandler('llm:cancelChat', IPC_CONTRACT['llm:cancelChat'].request, ({ requestId }) => {
    const controller = activeChats.get(requestId);
    controller?.abort();
    return { requestId, cancelled: controller !== undefined };
  });
}

// ---------------------------------------------------------------------------
// llm:catalog — the multiplexed channel
// ---------------------------------------------------------------------------

type CatalogResponse = IpcResponse<'llm:catalog'>;

/**
 * What actually goes over the wire for `llm:catalog`.
 *
 * `entries` is the contract's field and is always present (empty for the ops
 * that are not a catalog listing). Everything else is the extra payload; the
 * contract does not re-validate responses, so it arrives intact.
 */
export interface CatalogOpResponse {
  readonly entries: CatalogResponse['entries'];
  readonly systemInfo?: HardwareProfile & { readonly summary: string };
  readonly support?: VariantSupport;
  readonly hf?: HfRepoInfo;
  readonly discovery?: DiscoveryResult;
  readonly smokeTest?: SmokeTestRecord;
}

let supportService: SupportService | null = null;

function getSupportService(): SupportService {
  supportService ??= new SupportService({ token: readHfToken });
  return supportService;
}

function readHfToken(): string | null {
  try {
    const row = getDatabase()
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(HF_TOKEN_SETTING_KEY);
    const value = row?.value?.trim();
    return value && value.length > 0 ? value : null;
  } catch {
    return null;
  }
}

function catalogEntries(): CatalogResponse['entries'] {
  return CATALOG.map((entry) => ({
    id: entry.id,
    repo: entry.repo,
    filename: entry.filename,
    quant: entry.quant,
    sizeBytes: entry.sizeBytes,
    // The contract has no license/context/notes fields, so the one-line
    // summary carries all three.
    description: describeEntry(entry),
  }));
}

async function handleCatalogOp(payload: unknown): Promise<CatalogResponse> {
  const op = opOf(payload);

  switch (op) {
    case 'catalog':
      return { entries: catalogEntries() } satisfies CatalogOpResponse as CatalogResponse;

    case 'systemInfo': {
      // `refresh` re-probes the hardware itself, not just the verdict cache —
      // it is the difference between `Re-check` re-measuring the machine and
      // recomputing the same answers from the reading it already had.
      const request = SystemInfoRequest.parse(payload);
      const profile = await getSupportService().systemInfo(request.refresh ?? false);
      return {
        entries: [],
        systemInfo: { ...profile, summary: describeHardware(profile) },
      } satisfies CatalogOpResponse as CatalogResponse;
    }

    case 'checkSupport': {
      const request = CheckSupportRequest.parse(payload);
      const support = await getSupportService().check({
        repo: request.repo,
        filename: request.filename,
        sizeBytes: request.sizeBytes ?? null,
        ctxSize: request.ctxSize,
        refresh: request.refresh,
      });
      return { entries: [], support } satisfies CatalogOpResponse as CatalogResponse;
    }

    case 'hfLookup': {
      const request = HfLookupRequest.parse(payload);
      const hf = await lookupRepo(request.repo, { token: readHfToken() });
      return { entries: [], hf } satisfies CatalogOpResponse as CatalogResponse;
    }

    case 'discover': {
      const request = DiscoverRequest.parse(payload);
      const token = readHfToken();
      const discovery = await discoverModels(
        {
          support: getSupportService(),
          search: (query, limit) => searchRepos(query, { limit, token }),
          lookup: (repo) => lookupRepo(repo, { token }),
        },
        {
          query: request.query,
          ctxSize: request.ctxSize,
          maxRepos: request.maxRepos,
          maxVariantsPerRepo: request.maxVariantsPerRepo,
          maxChecks: request.maxChecks,
          refresh: request.refresh,
        },
      );
      return { entries: [], discovery } satisfies CatalogOpResponse as CatalogResponse;
    }

    case 'smokeTest': {
      const request = SmokeTestRequest.parse(payload);
      const smokeTest = await performSmokeTest(request);
      return { entries: [], smokeTest } satisfies CatalogOpResponse as CatalogResponse;
    }
  }
}

/**
 * Run the real thing: load the downloaded weights, generate, measure, unload.
 *
 * The runtime holds one model at a time, so this necessarily evicts whatever was
 * resident — `llm.activeModelId` is cleared to keep both pages honest about it.
 */
async function performSmokeTest(request: SmokeTestRequest): Promise<SmokeTestRecord> {
  const db = getDatabase();
  const record = getModel(db, request.modelId);
  if (!record || record.status !== 'ready') {
    throw new Error(`Model ${request.modelId} is not downloaded yet, so it cannot be tested.`);
  }

  const modelPath = resolveModelPath(modelsDir(), record.id, record.filename);
  const result = await runSmokeTest({
    runtime: getRuntime(),
    modelId: record.id,
    modelPath,
    contextSize: request.contextSize,
    maxTokens: request.maxTokens,
  });

  writeSetting(db, ACTIVE_MODEL_KEY, '');
  saveSmokeTest(db, record.id, result);
  return result;
}

/**
 * Settle the `models` table against the filesystem before anything can read it.
 *
 * Rows left in `downloading` by a previous run have no writer any more; their
 * `.part` files are the resumable truth.
 */
function reconcileModelsAgainstDisk(): void {
  try {
    // Nothing is resident this early in boot, whatever the last run left behind.
    writeSetting(getDatabase(), ACTIVE_MODEL_KEY, '');
    const result = reconcileOnBoot(getDatabase(), createDiskProbe(modelsDir()));
    if (result.promotedToReady.length || result.resetToAvailable.length) {
      console.log(
        `[llm] reconciled models — ready: [${result.promotedToReady.join(', ')}], reset: [${result.resetToAvailable.join(', ')}]`,
      );
    }
  } catch (error) {
    console.warn('[llm] could not reconcile the models table against disk:', error);
  }
}

// ---------------------------------------------------------------------------
// Chat
// ---------------------------------------------------------------------------

type ChatRequest = (typeof IPC_CONTRACT)['llm:chat']['request']['_output'];
type ChatResponse = (typeof IPC_CONTRACT)['llm:chat']['response']['_output'];

interface RecordedToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly summary: string;
  readonly isMutating: boolean;
  readonly status: 'awaiting_approval' | 'executed' | 'failed' | 'rejected';
  readonly result?: unknown;
  readonly error?: string;
}

async function handleChat(payload: ChatRequest): Promise<ChatResponse> {
  const db = getDatabase();
  const active = getRuntime().current();
  if (!active) {
    throw new LlmRuntimeError(
      'No model is loaded. Download a model on the Models page and press Load.',
      'MODEL_NOT_LOADED',
    );
  }

  const thread = payload.threadId
    ? requireThread(db, payload.threadId)
    : createThread(db, { title: deriveTitle(payload.messages), modelId: active.modelId });
  if (thread.modelId !== active.modelId) {
    updateThread(db, thread.id, { modelId: active.modelId });
  }

  const controller = new AbortController();
  activeChats.set(payload.requestId, controller);

  const recorded: RecordedToolCall[] = [];
  let working: ChatTurn[] = [
    { role: 'system', content: toolSystemPrompt() },
    ...payload.messages.filter((message) => message.role !== 'system'),
  ];

  try {
    const incoming = payload.messages[payload.messages.length - 1];
    if (incoming) {
      const resolved = await applyIncomingMessage(db, thread.id, incoming, recorded);
      if (resolved) {
        working = [...working.slice(0, -1), resolved];
      }
    }

    let text = '';
    let stopReason: GenerateStopReason = 'stop';
    let thoughts: string | undefined;

    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration += 1) {
      const generated = await getRuntime().generate({
        requestId: payload.requestId,
        messages: working,
        temperature: payload.temperature,
        maxTokens: payload.maxTokens,
        signal: controller.signal,
        onToken: (token) => {
          broadcast('llm:chatToken', { requestId: payload.requestId, token, done: false });
        },
      });

      text = generated.text;
      stopReason = generated.stopReason;
      thoughts = generated.thoughts;
      if (stopReason !== 'stop') break;

      const proposal = parseToolCallProposal(generated.text);
      if (!proposal) break;

      const call: ToolCall = {
        id: randomUUID(),
        name: proposal.name,
        arguments: proposal.arguments,
      };

      if (isMutatingTool(call.name)) {
        // The model proposes; the user disposes. Nothing is executed here.
        pendingToolCalls.set(call.id, call);
        recorded.push({
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          summary: describeToolCall(call),
          isMutating: true,
          status: 'awaiting_approval',
        });
        break;
      }

      const result = await dispatchToolCall(call);
      recorded.push(toRecorded(call, result.ok, result));
      appendMessage(db, {
        threadId: thread.id,
        role: 'tool',
        content: result.content,
        toolCalls: [toRecorded(call, result.ok, result)],
      });

      working = [
        ...working,
        { role: 'assistant', content: generated.text },
        { role: 'tool', content: result.content },
      ];
    }

    broadcast('llm:chatToken', { requestId: payload.requestId, token: '', done: true });

    // Never store `content: ""` as if it were a reply — see `resolveAssistantOutcome`.
    const outcome = resolveAssistantOutcome({
      text,
      stopReason,
      thoughts,
      hasToolCalls: recorded.length > 0,
    });

    const message = appendMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      content: outcome.content,
      toolCalls: recorded.length > 0 ? recorded : undefined,
    });

    const updated = requireThread(db, thread.id);
    mirrorHistory(db, thread.id);
    return {
      requestId: payload.requestId,
      threadId: thread.id,
      message,
      thread: updated,
      stopReason: outcome.stopReason,
    };
  } catch (error) {
    broadcast('llm:chatToken', { requestId: payload.requestId, token: '', done: true });
    const message = error instanceof Error ? error.message : String(error);
    const stored = appendMessage(db, {
      threadId: thread.id,
      role: 'assistant',
      content: message,
      toolCalls: recorded.length > 0 ? recorded : undefined,
    });
    mirrorHistory(db, thread.id);
    return {
      requestId: payload.requestId,
      threadId: thread.id,
      message: stored,
      thread: requireThread(db, thread.id),
      stopReason: 'error',
    };
  } finally {
    activeChats.delete(payload.requestId);
  }
}

/**
 * What the user is told when the model reasoned but never answered.
 *
 * Qwen3 — every model in the catalog is one — reasons by default, and
 * `node-llama-cpp` keeps thought segments out of the response text. The runtime
 * now reports that case as `reasoning_only` instead of an empty string, and this
 * is the text that goes into the transcript in its place.
 */
export const REASONING_ONLY_NOTICE =
  'The model produced only reasoning and no answer. Ask again, or try a model that answers directly.';

const EMPTY_NOTICE: Record<GenerateStopReason, string> = {
  stop: 'The model returned an empty reply.',
  length: 'The model hit the token limit before it produced an answer.',
  cancelled: 'Generation was stopped before the model replied.',
  error: 'The model produced no reply.',
  reasoning_only: REASONING_ONLY_NOTICE,
};

/**
 * Decide what to persist as the assistant turn, and what stop reason to report.
 *
 * `chat_messages.content` never gets an empty string: a turn that produced no
 * text says why in plain words instead. The contract's stop reason has only four
 * values, so `reasoning_only` travels as `error` — which is also the value the
 * Assistant page raises a banner for.
 */
export function resolveAssistantOutcome(input: {
  readonly text: string;
  readonly stopReason: GenerateStopReason;
  readonly thoughts?: string;
  readonly hasToolCalls: boolean;
}): { readonly content: string; readonly stopReason: ChatResponse['stopReason'] } {
  if (input.text.trim().length > 0) {
    return {
      content: input.text,
      stopReason: input.stopReason === 'reasoning_only' ? 'error' : input.stopReason,
    };
  }

  // A mutating tool call awaiting approval is a real turn even with no prose.
  if (input.hasToolCalls && input.stopReason === 'stop') {
    return { content: 'Waiting for your decision on the proposed action.', stopReason: 'stop' };
  }

  const reasoned = input.stopReason === 'reasoning_only' || (input.thoughts ?? '').trim().length > 0;
  return {
    content: reasoned ? REASONING_ONLY_NOTICE : EMPTY_NOTICE[input.stopReason],
    // An empty turn is never a plain success: `cancelled` and `length` already
    // say what happened, anything else surfaces as an error the UI can show.
    stopReason:
      input.stopReason === 'cancelled' || input.stopReason === 'length' ? input.stopReason : 'error',
  };
}

/**
 * Persist the newly-arrived message and, when it is an approve/reject decision,
 * run (or refuse) the tool call it refers to.
 *
 * Returns the turn that should replace the incoming one in the model's context
 * — for a decision, the actual tool output — or null to leave it as it is.
 */
async function applyIncomingMessage(
  db: ReturnType<typeof getDatabase>,
  threadId: string,
  incoming: { role: ChatTurn['role']; content: string },
  recorded: RecordedToolCall[],
): Promise<ChatTurn | null> {
  if (incoming.role !== 'tool') {
    appendMessage(db, { threadId, role: incoming.role, content: incoming.content });
    return null;
  }

  const decision = parseToolDecision(incoming.content);
  if (!decision) {
    appendMessage(db, { threadId, role: 'tool', content: incoming.content });
    return null;
  }

  const call = pendingToolCalls.get(decision.callId);
  if (!call) {
    const content = JSON.stringify({
      error: 'UNKNOWN_TOOL_CALL',
      message: 'That tool call is no longer pending.',
    });
    appendMessage(db, { threadId, role: 'tool', content });
    return { role: 'tool', content };
  }

  pendingToolCalls.delete(decision.callId);
  const result = await dispatchToolCall(call, {
    isConfirmed: decision.decision === 'approve',
    isRejected: decision.decision === 'reject',
  });

  const entry: RecordedToolCall =
    decision.decision === 'reject'
      ? {
          id: call.id,
          name: call.name,
          arguments: call.arguments,
          summary: describeToolCall(call),
          isMutating: true,
          status: 'rejected',
        }
      : toRecorded(call, result.ok, result);

  recorded.push(entry);
  appendMessage(db, { threadId, role: 'tool', content: result.content, toolCalls: [entry] });
  return { role: 'tool', content: result.content };
}

function toRecorded(
  call: ToolCall,
  ok: boolean,
  result: Awaited<ReturnType<typeof dispatchToolCall>>,
): RecordedToolCall {
  return {
    id: call.id,
    name: call.name,
    arguments: call.arguments,
    summary: describeToolCall(call),
    isMutating: isMutatingTool(call.name),
    status: ok ? 'executed' : 'failed',
    result: result.ok ? result.result : undefined,
    error: result.ok ? undefined : result.message,
  };
}

function deriveTitle(messages: readonly { role: string; content: string }[]): string {
  const firstUser = messages.find((message) => message.role === 'user');
  const text = (firstUser?.content ?? 'New conversation').trim().replace(/\s+/g, ' ');
  return text.length > 60 ? `${text.slice(0, 57)}…` : text;
}

// ---------------------------------------------------------------------------
// History mirror
// ---------------------------------------------------------------------------

/**
 * Copy the thread index and this thread's transcript into `settings`.
 *
 * `chat_threads` / `chat_messages` remain the source of truth; this mirror
 * exists purely because the frozen contract gives the renderer no channel for
 * reading them back, and `settings:get` is the one general-purpose read it does
 * have.
 */
function mirrorHistory(db: ReturnType<typeof getDatabase>, threadId: string): void {
  try {
    const index = listThreads(db, 100).map((thread) => ({
      id: thread.id,
      title: thread.title,
      modelId: thread.modelId,
      updatedAt: thread.updatedAt,
    }));
    writeSetting(db, THREAD_INDEX_KEY, JSON.stringify(index));

    const messages = listMessages(db, threadId);
    writeSetting(db, `${THREAD_TRANSCRIPT_PREFIX}${threadId}`, encodeTranscript(messages));
  } catch (error) {
    console.warn('[llm] could not mirror chat history into settings:', error);
  }
}

function encodeTranscript(messages: readonly ChatMessage[]): string {
  const trimmed = [...messages];
  let encoded = JSON.stringify(trimmed);
  // Drop from the front until it fits: the tail of a conversation is the part
  // the user is looking at.
  while (encoded.length > TRANSCRIPT_CHAR_BUDGET && trimmed.length > 1) {
    trimmed.shift();
    encoded = JSON.stringify(trimmed);
  }
  return encoded;
}

function writeSetting(db: ReturnType<typeof getDatabase>, key: string, value: string): void {
  db.prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, value);
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

/**
 * Bound a requested context by the model's own header and this machine's memory.
 *
 * Reading the local header costs one small read; a failure is not fatal, it just
 * leaves the clamp working from the fallback.
 */
async function clampRequestedContext(input: {
  requested: number;
  modelPath: string;
  modelSizeBytes: number | null;
  fallbackMax: number;
}): Promise<ReturnType<typeof clampContextSize>> {
  let meta: Awaited<ReturnType<typeof readLocalGgufMetadata>> | null = null;
  try {
    meta = await readLocalGgufMetadata(input.modelPath);
  } catch (error) {
    console.warn('[llm] could not read GGUF metadata for the context clamp:', error);
  }

  let hardware: CompatibilityHardware = { totalRamBytes: null, gpus: [] };
  try {
    hardware = toCompatibilityHardware(await getSupportService().systemInfo());
  } catch (error) {
    console.warn('[llm] could not detect hardware for the context clamp:', error);
  }

  return clampContextSize({
    requested: input.requested,
    meta,
    modelSizeBytes: input.modelSizeBytes,
    hardware,
    fallbackMax: input.fallbackMax,
  });
}

/** Cancel everything in flight. Exported for the app's `will-quit` path. */
export async function shutdownLlm(): Promise<void> {
  for (const controller of activeChats.values()) controller.abort();
  activeChats.clear();
  pendingToolCalls.clear();
  for (const id of getDownloader().activeDownloadIds()) {
    getDownloader().cancel(id);
    markInterrupted(getDatabase(), id, 0);
  }
  await getRuntime().dispose();
}

/**
 * The teardown `registry.ts` drains on `before-quit`, before the database closes.
 *
 * Discovered by name, like `register()` — nothing has to list it anywhere.
 */
export async function shutdown(): Promise<void> {
  await shutdownLlm();
}
