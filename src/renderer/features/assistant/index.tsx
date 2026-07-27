/**
 * Assistant feature barrel — the `/assistant` route.
 *
 * `AssistantPage` is the name `routes.tsx` imports; everything else in this
 * directory is ours. The page is deliberately blunt about the safety model: a
 * mutating tool call is rendered as an approval card with the exact action
 * spelled out, and nothing runs until the user presses Approve.
 */

import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import { ChatComposer, ChatMessage as ChatMessageRow, ChatMessageList } from '@astryxdesign/core/Chat';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { Heading } from '@astryxdesign/core/Heading';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { ChatMessage } from '../../../shared/types';
import { describeSmokeTest, readSmokeTest } from '../models/llmExtra';
import { parseToolCalls, useAssistant, type ToolCallRecord } from './useAssistant';

export function AssistantPage(): React.JSX.Element {
  const assistant = useAssistant();
  const [draft, setDraft] = useState('');

  if (assistant.isLoading) {
    return (
      <VStack gap={4} padding={4} height="100%" vAlign="center" hAlign="center">
        <Spinner label="Loading the assistant" />
      </VStack>
    );
  }

  if (assistant.readyModels.length === 0) {
    return (
      <VStack gap={4} padding={4} height="100%">
        <Heading level={1}>Assistant</Heading>
        <EmptyState
          title="No model downloaded yet"
          description="The assistant runs a local model on this machine. Download one to get started."
          headingLevel={2}
          actions={
            <RouterLink to="/models">
              <Button label="Go to Models" variant="primary" />
            </RouterLink>
          }
        />
      </VStack>
    );
  }

  const hasModel = assistant.activeModelId !== null;
  const activeRecord =
    assistant.readyModels.find((record) => record.id === assistant.activeModelId) ?? null;
  const activeSmokeTest = activeRecord ? readSmokeTest(activeRecord) : null;

  return (
    <HStack gap={0} height="100%">
      <ThreadSidebar assistant={assistant} />

      <StackItem size="fill">
        <VStack gap={3} padding={4} height="100%">
          <HStack gap={3} hAlign="between" vAlign="center" wrap="wrap">
            <VStack gap={0.5}>
              <Heading level={1}>Assistant</Heading>
              <Text type="supporting">
                Reads your invoices and clients locally. Any change it wants to make needs your approval.
              </Text>
            </VStack>
            {/*
              An untested model is still selectable — the smoke test is advice,
              not a gate — but the label says so, because "it loaded" and "it
              generates tokens at a usable speed" are different claims.
            */}
            <Selector
              label="Model"
              isLabelHidden
              placeholder="Choose a model"
              options={assistant.readyModels.map((record) => ({
                value: record.id,
                label: `${record.id} · ${describeSmokeTest(readSmokeTest(record))}`,
              }))}
              value={assistant.activeModelId ?? undefined}
              onChange={(value) => {
                void assistant.selectModel(value);
              }}
            />
          </HStack>

          {assistant.error ? (
            <Banner
              status="error"
              title="The assistant hit a problem"
              description={assistant.error}
              isDismissable
              onDismiss={assistant.dismissError}
            />
          ) : null}

          {!hasModel ? (
            <Banner
              status="warning"
              title="No model is loaded"
              description="Pick a downloaded model above before sending a message."
            />
          ) : null}

          {hasModel && activeSmokeTest === null ? (
            <Banner
              status="warning"
              title="This model has not been tested on this machine"
              description="It is loaded and usable, but nobody has measured whether it generates at a usable speed here. Run “Test on my machine” on the Models page to find out."
            />
          ) : null}

          {activeSmokeTest?.verdict === 'fail' ? (
            <Banner
              status="warning"
              title="This model failed its last test on this machine"
              description={activeSmokeTest.error ?? 'The recorded run did not produce output.'}
            />
          ) : null}

          <StackItem size="fill" isScrollable>
            <Transcript assistant={assistant} />
          </StackItem>

          <ChatComposer
            value={draft}
            onChange={setDraft}
            placeholder="Ask about invoices, clients, or totals…"
            isDisabled={!hasModel}
            isStopShown={assistant.isStreaming}
            onStop={() => {
              void assistant.stop();
            }}
            onSubmit={(value) => {
              setDraft('');
              void assistant.send(value);
            }}
          />
        </VStack>
      </StackItem>
    </HStack>
  );
}

// ---------------------------------------------------------------------------

interface AssistantProps {
  readonly assistant: ReturnType<typeof useAssistant>;
}

function ThreadSidebar({ assistant }: AssistantProps): React.JSX.Element {
  return (
    <VStack gap={2} padding={3} width={240} isScrollable>
      <Button
        label="New conversation"
        variant="secondary"
        width="100%"
        onClick={() => {
          assistant.newThread();
        }}
      />

      {assistant.threads.length === 0 ? (
        <Text type="supporting">No conversations yet.</Text>
      ) : (
        assistant.threads.map((thread) => (
          <Button
            key={thread.id}
            label={thread.title ?? 'Untitled conversation'}
            variant={assistant.threadId === thread.id ? 'primary' : 'ghost'}
            width="100%"
            onClick={() => {
              assistant.selectThread(thread.id);
            }}
          />
        ))
      )}
    </VStack>
  );
}

function Transcript({ assistant }: AssistantProps): React.JSX.Element {
  const visible = assistant.messages.filter((message) => message.role !== 'system');

  if (visible.length === 0 && !assistant.isStreaming) {
    return (
      <EmptyState
        title="Ask the assistant something"
        description={'Try: "Which invoices are overdue?" or "Create a client called Acme Consulting".'}
        headingLevel={2}
        isCompact
      />
    );
  }

  return (
    <ChatMessageList isStreaming={assistant.isStreaming}>
      {visible.map((message) => (
        <MessageRow key={message.id} message={message} assistant={assistant} />
      ))}

      {assistant.isStreaming ? (
        <ChatMessageRow sender="assistant" name="Assistant">
          <Text>{assistant.streamingText.length > 0 ? assistant.streamingText : 'Thinking…'}</Text>
        </ChatMessageRow>
      ) : null}
    </ChatMessageList>
  );
}

function MessageRow({
  message,
  assistant,
}: {
  readonly message: ChatMessage;
  readonly assistant: ReturnType<typeof useAssistant>;
}): React.JSX.Element {
  const calls = parseToolCalls(message);

  if (message.role === 'tool') {
    return (
      <ChatMessageRow sender="system">
        <Card padding={2} variant="muted">
          <VStack gap={1}>
            <Text type="supporting">Tool result</Text>
            <Text type="code" maxLines={6}>
              {message.content}
            </Text>
          </VStack>
        </Card>
      </ChatMessageRow>
    );
  }

  const sender = message.role === 'user' ? 'user' : 'assistant';

  return (
    <ChatMessageRow sender={sender} name={message.role === 'user' ? 'You' : 'Assistant'}>
      <VStack gap={2}>
        {message.content.length > 0 ? <Text>{message.content}</Text> : null}
        {calls.map((call) => (
          <ToolCallCard
            key={call.id}
            call={call}
            isPending={assistant.pendingApprovals.some((pending) => pending.id === call.id)}
            isBusy={assistant.isStreaming}
            onDecide={(decision) => {
              void assistant.decide(call.id, decision);
            }}
          />
        ))}
      </VStack>
    </ChatMessageRow>
  );
}

function ToolCallCard({
  call,
  isPending,
  isBusy,
  onDecide,
}: {
  readonly call: ToolCallRecord;
  readonly isPending: boolean;
  readonly isBusy: boolean;
  readonly onDecide: (decision: 'approve' | 'reject') => void;
}): React.JSX.Element {
  const badge =
    call.status === 'executed'
      ? { variant: 'success' as const, label: 'Ran' }
      : call.status === 'rejected'
        ? { variant: 'neutral' as const, label: 'Rejected' }
        : call.status === 'failed'
          ? { variant: 'error' as const, label: 'Failed' }
          : { variant: 'warning' as const, label: 'Needs approval' };

  return (
    <Card padding={3} variant={isPending ? 'default' : 'muted'}>
      <VStack gap={2}>
        <HStack gap={2} vAlign="center" wrap="wrap">
          <Badge variant={badge.variant} label={badge.label} />
          <Text weight="semibold">{call.name}</Text>
        </HStack>

        <Text>{call.summary}</Text>

        {call.error ? <Text type="supporting">{call.error}</Text> : null}

        <Text type="code" maxLines={4}>
          {JSON.stringify(call.arguments)}
        </Text>

        {isPending ? (
          <HStack gap={2}>
            <Button
              label="Approve"
              variant="primary"
              isDisabled={isBusy}
              onClick={() => {
                onDecide('approve');
              }}
            />
            <Button
              label="Reject"
              variant="secondary"
              isDisabled={isBusy}
              onClick={() => {
                onDecide('reject');
              }}
            />
          </HStack>
        ) : null}
      </VStack>
    </Card>
  );
}
