/**
 * The open-invoice tab strip, in the content column's title band.
 *
 * One pill per open document, the active one filled, a trailing `+` for a new
 * draft — the workflow the user asked for: "when the user opens a new invoice or
 * wants to see an invoice ... they can see these open in tabs".
 *
 * Every *decision* here is imported from `./invoiceTabsState`: route -> tab id, the
 * open/close/plus transitions, where the route goes after the active tab is
 * closed, and the label strings. This file is the DOM half only, because the
 * root vitest project is `environment: 'node'` and cannot mount it.
 *
 * ## Why Token in a Toolbar, and not TabList + Tab
 *
 * `Tab` is the semantically correct navigation component, and it cannot carry a
 * close button. `TabList/Tab.tsx` renders the whole tab as a single
 * `<button type="button">` (or an `<a>` with `href`) and puts `endContent`
 * *inside* it — so a close `<button>` in that slot is interactive content nested
 * inside interactive content: invalid HTML, an unreachable inner control in some
 * AT, and a click target that resolves to the outer button.
 *
 * `Token` is documented for exactly this anatomy (label, leading icon, trailing
 * slot) and, with `onClick`, renders "a `<span>` container with an invisible
 * `<button>` inside" — which is the escape from the nesting: the activation
 * button and the close button end up *siblings* in one span. Its container click
 * handler already ignores events whose target is inside a nested `button, a`, so
 * pressing close never also activates the tab. Token's own best practice says
 * not to use tokens for navigation; wrapping the strip in `Toolbar` is what
 * supplies the keyboard semantics Token lacks — `role="toolbar"` plus a roving
 * tabindex over `button, input, [tabindex]`, so arrow keys walk every pill and
 * every close control from one Tab stop.
 *
 * Two consequences of using Token, both deliberate:
 *
 *   - The close control is our own `<button>` in `endContent` rather than
 *     Token's `onRemove`. `onRemove`'s accessible name is fixed by the design
 *     system's message catalogue to `Remove {label}`, and this strip needs
 *     "Close invoice INV-0042" / "Close new invoice" — a name that says what is
 *     being closed and is distinct per tab. `endContent` sits in the same span,
 *     sibling to the activation button, so it costs nothing structurally.
 *   - `aria-current` is applied to the rendered activation button through a ref
 *     effect. Token destructures a fixed set of props and spreads no rest, so
 *     there is no way to pass an ARIA attribute through it, and the active tab
 *     has to be announced as more than a background colour.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';

import { Icon } from '@astryxdesign/core/Icon';
import { IconButton } from '@astryxdesign/core/IconButton';
import { Token } from '@astryxdesign/core/Token';
import { Toolbar } from '@astryxdesign/core/Toolbar';

import {
  closeTab,
  DRAFT_TAB_ID,
  forgetClosedLabels,
  labelRequestIsCurrent,
  NEW_TAB_BUTTON_LABEL,
  NO_DEPARTING_TABS,
  NO_LABEL_REQUESTS,
  pendingLabelIds,
  plusTransition,
  queueRoute,
  recordDeparture,
  recordNavigation,
  removeTab,
  retireClosedRequests,
  settleDepartures,
  settleLabelRequest,
  startLabelRequest,
  syncTabs,
  tabCloseLabel,
  tabIdForPath,
  tabLabel,
  tabRoute,
  TAB_STRIP_LABEL,
  type CloseFocusTarget,
  type InvoiceTabLabels,
  type LabelRequests,
} from './invoiceTabsState';

type GlyphProps = React.SVGProps<SVGSVGElement>;

const glyphProps = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

/** Saved invoice: the same document outline the nav's Invoices icon uses. */
function InvoiceTabIcon(props: GlyphProps): React.JSX.Element {
  return (
    <svg {...glyphProps} {...props}>
      <path d="M6 3h9l4 4v14H6z" />
      <path d="M15 3v4h4" />
    </svg>
  );
}

/** The unsaved draft: a nib, so the one tab that is not yet an invoice reads
 *  as being written rather than stored. */
function DraftTabIcon(props: GlyphProps): React.JSX.Element {
  return (
    <svg {...glyphProps} {...props}>
      <path d="M4 20h4l11-11-4-4L4 16z" />
      <path d="M14.5 5.5l4 4" />
    </svg>
  );
}

/** The trailing `+`. No semantic name in the design system's 26 means "add". */
function PlusIcon(props: GlyphProps): React.JSX.Element {
  return (
    <svg {...glyphProps} {...props}>
      <path d="M12 5v14M5 12h14" />
    </svg>
  );
}

/**
 * Focus, after the DOM has lost the button that had it.
 *
 * `closeFocusTarget` decides *where*; these three do the DOM half, and they are
 * here rather than in `invoiceTabsState.ts` for the reason that file's header gives.
 * Each returns whether focus actually landed, so the caller can retry once — the
 * `page` target can be one frame late when the close also changes route.
 */
function pillActivationButton(strip: HTMLElement, id: string): HTMLElement | null {
  // `data-invoice-tab` is set on the pill by `TabPill`'s ref effect: Token
  // forwards no rest props, so an attribute cannot be passed to it (see header).
  const pill = [...strip.querySelectorAll<HTMLElement>('[data-invoice-tab]')].find(
    (element) => element.dataset.invoiceTab === id,
  );
  return pill?.querySelector('button') ?? null;
}

/**
 * The id of the shell's main region — the skip link's target, and the one node in
 * the content column that survives every route change.
 *
 * The page's `h1` looks like the obvious target and is the wrong one: closing the
 * last tab navigates, and the incoming page's heading is a *different* element
 * that React swaps in a frame later, which drops focus straight back to `<body>`
 * (measured: `H1` at 0ms, `BODY` at 30ms). The main region is already the app's
 * declared "start of the content" landmark, and it does not move.
 */
const MAIN_REGION_ID = 'astryx-app-shell-main';

/** The page the close landed on, for when the strip itself is gone. */
function focusLandingPage(): boolean {
  const main = document.getElementById(MAIN_REGION_ID) ?? document.querySelector<HTMLElement>('h1');
  if (main === null) return false;
  /*
    A region is not a focus stop, so it becomes one for exactly as long as it holds
    focus. Leaving the attribute behind would add a permanent tab stop to the shell.
  */
  main.tabIndex = -1;
  const drop = (): void => main.removeAttribute('tabindex');
  main.addEventListener('blur', drop, { once: true });
  main.focus();
  if (document.activeElement === main) return true;
  /*
    Focus was refused, so no `blur` will ever come to undo the attribute — and a
    region left permanently `tabindex="-1"` is a permanent stray tab stop in the
    shell. The removal cannot be conditional on the focus having worked.
  */
  main.removeEventListener('blur', drop);
  drop();
  return false;
}

function moveFocusAfterClose(target: CloseFocusTarget): boolean {
  const strip = document.querySelector<HTMLElement>('.app-invoice-tabs');
  if (strip !== null && target.kind !== 'page') {
    if (target.kind === 'tab') {
      const button = pillActivationButton(strip, target.id);
      if (button !== null) {
        button.focus();
        if (document.activeElement === button) return true;
      }
    }
    // Neither neighbour survived but the strip did: the `+` is always there.
    const plus = strip.querySelector<HTMLElement>('.app-invoice-tabs-new');
    const plusButton = plus === null ? null : (plus.closest('button') ?? plus.querySelector('button') ?? plus);
    if (plusButton !== null) {
      plusButton.focus();
      if (document.activeElement === plusButton) return true;
    }
  }
  return focusLandingPage();
}

/** Everything the strip needs, and the only thing AppShell has to hold. */
export interface InvoiceTabsState {
  readonly tabs: readonly string[];
  /** Derived from the route, never stored — see `tabIdForPath`. */
  readonly activeId: string | null;
  readonly labels: InvoiceTabLabels;
  readonly select: (id: string) => void;
  readonly close: (id: string) => void;
  readonly openDraft: () => void;
}

/**
 * Tab state, owned by the shell.
 *
 * In memory only, for this round: the tabs survive route changes and not a
 * reload. Persisting them would mean persisting invoice ids, and an id deleted
 * in another session comes back on the next boot as a pill that opens a page
 * saying the invoice no longer exists — a dead tab the user has to close by
 * hand. Until the strip can validate ids against the database at startup, a
 * fresh window with no tabs is the honest state.
 *
 * Labels are cached per id in the same state, so re-activating a tab (or closing
 * a neighbour) never refetches: `pendingLabelIds` only ever returns ids with no
 * cached number and no request already accounted for, which is what keeps a second
 * render from firing the same fetch twice. See `LabelRequests` for the half of
 * that bookkeeping a close has to undo.
 */
export function useInvoiceTabs(): InvoiceTabsState {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [labels, setLabels] = useState<InvoiceTabLabels>({});
  /*
    Every close the router has not caught up with, by tab id, plus the route that
    releases them. Not one "pathname being left": N closes in one browser task are
    N queued departures, and the render that needs suppressing carries the *first*
    one's route while the batched writes hold only the last. See `DepartingTabs`.
  */
  const [departing, setDeparting] = useState(NO_DEPARTING_TABS);
  /*
    The three things a close needs that rendered state cannot give it, because two
    closes can happen in one browser task — before any re-render, so before either
    `tabs` or `useLocation` has moved. See `closeTab`.
  */
  const latestTabs = useRef<readonly string[]>(tabs);
  /*
    Every route the strip has navigated to in this browser task and the router has
    not reported yet — the event-phase mirror of `departing.routes`, because a close
    resolves inside the same task that queued the navigation, long before any state
    moves. Its last entry is where the router is headed, which is what decides
    whether a tab is active.

    Every path that navigates appends to it, not only `close`: a pill click that has
    not committed yet still means the rendered `pathname` is stale, and a close
    reading that stale route mistook the pill the user had just selected for an
    inactive tab — removing it with no replacement navigation, then watching the
    route sync put it straight back.
  */
  const queuedRoutes = useRef<readonly string[]>([]);
  const pendingFocus = useRef<CloseFocusTarget | null>(null);
  /** Label fetches in flight and the ones that came back empty. See
   *  `LabelRequests`: a ref, because no render depends on it. */
  const labelRequests = useRef<LabelRequests>(NO_LABEL_REQUESTS);
  const activeId = tabIdForPath(pathname);

  /*
    Arriving at a tabbable route that is not open yet appends its tab. This and
    the `+` are the only two ways a tab is created.

    Done during render, not in an effect: this is React's own "adjusting state
    when a prop changes" case (the prop being the route), and an effect would
    paint one frame with the new route and the old strip — the new invoice's page
    with no pill for it — before correcting itself. `settleDepartures` and
    `syncTabs` both return their *own* argument when nothing changes, so all three
    guards below are false on every ordinary render and no update can loop.

    Releasing the departures here rather than in an effect matters: it is the same
    render that decides the list, so a route the strip asked for can never both
    have landed and still be suppressed.
  */
  const settled = settleDepartures(departing, pathname);
  if (settled !== departing) setDeparting(settled);
  const openTabs = syncTabs(tabs, pathname, settled);
  if (openTabs !== tabs) setTabs(openTabs);
  /*
    A closed tab's number goes with it, in the same render for the same reason —
    and because dropping it in an effect instead means a cascading render whose
    only job is to forget something. `forgetClosedLabels` returns its own argument
    when there is nothing to drop, so this cannot loop either.
  */
  const openLabels = forgetClosedLabels(labels, openTabs);
  if (openLabels !== labels) setLabels(openLabels);

  // The list a close has to work from — kept level with what is rendered, and
  // moved forward by `close` itself for a second close in the same task.
  useEffect(() => {
    latestTabs.current = openTabs;
  }, [openTabs]);

  /*
    Once the router has committed *any* location, the render-derived `activeId` is
    authoritative again and nothing is queued. Two closes in one task both run
    before this fires, which is exactly the window `queuedRoutes` covers.
  */
  useEffect(() => {
    queuedRoutes.current = [];
  }, [pathname]);

  /*
    Focus, after the commit that removed the closed pill. A layout effect in the
    *hook* rather than in the strip, because the last close unmounts the strip
    altogether and its effects would never run.
  */
  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (target === null) return;
    if (moveFocusAfterClose(target)) {
      pendingFocus.current = null;
      return;
    }
    /*
      Nothing to focus yet: the page a last close navigated to can mount one
      commit later than the strip unmounts. The request is deliberately *not*
      cleared, so the commit that brings the new page in retries it — and a frame
      later it is dropped either way, so a close can never leave a request behind
      to fire at some unrelated later render. Not cancelled on cleanup: this
      effect re-runs on the very route change being waited for.
    */
    requestAnimationFrame(() => {
      const late = pendingFocus.current;
      if (late === null) return;
      pendingFocus.current = null;
      if (document.activeElement === null || document.activeElement === document.body) {
        moveFocusAfterClose(late);
      }
    });
  }, [openTabs, pathname]);

  useEffect(() => {
    /*
      Closing a tab retires everything remembered about it: the number is dropped
      during render above, and the request bookkeeping here — the mark that stops a
      dead fetch being retried, and the entry that lets a request still running
      write anything at all. Keeping either is what made one failed `invoices:get`
      poison an invoice for the life of the window: reopen the tab and it stayed
      labelled "Invoice" forever.
    */
    labelRequests.current = retireClosedRequests(labelRequests.current, openTabs);

    // Never twice for one id: an entry in `inFlight` covers the request a second
    // render would duplicate, and one in `failed` covers the dead fetch a render
    // loop would refire. Both are retired the moment the tab closes, above, so
    // reopening the tab genuinely does retry — which is the only reason a tab the
    // user is looking at is sure to end up with its real number on it.
    for (const id of pendingLabelIds(openTabs, openLabels, labelRequests.current)) {
      const started = startLabelRequest(labelRequests.current, id);
      labelRequests.current = started.requests;
      void (async () => {
        // Whether the request came back with nothing — a missing invoice or a
        // throw. Either way the placeholder stays and the tab is not closed: the
        // tab is the user's, and a pill vanishing under the pointer is worse than
        // one labelled "Invoice".
        let number: string | null = null;
        try {
          const invoice = await window.api.invoke('invoices:get', { id });
          number = invoice ? invoice.number : null;
        } catch {
          number = null;
        }
        /*
          The tab can have closed — and been reopened — while this was in flight.
          Then this request speaks for nobody: its label would cache a number for a
          pill that no longer exists, and its failure mark would land on a tab the
          close cleanup has already run for, so nothing would ever clear it and the
          reopened pill would read "Invoice" for the life of the window. The reopen
          fired its own request; that one answers.
        */
        if (!labelRequestIsCurrent(labelRequests.current, id, started.token)) return;
        labelRequests.current = settleLabelRequest(labelRequests.current, id, number === null);
        // The token is still current on the one commit between a close and the
        // effect that retires it, so the list is checked too rather than spending
        // a render writing a label `forgetClosedLabels` drops again.
        if (number !== null && latestTabs.current.includes(id)) {
          setLabels((previous) => ({ ...previous, [id]: number }));
        }
      })();
    }
  }, [openTabs, openLabels]);

  return {
    tabs: openTabs,
    activeId,
    labels: openLabels,
    select: (id) => {
      const route = tabRoute(id);
      // Registered before the navigation, so a close later in this same task
      // classifies the tab against where the router is going, and so this route
      // counts as one the task explains rather than an outside navigation.
      queuedRoutes.current = queueRoute(queuedRoutes.current, route);
      setDeparting((previous) => recordNavigation(previous, route));
      void navigate(route);
    },
    close: (id) => {
      /*
        Resolved against the refs, not against this render: two closes in one
        browser task both run here before React re-renders, and the second one has
        to see the first one's list *and* the first one's queued navigation.
      */
      const queued = queuedRoutes.current.at(-1) ?? null;
      const outcome = closeTab(latestTabs.current, id, pathname, queued);
      if (outcome.tabs === latestTabs.current) return;
      latestTabs.current = outcome.tabs;
      pendingFocus.current = outcome.focus;
      /*
        The whole of what this close writes to the list: drop `id` from whatever
        React supplies. Route and focus are `outcome`'s, decided once against the
        latest list — re-running the transition in here re-derives the active tab
        from a `previous` it was never resolved against, which is how one of two
        same-task closes ended up applied to the wrong id.
      */
      setTabs((previous) => removeTab(previous, id));
      if (outcome.route !== null) {
        queuedRoutes.current = queueRoute(queuedRoutes.current, outcome.route);
        void navigate(outcome.route);
      }
      /*
        Suppress the sync for this tab until the router reports the route the strip
        is heading for, or it is re-appended from the route it is still on. The
        routes accounted for are where this close is leaving from plus every route
        the task has queued — including the ones queued before it, so a pill click
        in the same task is not later mistaken for somebody else navigating.
      */
      setDeparting((previous) =>
        recordDeparture(previous, id, [pathname, ...queuedRoutes.current], outcome.settleRoute),
      );
    },
    openDraft: () => {
      const next = plusTransition(latestTabs.current);
      latestTabs.current = next.tabs;
      setTabs(next.tabs);
      const route = next.route ?? tabRoute(DRAFT_TAB_ID);
      queuedRoutes.current = queueRoute(queuedRoutes.current, route);
      setDeparting((previous) => recordNavigation(previous, route));
      void navigate(route);
    },
  };
}

function TabPill({
  id,
  label,
  closeLabel,
  isActive,
  onSelect,
  onClose,
}: {
  id: string;
  label: string;
  closeLabel: string;
  isActive: boolean;
  onSelect: () => void;
  onClose: () => void;
}): React.JSX.Element {
  const root = useRef<HTMLElement>(null);

  /*
    `aria-current="page"` on the activation button, set here because Token
    forwards no rest props (see this file's header). The first `<button>` inside
    the token's span is the invisible activation button — the icon before it is a
    plain span and the close button comes after it.
  */
  useLayoutEffect(() => {
    const pill = root.current;
    if (!pill) return;
    // Which tab this pill is, for the focus handoff after a close — same reason
    // as `aria-current`: nothing can be passed through Token as a prop.
    pill.dataset.invoiceTab = id;
    const button = pill.querySelector('button');
    if (!button) return;
    if (isActive) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }, [id, isActive, label]);

  /*
    Where this pill last parked the strip, or `null` when it does not own the
    scroll position — see the effect below.
  */
  const parkedAt = useRef<number | null>(null);

  /*
    The pills scroll now (see `flex: none` in `global.css`), so the active one has
    to be brought into the scroller's view — otherwise opening an eleventh invoice
    puts its own pill off the end of the strip.

    Its own effect, and the reason it is not simply "scroll whenever anything
    re-renders" is measured: sharing the `aria-current` effect above meant a slow
    `invoices:get` arriving 1.8s after the user had scrolled the strip back to the
    oldest tabs threw the viewport to the far end, with the active tab never having
    changed. A number arriving is not a reason to move the viewport.

    But it is a reason to *correct* one. `INV-0047` is wider than the `Invoice`
    placeholder it replaces, so a pill scrolled flush with the scroller's right
    edge while it was still waiting for its number ends up 12px past that edge
    once the number lands (measured, twenty tabs at 1600px: `scrollLeft` 951 where
    963 was needed, active pill right 1565.94 against a scroller right of 1554).
    So the rule is ownership: becoming active claims the scroll position, and after
    that this pill may only re-align itself while the strip is *still* parked where
    it put it. Anything else — the user's own scroll, the resize observer in
    `InvoiceTabs` — takes ownership away, and a label then changes nothing.
  */
  useLayoutEffect(() => {
    const pill = root.current;
    const scroller = pill?.closest('.app-invoice-tabs-scroller');
    if (!(pill instanceof HTMLElement) || !(scroller instanceof HTMLElement)) return;
    if (!isActive) {
      parkedAt.current = null;
      return;
    }
    if (parkedAt.current !== null && scroller.scrollLeft !== parkedAt.current) return;
    pill.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    parkedAt.current = scroller.scrollLeft;
  }, [isActive, label]);

  return (
    <Token
      ref={root}
      className={`app-invoice-tab${isActive ? ' app-invoice-tab-active' : ''}`}
      label={label}
      icon={
        <Icon icon={id === DRAFT_TAB_ID ? DraftTabIcon : InvoiceTabIcon} size="xsm" color="inherit" />
      }
      onClick={onSelect}
      endContent={
        <button
          type="button"
          className="app-invoice-tab-close"
          aria-label={closeLabel}
          onClick={(event) => {
            // Token's container handler ignores targets inside a nested button,
            // so this only stops the event reaching anything above the strip.
            event.stopPropagation();
            onClose();
          }}
        >
          <Icon icon="close" size="xsm" color="inherit" />
        </button>
      }
    />
  );
}

/**
 * The strip. Renders nothing at all with no tabs open, which is what keeps the
 * band on Settings the empty reserved drag surface it has always been — and
 * keeps a stray `+` off every page that has no invoices open.
 */
export function InvoiceTabs({ state }: { state: InvoiceTabsState }): React.JSX.Element | null {
  const scroller = useRef<HTMLDivElement>(null);

  /*
    Narrowing the window shrinks the scroller, and the active pill can end up past
    its edge — the pill for the invoice on screen, unreachable. `TabPill` only
    scrolls itself into view when the *state* changes, so the size change needs its
    own observer.
  */
  useEffect(() => {
    const box = scroller.current;
    if (box === null) return;
    const observer = new ResizeObserver(() => {
      box
        .querySelector('.app-invoice-tab-active')
        ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    observer.observe(box);
    return () => {
      observer.disconnect();
    };
  }, [state.tabs.length]);

  if (state.tabs.length === 0) return null;

  return (
    <Toolbar
      label={TAB_STRIP_LABEL}
      size="sm"
      gap={0.5}
      className="app-invoice-tabs"
      startContent={
        <>
          {/*
            The pills scroll inside this box; the `+` below is its sibling, so it
            stays reachable however many tabs are open. A scroll container's
            minimum contribution in its scroll axis is zero, which is what lets
            the strip shrink instead of widening the shell — see the
            `:has(> .app-side-nav)` note in `styles/global.css` for what a few
            stray pixels of inline overflow cost.
          */}
          <div className="app-invoice-tabs-scroller" ref={scroller}>
            {state.tabs.map((id) => (
              <TabPill
                key={id}
                id={id}
                label={tabLabel(id, state.labels)}
                closeLabel={tabCloseLabel(id, state.labels)}
                isActive={id === state.activeId}
                onSelect={() => {
                  state.select(id);
                }}
                onClose={() => {
                  state.close(id);
                }}
              />
            ))}
          </div>
          <IconButton
            label={NEW_TAB_BUTTON_LABEL}
            tooltip={NEW_TAB_BUTTON_LABEL}
            variant="ghost"
            className="app-invoice-tabs-new"
            icon={<Icon icon={PlusIcon} size="sm" />}
            onClick={state.openDraft}
          />
        </>
      }
    />
  );
}
