/**
 * The open-invoice tab strip, in the content column's title band.
 *
 * One pill per open document, the active one filled, a trailing `+` for a new
 * draft — the workflow the user asked for: "when the user opens a new invoice or
 * wants to see an invoice ... they can see these open in tabs".
 *
 * Every *decision* here is imported from `./invoiceTabs`: route -> tab id, the
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
  NEW_TAB_BUTTON_LABEL,
  plusTransition,
  syncTabs,
  tabCloseLabel,
  tabIdForPath,
  tabLabel,
  tabRoute,
  TAB_STRIP_LABEL,
  unlabelledTabIds,
  type CloseFocusTarget,
  type InvoiceTabLabels,
} from './invoiceTabs';

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
 * here rather than in `invoiceTabs.ts` for the reason that file's header gives.
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
  main.addEventListener('blur', () => main.removeAttribute('tabindex'), { once: true });
  main.focus();
  return document.activeElement === main;
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
 * a neighbour) never refetches: `unlabelledTabIds` only ever returns ids with no
 * cached number, and `requested` keeps a second render from firing the same
 * fetch twice while the first is in flight.
 */
export function useInvoiceTabs(): InvoiceTabsState {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [tabs, setTabs] = useState<readonly string[]>([]);
  const [labels, setLabels] = useState<InvoiceTabLabels>({});
  /*
    The route a close is navigating away from, held until the router catches up.
    Without it, closing the active tab re-opens it: the shorter list renders one
    frame before the new location arrives, and on that frame the route still
    names the closed tab. See `syncTabs`.
  */
  const [closingPathname, setClosingPathname] = useState<string | null>(null);
  /*
    The three things a close needs that rendered state cannot give it, because two
    closes can happen in one browser task — before any re-render, so before either
    `tabs` or `useLocation` has moved. See `closeTab`.
  */
  const latestTabs = useRef<readonly string[]>(tabs);
  const queuedRoute = useRef<string | null>(null);
  const pendingFocus = useRef<CloseFocusTarget | null>(null);
  /** Label requests in flight, and ids whose request already failed. */
  const inFlight = useRef<Set<string>>(new Set());
  const failed = useRef<Set<string>>(new Set());
  const activeId = tabIdForPath(pathname);

  /*
    Arriving at a tabbable route that is not open yet appends its tab. This and
    the `+` are the only two ways a tab is created.

    Done during render, not in an effect: this is React's own "adjusting state
    when a prop changes" case (the prop being the route), and an effect would
    paint one frame with the new route and the old strip — the new invoice's page
    with no pill for it — before correcting itself. `syncTabs` returns the *same*
    array when nothing changes, so both guards below are false on every ordinary
    render and neither update can loop.
  */
  if (closingPathname !== null && closingPathname !== pathname) setClosingPathname(null);
  const openTabs = syncTabs(tabs, pathname, closingPathname);
  if (openTabs !== tabs) setTabs(openTabs);

  // The list a close has to work from — kept level with what is rendered, and
  // moved forward by `close` itself for a second close in the same task.
  useEffect(() => {
    latestTabs.current = openTabs;
  }, [openTabs]);

  /*
    Once the router has committed *any* location, the render-derived `activeId` is
    authoritative again and nothing is queued. Two closes in one task both run
    before this fires, which is exactly the window `queuedRoute` covers.
  */
  useEffect(() => {
    queuedRoute.current = null;
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
      Closing a tab retires everything remembered about it: the cached number, and
      the failure mark that stops it being asked for again. Keeping either is what
      made one failed `invoices:get` poison an invoice for the life of the window —
      reopen the tab and it stayed labelled "Invoice" forever.
    */
    const kept = forgetClosedLabels(labels, openTabs);
    for (const id of failed.current) if (!openTabs.includes(id)) failed.current.delete(id);
    if (kept !== labels) {
      setLabels(kept);
      return;
    }

    for (const id of unlabelledTabIds(openTabs, labels)) {
      // In flight: a second render must not fire the same fetch twice.
      // Failed: do not retry on every render — the mark is dropped above the
      // moment the tab closes, so reopening it does retry.
      if (inFlight.current.has(id) || failed.current.has(id)) continue;
      inFlight.current.add(id);
      void (async () => {
        try {
          const invoice = await window.api.invoke('invoices:get', { id });
          // A missing invoice (null) keeps the placeholder rather than closing
          // the tab: the tab is the user's, and a pill vanishing under the
          // pointer is worse than one labelled "Invoice".
          if (!invoice) {
            failed.current.add(id);
            return;
          }
          // The tab can have closed while this was in flight; a label written for
          // a pill that no longer exists is a cache entry nothing will ever clear.
          if (!latestTabs.current.includes(id)) return;
          setLabels((previous) => ({ ...previous, [id]: invoice.number }));
        } catch {
          // Same again: a failed fetch leaves the stable placeholder in place.
          failed.current.add(id);
        } finally {
          inFlight.current.delete(id);
        }
      })();
    }
  }, [openTabs, labels]);

  return {
    tabs: openTabs,
    activeId,
    labels,
    select: (id) => {
      void navigate(tabRoute(id));
    },
    close: (id) => {
      /*
        Resolved against the refs, not against this render: two closes in one
        browser task both run here before React re-renders, and the second one has
        to see the first one's list *and* the first one's queued navigation. The
        write is a functional `setState` applying the same pure transition to
        whatever state React holds — an absolute array would let the second write
        overwrite the first.
      */
      const queued = queuedRoute.current;
      const outcome = closeTab(latestTabs.current, id, pathname, queued);
      if (outcome.tabs === latestTabs.current) return;
      latestTabs.current = outcome.tabs;
      pendingFocus.current = outcome.focus;
      setTabs((previous) => closeTab(previous, id, pathname, queued).tabs);
      if (outcome.route !== null) {
        // Suppress the sync until the router reports the new route, or the tab
        // just dropped is re-appended from the route it is still on.
        setClosingPathname(outcome.closingPathname);
        queuedRoute.current = outcome.route;
        void navigate(outcome.route);
      }
    },
    openDraft: () => {
      const next = plusTransition(latestTabs.current);
      latestTabs.current = next.tabs;
      setTabs(next.tabs);
      void navigate(next.route ?? tabRoute(DRAFT_TAB_ID));
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
    if (isActive) {
      button.setAttribute('aria-current', 'page');
      // The pills scroll now (see `flex: none` in `global.css`), so the active one
      // has to be brought into the scroller's view — otherwise opening an
      // eleventh invoice puts its own pill off the end of the strip.
      pill.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    } else button.removeAttribute('aria-current');
  }, [id, isActive, label]);

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
