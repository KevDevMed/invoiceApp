/**
 * The floating assistant dock: a launcher pinned bottom-right on every route
 * except `/settings`, and the compact chat panel it opens.
 *
 * This is an *additional* surface, not a replacement for `/assistant`. Both
 * read the same `useAssistantContext()`, mounted once by `AppShell`, so the
 * threads, the transcript and the in-flight stream are literally the same
 * objects. Open the dock mid-answer, navigate to the page, and the tokens keep
 * landing in both.
 *
 * Why the chat body is written out again here rather than imported from
 * `features/assistant/index.tsx`: that file belongs to another builder and is
 * not ours to change. Lifting its internals into a shared component would mean
 * editing it. So the dock composes the same Astryx `Chat*` primitives against
 * the same state, and stays deliberately smaller than the page — no thread
 * rail, no model selector, no page header. "Open full assistant" covers
 * everything left out.
 *
 * The one thing that is *not* smaller is the tool-call approval card. A
 * mutating call renders with its exact action and explicit Approve / Reject
 * buttons here exactly as it does on the page, wrapped in the loudest beam in
 * the set. A dock that let a mutation through on weaker evidence than the page
 * would be a security regression wearing a convenience feature's clothes.
 *
 * Every decision this file makes about *which* beam or *whether* to mount at
 * all lives in `./dockVisibility`, which is pure and unit-tested — the root
 * vitest project is `environment: 'node'` and cannot mount React.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { Badge } from '@astryxdesign/core/Badge';
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
import { Icon } from '@astryxdesign/core/Icon';
import { usePopover } from '@astryxdesign/core/Popover';
import { Section } from '@astryxdesign/core/Section';
import { Spinner } from '@astryxdesign/core/Spinner';
import { HStack, StackItem, VStack } from '@astryxdesign/core/Stack';
import { Text } from '@astryxdesign/core/Text';

import type { ChatMessage } from '../../shared/types';
import { availabilityCopy } from '../features/assistant/availability';
import { hasTranscriptContent, visibleMessages } from '../features/assistant/transcript';
import {
  parseToolCalls,
  useAssistantContext,
  type AssistantState,
  type ToolCallRecord,
} from '../features/assistant/useAssistant';
import { AppBeam } from './beam';
import {
  isReplyUnread,
  latestReplyId,
  launcherBeam,
  panelBeam,
  type DockReadCursor,
} from './dockVisibility';

/**
 * The launcher glyph. The design system's 26 semantic icon names have no
 * "assistant", and the Icon docs sanction passing an SVG component directly.
 * Same conventions as the nav icons in `AppShell.tsx` — 24x24 viewBox,
 * currentColor, 1.5 stroke — so Icon can size and colour it like any other.
 */
function AssistantGlyph(props: React.SVGProps<SVGSVGElement>): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H9l-5 4z" />
      <path d="M9 10h6" />
    </svg>
  );
}

export function AssistantDock(): React.JSX.Element {
  const assistant = useAssistantContext();
  const [draft, setDraft] = useState('');
  const [isComposerFocused, setIsComposerFocused] = useState(false);

  /*
    "Unread" is a dock-only idea: the `/assistant` route is never closed, so
    `useAssistant` has no notion of it and the dock has to keep its own cursor.
    It is a cursor rather than a boolean flag flipped by an effect because
    deriving the answer during render is the only version with no cascading
    re-render — see `isReplyUnread` in ./dockVisibility for the rules.
  */
  const [cursor, setCursor] = useState<DockReadCursor>({ threadId: null, messageId: null });
  const replyId = latestReplyId(assistant.messages);

  /*
    The cursor is stamped from callbacks (below), which fire outside render and
    would otherwise close over whatever the transcript looked like when the
    popover was created. A ref written in an effect is the sanctioned way to
    hand an event handler the current value without re-subscribing it.
  */
  const liveCursor = useRef<DockReadCursor>({ threadId: null, messageId: null });
  useEffect(() => {
    liveCursor.current = { threadId: assistant.threadId, messageId: replyId };
  }, [assistant.threadId, replyId]);

  // Opening the panel is reading it; so is closing it, since everything that
  // arrived while it was open was on screen. Stamped on both edges so Escape
  // and the close button behave the same as the launcher.
  const markSeen = useCallback(() => {
    setCursor(liveCursor.current);
  }, []);

  /*
    A persistent dock, not a menu. Each of these is a deliberate departure from
    `usePopover`'s defaults, and each default would be actively wrong here:

    - hasLightDismiss: false — the default closes the popover on any outside
      click. A chat panel that vanishes when the user clicks the invoice row
      they are asking about is not a dock; the whole point is that it survives
      the user working behind it.
    - isModal: false — the default marks the dialog aria-modal, which tells
      assistive tech the rest of the app is unavailable. It isn't. The user is
      expected to keep using the app with the chat open.
    - hasEscapeDismiss: true — nominally the default, but stated explicitly
      because it only becomes *our* behaviour once light dismiss is off: with
      light dismiss on, Escape closing is the browser's native popover=auto
      behaviour rather than the hook's.
    - dialogLabel — the panel has no visible heading element to name it, so
      without this the dialog announces as unlabelled.
    - hasSurface: false — the default paints a background, radius and shadow on
      the hook's own wrapper. The dock's surface is the `Card` inside the beam;
      two stacked surfaces would put the beam's border *inside* a visible edge.
  */
  const { triggerRef, triggerProps, render, toggle, hide, isOpen } = usePopover({
    dialogLabel: 'Assistant chat',
    closeButtonLabel: 'Close the assistant chat',
    hasLightDismiss: false,
    hasEscapeDismiss: true,
    isModal: false,
    hasSurface: false,
    onShow: markSeen,
    onHide: markSeen,
  });

  const launcherPreset = launcherBeam({
    isOpen,
    isStreaming: assistant.isStreaming,
    pendingApprovalCount: assistant.pendingApprovals.length,
    hasUnreadReply: isReplyUnread({
      isOpen,
      threadId: assistant.threadId,
      latestReplyId: replyId,
      cursor,
    }),
  });

  return (
    /*
      The fixed positioning lives on this Stack rather than on the AppBeam.
      `border-beam` injects `[data-beam="…"] { position: relative }` in a
      <style> tag mounted with the component, i.e. after global.css in document
      order and at the same specificity as a class — it would win, and the
      launcher would sit in the flow. A separate positioned parent is immune.
    */
    <VStack className="assistant-dock-launcher" gap={0}>
      <AppBeam preset={launcherPreset}>
        <Button
          ref={triggerRef}
          className="assistant-dock-launcher-button"
          label={isOpen ? 'Close the assistant' : 'Open the assistant'}
          tooltip={isOpen ? 'Close the assistant' : 'Open the assistant'}
          icon={<Icon icon={AssistantGlyph} size="sm" />}
          isIconOnly
          size="lg"
          variant="primary"
          onClick={toggle}
          {...triggerProps}
        />
      </AppBeam>

      {render(
        <AppBeam preset={panelBeam(assistant.isStreaming)}>
          <Card className="assistant-dock-panel" padding={0} variant="default">
            <VStack gap={0} height="100%">
              <StackItem size="static">
                <HStack gap={2} paddingInline={3} paddingBlock={2} align="center">
                  <StackItem size="fill">
                    <Text weight="semibold">Assistant</Text>
                  </StackItem>
                  {/*
                    A link, not a button: everything the compact body omits —
                    threads, model choice, the smoke-test warnings — is one
                    click away on the full route, which is why the dock is
                    allowed to stay this small.
                  */}
                  <Button
                    label="Open full assistant"
                    variant="ghost"
                    size="sm"
                    href="#/assistant"
                    onClick={hide}
                  />
                  <Button
                    label="Close"
                    variant="ghost"
                    size="sm"
                    onClick={hide}
                  />
                </HStack>
                <Divider />
              </StackItem>

              <StackItem size="fill">
                <DockBody
                  assistant={assistant}
                  draft={draft}
                  onDraftChange={setDraft}
                  isComposerFocused={isComposerFocused}
                  onComposerFocusChange={setIsComposerFocused}
                />
              </StackItem>
            </VStack>
          </Card>
        </AppBeam>,
        // Above and end-aligned: the launcher is pinned to the bottom-right
        // corner, so this is the only pair that opens into the window.
        { placement: 'above', alignment: 'end' },
      )}
    </VStack>
  );
}

// ---------------------------------------------------------------------------

interface DockBodyProps {
  readonly assistant: AssistantState;
  readonly draft: string;
  readonly onDraftChange: (value: string) => void;
  readonly isComposerFocused: boolean;
  readonly onComposerFocusChange: (isFocused: boolean) => void;
}

/**
 * One branch per `availability` state. Each is rendered honestly: the browser
 * preview is a missing capability, not an error, and gets no red banner.
 * Whatever this returns, the launcher above stays on screen — the dock is the
 * app's permanent affordance for "ask the assistant", even where the answer is
 * "not on this platform".
 */
function DockBody({
  assistant,
  draft,
  onDraftChange,
  isComposerFocused,
  onComposerFocusChange,
}: DockBodyProps): React.JSX.Element {
  /*
    Checked before loading, matching `availability`'s own precedence: once the
    host has refused an `llm:*` call, no amount of spinning produces a model.
  */
  if (assistant.availability === 'desktop-only') {
    const copy = availabilityCopy('desktop-only');
    return (
      <DockChat
        assistant={assistant}
        draft={draft}
        onDraftChange={onDraftChange}
        isComposerFocused={isComposerFocused}
        onComposerFocusChange={onComposerFocusChange}
        // Not disabled as a punishment — there is nothing on the other end of
        // the send button in a browser, and a composer that accepts text it
        // can never answer is a lie.
        isComposerDisabled
        emptyState={
          <EmptyState
            title={copy.title}
            description={copy.description}
            headingLevel={2}
            isCompact
          />
        }
      />
    );
  }

  if (assistant.availability === 'loading') {
    return (
      <VStack gap={3} padding={5} height="100%" vAlign="center" hAlign="center">
        <Spinner label={availabilityCopy('loading').title} />
      </VStack>
    );
  }

  if (assistant.availability === 'no-model' || assistant.availability === 'no-selection') {
    const copy = availabilityCopy(assistant.availability);
    return (
      <VStack gap={3} padding={4} height="100%" vAlign="center">
        <EmptyState
          title={copy.title}
          description={copy.description}
          headingLevel={2}
          isCompact
          actions={<Button label="Go to Models" variant="primary" href="#/models" />}
        />
      </VStack>
    );
  }

  return (
    <DockChat
      assistant={assistant}
      draft={draft}
      onDraftChange={onDraftChange}
      isComposerFocused={isComposerFocused}
      onComposerFocusChange={onComposerFocusChange}
      emptyState={
        <EmptyState
          title="Ask the assistant"
          description='Try: "Which invoices are overdue?"'
          headingLevel={2}
          isCompact
        />
      }
    />
  );
}

function DockChat({
  assistant,
  draft,
  onDraftChange,
  isComposerFocused,
  onComposerFocusChange,
  emptyState,
  isComposerDisabled = false,
}: DockBodyProps & {
  readonly emptyState: React.ReactNode;
  readonly isComposerDisabled?: boolean;
}): React.JSX.Element {
  /*
    Decided out here, not inside `<DockTranscript/>`: `ChatLayout` swaps in its
    `emptyState` only when `children` is literally `null`, and a component that
    returns `null` is still a non-null element. Same rule the page follows —
    see `features/assistant/transcript.ts`.
  */
  const hasTranscript = hasTranscriptContent(assistant.messages, assistant.isStreaming);

  return (
    <ChatLayout
      emptyState={emptyState}
      composer={
        /*
          `active` rather than a conditional preset: `AppBeam` keeps the element
          mounted and its colours static when inactive, so focusing the input
          lights the beam without the composer jumping by a border width.
        */
        <AppBeam preset="composer-focus" active={isComposerFocused}>
          {/*
            ChatComposer has no focus callbacks, so the focus/blur pair is
            captured on the wrapper. The `relatedTarget` check keeps the beam lit
            while focus moves *within* the composer (input to send button).
          */}
          <VStack
            gap={0}
            onFocusCapture={() => {
              onComposerFocusChange(true);
            }}
            onBlurCapture={(event) => {
              const next = event.relatedTarget;
              if (!(next instanceof Node) || !event.currentTarget.contains(next)) {
                onComposerFocusChange(false);
              }
            }}
          >
            <ChatComposer
              value={draft}
              onChange={onDraftChange}
              density="compact"
              placeholder="Ask about invoices or clients…"
              isDisabled={isComposerDisabled}
              isStopShown={assistant.isStreaming}
              onStop={() => {
                void assistant.stop();
              }}
              onSubmit={(value) => {
                onDraftChange('');
                void assistant.send(value);
              }}
            />
          </VStack>
        </AppBeam>
      }
    >
      {hasTranscript ? <DockTranscript assistant={assistant} /> : null}
    </ChatLayout>
  );
}

/** Only mounted when there is something to draw — see `DockChat`. */
function DockTranscript({ assistant }: { readonly assistant: AssistantState }): React.JSX.Element {
  return (
    <ChatMessageList isStreaming={assistant.isStreaming} density="compact">
      {visibleMessages(assistant.messages).map((message) => (
        <DockMessageRow key={message.id} message={message} assistant={assistant} />
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

function DockMessageRow({
  message,
  assistant,
}: {
  readonly message: ChatMessage;
  readonly assistant: AssistantState;
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
            <Text type="code" maxLines={3}>
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
          <ChatMessageBubble variant={isUser ? 'filled' : 'ghost'} name={isUser ? 'You' : 'Assistant'}>
            <Text>{message.content}</Text>
          </ChatMessageBubble>
        ) : null}
        {calls.map((call) => (
          <DockToolCallCard
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

/**
 * The approval card, at full strength.
 *
 * Everything else in the dock is a trimmed version of the page. This is not:
 * the tool name, the human summary and the exact arguments are all shown, and
 * nothing runs until Approve is pressed. The `approval-pending` beam is the
 * loudest sustained signal the app has, and it is here because a mutation
 * scrolling past unnoticed in a small corner panel is the specific failure this
 * surface makes easier.
 */
function DockToolCallCard({
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

  const card = (
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

  // Only the waiting card wears the beam. A card that already ran or was
  // rejected is history, and history that glows is noise.
  return isPending ? <AppBeam preset="approval-pending">{card}</AppBeam> : card;
}
