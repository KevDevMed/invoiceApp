/**
 * State for the Assistant page.
 *
 * Two things here are workarounds for gaps in the frozen contract, both written
 * up in the piece report:
 *
 *   - There is no `llm:threads` / `llm:messages` channel, so main mirrors the
 *     thread index and each transcript into the `settings` key/value store and
 *     this hook reads them back with `settings:get`. `chat_threads` and
 *     `chat_messages` remain the source of truth in main.
 *   - There is no channel for approving a proposed tool call, so the decision
 *     travels as a JSON body on a `tool`-role message inside `llm:chat`, which
 *     the contract's message schema does allow.
 */

import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useState } from 'react';

import type { ChatMessage } from '../../../shared/types';
import type { LocalModel } from '../models/llmExtra';
import { assistantAvailability, isDesktopOnlyError, type AssistantAvailability } from './availability';

const THREAD_INDEX_KEY = 'llm.threadIndex';
const THREAD_TRANSCRIPT_PREFIX = 'llm.thread.';
const ACTIVE_MODEL_KEY = 'llm.activeModelId';

export interface ThreadSummary {
  readonly id: string;
  readonly title: string | null;
  readonly modelId: string | null;
  readonly updatedAt: string;
}

export interface ToolCallRecord {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
  readonly summary: string;
  readonly isMutating: boolean;
  readonly status: 'awaiting_approval' | 'executed' | 'failed' | 'rejected';
  readonly error?: string;
}

export interface AssistantState {
  readonly threads: ThreadSummary[];
  readonly threadId: string | null;
  readonly messages: ChatMessage[];
  readonly readyModels: LocalModel[];
  readonly activeModelId: string | null;
  readonly streamingText: string;
  readonly isStreaming: boolean;
  readonly isLoading: boolean;
  readonly error: string | null;
  /** Why the assistant can or cannot answer right now — see `availability.ts`. */
  readonly availability: AssistantAvailability;
  /** Mutating calls the model has proposed and the user has not answered yet. */
  readonly pendingApprovals: ToolCallRecord[];
  send(text: string): Promise<void>;
  stop(): Promise<void>;
  decide(callId: string, decision: 'approve' | 'reject'): Promise<void>;
  selectThread(id: string | null): void;
  newThread(): void;
  selectModel(modelId: string): Promise<void>;
  dismissError(): void;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `crypto.randomUUID` needs a secure context, which `file://` is not. */
function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Mirrors `encodeToolDecision` in `src/main/llm/tools.ts`. */
export function encodeToolDecision(callId: string, decision: 'approve' | 'reject'): string {
  return JSON.stringify({ tool_decision: { callId, decision } });
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function parseToolCalls(message: ChatMessage): ToolCallRecord[] {
  return parseJson<ToolCallRecord[]>(message.toolCalls, []);
}

/** Turns stored messages into the transcript the model is sent next time. */
function toTurns(messages: readonly ChatMessage[]): { role: ChatMessage['role']; content: string }[] {
  return messages
    .filter((message) => message.role !== 'system')
    .map((message) => ({ role: message.role, content: message.content }));
}

export function useAssistant(): AssistantState {
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [readyModels, setReadyModels] = useState<LocalModel[]>([]);
  const [activeModelId, setActiveModelId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState('');
  const [requestId, setRequestId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isDesktopOnly, setIsDesktopOnly] = useState(false);

  // The flag latches: the platform cannot stop being a browser mid-session, so
  // a later, unrelated failure must not flip the page back to a generic error.
  const reportError = useCallback((caught: unknown) => {
    setError(errorText(caught));
    setIsDesktopOnly((current) => current || isDesktopOnlyError(caught));
  }, []);

  const readSetting = useCallback(async (key: string): Promise<string | null> => {
    const result = await window.api.invoke('settings:get', { key });
    return result.value;
  }, []);

  const refreshShell = useCallback(async () => {
    try {
      const [local, active, index] = await Promise.all([
        window.api.invoke('llm:listLocal', undefined),
        readSetting(ACTIVE_MODEL_KEY),
        readSetting(THREAD_INDEX_KEY),
      ]);
      setReadyModels(local.models.filter((record) => record.status === 'ready'));
      setActiveModelId(active && active.length > 0 ? active : null);
      setThreads(parseJson<ThreadSummary[]>(index, []));
    } catch (caught) {
      reportError(caught);
    } finally {
      setIsLoading(false);
    }
  }, [readSetting, reportError]);

  const refreshTranscript = useCallback(
    async (id: string | null) => {
      if (!id) {
        setMessages([]);
        return;
      }
      const raw = await readSetting(`${THREAD_TRANSCRIPT_PREFIX}${id}`);
      setMessages(parseJson<ChatMessage[]>(raw, []));
    },
    [readSetting],
  );

  useEffect(() => {
    void refreshShell();
  }, [refreshShell]);

  useEffect(() => {
    void refreshTranscript(threadId);
  }, [threadId, refreshTranscript]);

  useEffect(() => {
    const unsubscribe = window.api.on('llm:chatToken', (event) => {
      if (event.done) return;
      setStreamingText((current) => current + event.token);
    });
    return unsubscribe;
  }, []);

  const runChat = useCallback(
    async (turns: { role: ChatMessage['role']; content: string }[]) => {
      const id = newId('req');
      setRequestId(id);
      setStreamingText('');
      setError(null);

      try {
        const response = await window.api.invoke('llm:chat', {
          threadId: threadId ?? undefined,
          requestId: id,
          messages: turns,
        });
        setThreadId(response.threadId);
        await refreshTranscript(response.threadId);
        await refreshShell();
        if (response.stopReason === 'error') {
          setError(response.message.content);
        }
      } catch (caught) {
        reportError(caught);
      } finally {
        setRequestId(null);
        setStreamingText('');
      }
    },
    [threadId, refreshTranscript, refreshShell, reportError],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (trimmed.length === 0) return;

      // Show the user's turn immediately; main persists it and we re-read the
      // authoritative transcript when the reply lands.
      const optimistic: ChatMessage = {
        id: newId('local'),
        threadId: threadId ?? 'pending',
        role: 'user',
        content: trimmed,
        toolCalls: null,
        createdAt: new Date().toISOString(),
      };
      setMessages((current) => [...current, optimistic]);

      await runChat([...toTurns(messages), { role: 'user', content: trimmed }]);
    },
    [messages, threadId, runChat],
  );

  const decide = useCallback(
    async (callId: string, decision: 'approve' | 'reject') => {
      await runChat([
        ...toTurns(messages),
        { role: 'tool', content: encodeToolDecision(callId, decision) },
      ]);
    },
    [messages, runChat],
  );

  const stop = useCallback(async () => {
    if (!requestId) return;
    try {
      await window.api.invoke('llm:cancelChat', { requestId });
    } catch (caught) {
      reportError(caught);
    }
  }, [requestId, reportError]);

  const selectThread = useCallback((id: string | null) => {
    setThreadId(id);
    setStreamingText('');
  }, []);

  const newThread = useCallback(() => {
    setThreadId(null);
    setMessages([]);
    setStreamingText('');
  }, []);

  const selectModel = useCallback(
    async (modelId: string) => {
      setError(null);
      try {
        await window.api.invoke('llm:load', { modelId });
        await refreshShell();
      } catch (caught) {
        reportError(caught);
      }
    },
    [refreshShell, reportError],
  );

  const dismissError = useCallback(() => {
    setError(null);
  }, []);

  const pendingApprovals = useMemo(() => {
    const answered = new Set<string>();
    const pending = new Map<string, ToolCallRecord>();

    for (const message of messages) {
      for (const call of parseToolCalls(message)) {
        if (call.status === 'awaiting_approval') pending.set(call.id, call);
        else answered.add(call.id);
      }
    }

    for (const id of answered) pending.delete(id);
    return [...pending.values()];
  }, [messages]);

  const availability = assistantAvailability({
    isLoading,
    readyModelCount: readyModels.length,
    activeModelId,
    error,
    isDesktopOnlyError: isDesktopOnly,
  });

  return {
    threads,
    threadId,
    messages,
    readyModels,
    activeModelId,
    streamingText,
    isStreaming: requestId !== null,
    isLoading,
    error,
    availability,
    pendingApprovals,
    send,
    stop,
    decide,
    selectThread,
    newThread,
    selectModel,
    dismissError,
  };
}

/*
  One instance, many consumers. The `/assistant` page and the floating chat
  dock must show the same threads, messages, and streaming state, so the state
  lives in a single provider instead of per-caller `useAssistant()` calls.
  Built with `createElement` rather than JSX so this file can stay `.ts` and
  no importer has to change.
*/
const AssistantContext = createContext<AssistantState | null>(null);

export function AssistantProvider(props: { readonly children: React.ReactNode }): React.JSX.Element {
  return createElement(AssistantContext.Provider, { value: useAssistant() }, props.children);
}

/** Throws a clear error when called outside AssistantProvider. */
export function useAssistantContext(): AssistantState {
  const state = useContext(AssistantContext);
  if (state === null) {
    // No silent fallback to a private `useAssistant()` here: two instances
    // would be two chats that disagree about history, which is exactly the
    // bug the provider exists to prevent.
    throw new Error('useAssistantContext must be called inside <AssistantProvider>');
  }
  return state;
}
