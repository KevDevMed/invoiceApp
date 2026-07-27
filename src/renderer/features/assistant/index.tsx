/**
 * Assistant feature barrel — the `/assistant` route.
 *
 * `AssistantPage` is the name `routes.tsx` imports; everything else in this
 * directory is ours. The page is deliberately blunt about the safety model: a
 * mutating tool call is rendered as an approval card with the exact action
 * spelled out, and nothing runs until the user presses Approve.
 *
 * Layout: a hairline-separated thread rail, then the chat column carrying the
 * shared `PageHeader`. `ChatLayout` owns the scroll region and the docked
 * composer so the message rhythm is the design system's, not ours.
 */

import { useState } from 'react';
import { Link as RouterLink } from 'react-router';

import { Badge } from '@astryxdesign/core/Badge';
import { Banner } from '@astryxdesign/core/Banner';
import { Button } from '@astryxdesign/core/Button';
import { Card } from '@astryxdesign/core/Card';
import {
  ChatComposer,
  ChatLayout,
  ChatMessage as ChatMessageRow,
  ChatMessageBubble,
  ChatMessageList,
} from '@astryxdesign/core/Chat';
import { Divider } from '@astryxdesign/core/Divider';
import { EmptyState } from '@astryxdesign/core/EmptyState';
import { List, ListItem } from '@astryxdesign/core/List';
import { Section } from '@astryxdesign/core/Section';
import { Selector } from '@astryxdesign/core/Selector';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { ChatMessage } from '../../../shared/types';
import { Page, PageHeader } from '../../ui/Page';
import { describeSmokeTest, readSmokeTest } from '../models/llmExtra';
import { hasTranscriptContent, visibleMessages } from './transcript';
import { parseToolCalls, useAssistant, type ToolCallRecord } from './useAssistant';

const DESCRIPTION =
  'Reads your invoices and clients locally. Any change it wants to make needs your approval.';

export function AssistantPage(): React.JSX.Element {
  const assistant = useAssistant();
  const [draft, setDraft] = useState('');

  if (assistant.isLoading) {
    return (
      <VStack gap={4} padding={6} height="100%" vAlign="center" hAlign="center">
        <Spinner label="Loading the assistant" />
      </VStack>
    );
  }

  if (assistant.readyModels.length === 0) {
    return (
      <Page>
        <PageHeader title="Assistant" description={DESCRIPTION} />
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
      </Page>
    );
  }

  const hasModel = assistant.activeModelId !== null;
  /*
    Decided here, not inside `<Transcript/>`: `ChatLayout` renders its empty
    state only when `children` is `null`, and an element that returns `null`
    is still an element. See `transcript.ts`.
  */
  const hasTranscript = hasTranscriptContent(assistant.messages, assistant.isStreaming);
  const activeRecord =
    assistant.readyModels.find((record) => record.id === assistant.activeModelId) ?? null;
  const activeSmokeTest = activeRecord ? readSmokeTest(activeRecord) : null;

  return (
    <HStack gap={0} height="100%">
      <ThreadSidebar assistant={assistant} />
      <Divider orientation="vertical" />

      <StackItem size="fill">
        <VStack gap={5} paddingInline={6} paddingBlock={5} height="100%">
          <PageHeader
            title="Assistant"
            description={DESCRIPTION}
            actions={
              /*
                An untested model is still selectable — the smoke test is advice,
                not a gate — but the label says so, because "it loaded" and "it
                generates tokens at a usable speed" are different claims.
              */
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
            }
          />

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

          <StackItem size="fill">
            <ChatLayout
              emptyState={
                <EmptyState
                  title="Ask the assistant something"
                  description={
                    'Try: "Which invoices are overdue?" or "Create a client called Acme Consulting".'
                  }
                  headingLevel={2}
                  isCompact
                />
              }
              composer={
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
              }
            >
              {hasTranscript ? <Transcript assistant={assistant} /> : null}
            </ChatLayout>
          </StackItem>
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
    <VStack gap={3} paddingInline={4} paddingBlock={5} width={260} isScrollable>
      <Button
        label="New conversation"
        variant="secondary"
        width="100%"
        onClick={() => {
          assistant.newThread();
        }}
      />

      {assistant.threads.length === 0 ? (
        <Text type="supporting" display="block">
          No conversations yet.
        </Text>
      ) : (
        <List density="compact">
          {assistant.threads.map((thread) => (
            <ListItem
              key={thread.id}
              label={thread.title ?? 'Untitled conversation'}
              isSelected={assistant.threadId === thread.id}
              onClick={() => {
                assistant.selectThread(thread.id);
              }}
            />
          ))}
        </List>
      )}
    </VStack>
  );
}

/** Only mounted when there is something to draw — see `AssistantPage`. */
function Transcript({ assistant }: AssistantProps): React.JSX.Element {
  const visible = visibleMessages(assistant.messages);

  return (
    <ChatMessageList isStreaming={assistant.isStreaming} density="spacious">
      {visible.map((message) => (
        <MessageRow key={message.id} message={message} assistant={assistant} />
      ))}

      {assistant.isStreaming ? (
        <ChatMessageRow sender="assistant">
          <ChatMessageBubble variant="ghost" name="Assistant">
            <Text>{assistant.streamingText.length > 0 ? assistant.streamingText : 'Thinking…'}</Text>
          </ChatMessageBubble>
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
        <Section variant="muted" padding={2}>
          <VStack gap={1}>
            <Text type="supporting" display="block">
              Tool result
            </Text>
            <Text type="code" maxLines={6}>
              {message.content}
            </Text>
          </VStack>
        </Section>
      </ChatMessageRow>
    );
  }

  const isUser = message.role === 'user';

  return (
    <ChatMessageRow sender={isUser ? 'user' : 'assistant'}>
      <VStack gap={2}>
        {message.content.length > 0 ? (
          <ChatMessageBubble
            variant={isUser ? 'filled' : 'ghost'}
            name={isUser ? 'You' : 'Assistant'}
          >
            <Text>{message.content}</Text>
          </ChatMessageBubble>
        ) : null}
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
        <HStack gap={2} align="center" wrap="wrap">
          <Badge variant={badge.variant} label={badge.label} />
          <Text weight="semibold">{call.name}</Text>
        </HStack>

        <Text>{call.summary}</Text>

        {call.error ? (
          <Text type="supporting" display="block">
            {call.error}
          </Text>
        ) : null}

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
