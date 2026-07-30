/**
 * Open-invoice tabs, as pure functions.
 *
 * The band at the top of the content column used to be reserved space and
 * nothing else (see `AppShell.tsx`'s header: there is no breadcrumb any more).
 * It now holds a strip of the invoices the user has open — one pill per open
 * document, the active one filled, a trailing `+` for a new draft.
 *
 * Everything the strip *decides* lives here, free of React and of the DOM, for
 * the same reason `chrome.ts` exists: the root vitest project is
 * `environment: 'node'`, so `InvoiceTabs.tsx` cannot be mounted in a test.
 * Route parsing, the open/close/plus transitions, where focus goes after a
 * close, and every label string are therefore values a node test can assert.
 *
 * A tab is identified by a string, not by an object: either `DRAFT_TAB_ID` or an
 * invoice id. The list is the whole state — which tab is *active* is never
 * stored, it is derived from the route by `tabIdForPath`, so the strip and the
 * address bar cannot disagree.
 */

/** Route the list lives at, and the fallback when the last tab closes. */
export const INVOICES_ROUTE = '/invoices';

/**
 * The one draft tab's id, and the last path segment of the draft route.
 *
 * There is exactly one draft route (`/invoices/new`), so there can be at most
 * one draft tab: two would both have to be "the" unsaved invoice, and only one
 * of them could ever be on screen. `plusTransition` relies on this.
 */
export const DRAFT_TAB_ID = 'new';

/** Last segment of the editor route: `/invoices/:id/edit`. */
const EDIT_SEGMENT = 'edit';

/** Visible label of the draft tab. */
export const DRAFT_TAB_LABEL = 'New invoice';

/**
 * Label an invoice tab wears until its number arrives — and if it never does.
 *
 * Never the raw id (a cuid says nothing to the user and would flash for one
 * frame before the fetch resolved) and never empty (an empty pill is a pill the
 * user cannot read, name or hit). A failed fetch keeps this string rather than
 * closing the tab: the tab is the user's, not the fetch's.
 */
export const PENDING_TAB_LABEL = 'Invoice';

/** Accessible name of the trailing `+`. Deliberately not `DRAFT_TAB_LABEL`, or
 *  the button and the tab it opens would be two controls with one name. */
export const NEW_TAB_BUTTON_LABEL = 'New invoice tab';

/** Accessible name of the strip itself (the toolbar's `aria-label`). */
export const TAB_STRIP_LABEL = 'Open invoices';

/** Invoice numbers already fetched, keyed by invoice id. */
export type InvoiceTabLabels = Readonly<Record<string, string>>;

/**
 * Which tab, if any, a route belongs to.
 *
 * - `/invoices/new` -> the draft tab
 * - `/invoices/:id` and `/invoices/:id/edit` -> the *same* tab. Viewing an
 *   invoice and then editing it is one open document, not two pills.
 * - `/invoices`, and every route outside the invoices feature -> `null`. No tab
 *   is active; the open ones stay open.
 *
 * Anything under `/invoices` that is not one of those shapes is `null` too: a
 * path this function does not recognise is not a route the app mounts (see
 * `features/invoices/index.tsx`), and inventing a tab for it would put a pill
 * on screen that nothing can ever re-activate.
 */
export function tabIdForPath(pathname: string): string | null {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed !== INVOICES_ROUTE && !trimmed.startsWith(`${INVOICES_ROUTE}/`)) return null;
  const rest = trimmed.slice(INVOICES_ROUTE.length).replace(/^\//, '');
  if (rest === '') return null;

  const segments = rest.split('/');
  const [first, second] = segments;
  if (first === undefined || first === '') return null;
  if (segments.length === 1) return first;
  if (segments.length === 2 && second === EDIT_SEGMENT && first !== DRAFT_TAB_ID) return first;
  return null;
}

/** Route a tab points at. The draft tab is the only one that is not an id. */
export function tabRoute(id: string): string {
  return `${INVOICES_ROUTE}/${id}`;
}

/**
 * The tab list after arriving at `pathname`.
 *
 * Navigating to a tabbable route that is not open yet appends a tab; that and
 * the `+` are the only two ways a tab is ever created. Returns the *same array
 * reference* when nothing changes, so a caller can store the result
 * unconditionally without re-rendering on every route change.
 */
export function openTabForPath(
  tabs: readonly string[],
  pathname: string,
): readonly string[] {
  const id = tabIdForPath(pathname);
  if (id === null || tabs.includes(id)) return tabs;
  return [...tabs, id];
}

/**
 * The closes the router has not caught up with yet.
 *
 * ## Why this is a set of ids and not one pathname
 *
 * Closing a tab does two things — drop the tab, navigate away — and the router
 * reports the new route one render *later* than the shorter list. Measured, with
 * three closes dispatched in one browser task: the first render after the batch
 * carries the *final* tab list and the *original* pathname. A plain sync on that
 * render re-appends the tab the first close dropped, which is exactly the "close
 * the active tab and it comes straight back" bug — one render late and at the end
 * of the strip.
 *
 * One scalar "the pathname being left" cannot describe that render. N closes in
 * one task queue N departures, the batched writes collapse to the last one, and
 * the render that needs suppressing is the *first* departure's route. So the
 * suppression is keyed by *tab id*: `syncTabs` only ever appends
 * `tabIdForPath(pathname)`, so the only question it has to answer is "is this a
 * tab the user has just closed and the router has not caught up with", and every
 * queued close can answer it at once.
 *
 * `settleRoute` is the last route the strip navigated to. It is what says *when*
 * the departures are done: once the router reports that route, every queued
 * navigation has landed, the render-derived route is authoritative again, and the
 * whole set is dropped — so navigating back to a closed invoice re-opens its tab
 * as it should. The invariant is that `ids` is only ever non-empty alongside a
 * non-null `settleRoute`; a close with no navigation of any kind in flight needs
 * no suppression at all, because the route it syncs against is already committed.
 *
 * `routes` is every route this task is accounted for — the ones the strip asked
 * for, and the one it was leaving. It is the escape hatch, and it is not
 * theoretical: something else can navigate in the same task and overwrite the
 * strip's own `navigate` before the router ever commits it (measured: a close
 * followed by an explicit `/invoices/:id/edit` in one task, where `settleRoute`
 * never arrives). Without a way out the suppression would hold for the life of
 * the window and that invoice could never have a pill again. So a committed route
 * that is *not* in this list is a navigation that won, whatever it points at: the
 * departures are dropped, and the sync then does what that route asks — re-open
 * the tab when the winner names one, nothing when it names none.
 */
export interface DepartingTabs {
  /** Tabs closed in this browser task, until the router reports `settleRoute`. */
  readonly ids: readonly string[];
  /** Every route this task explains: where it was, and where it asked to go. */
  readonly routes: readonly string[];
  /** The last route the strip navigated to, or `null` with nothing in flight. */
  readonly settleRoute: string | null;
}

/** Nothing in flight: the render-derived route is authoritative. */
export const NO_DEPARTING_TABS: DepartingTabs = { ids: [], routes: [], settleRoute: null };

function withRoutes(routes: readonly string[], added: readonly string[]): readonly string[] {
  const fresh = added.filter((route) => !routes.includes(route));
  return fresh.length === 0 ? routes : [...routes, ...fresh];
}

/**
 * One more queued close.
 *
 * `settleRoute` is where the router is now headed — this close's own destination
 * when it navigates, else the navigation an earlier action in the same task
 * already queued. `null` for both means nothing is in flight and there is
 * nothing to suppress, so the set is left empty rather than growing an id that
 * would never be released.
 *
 * `accounted` is every route this task explains at the moment of the close: the
 * route it is leaving — the one the first render after the batch still reports, so
 * it must never be mistaken for an outside navigation — plus every route the strip
 * has queued so far, including the ones queued before this close.
 */
export function recordDeparture(
  departing: DepartingTabs,
  id: string,
  accounted: readonly string[],
  settleRoute: string | null,
): DepartingTabs {
  if (settleRoute === null) return departing;
  const routes = withRoutes(departing.routes, [...accounted, settleRoute]);
  if (departing.ids.includes(id)) return { ids: departing.ids, routes, settleRoute };
  return { ids: [...departing.ids, id], routes, settleRoute };
}

/**
 * A navigation that is not a close — a pill click, or the `+`.
 *
 * It still moves the finishing line: the user's newest destination is the route
 * the queued departures have to wait for. With nothing departing there is
 * nothing to wait for, and the same object comes back so no render is spent.
 */
export function recordNavigation(departing: DepartingTabs, settleRoute: string): DepartingTabs {
  if (departing.ids.length === 0) return departing;
  const routes = withRoutes(departing.routes, [settleRoute]);
  if (departing.settleRoute === settleRoute && routes === departing.routes) return departing;
  return { ids: departing.ids, routes, settleRoute };
}

/**
 * The queued departures, dropped once this task's navigations are accounted for.
 *
 * One rule: the departures are waiting for the router to catch up with *this
 * task's* navigations, so they are released the moment there is nothing of this
 * task's left to wait for.
 *
 * - The router reported `settleRoute`: every queued navigation has landed, the
 *   render-derived route is authoritative again, and the set goes. Checked first,
 *   because `recordNavigation` also puts `settleRoute` into `routes`, so a settle
 *   arrival is a *queued* route and must not be read as an outside one.
 * - The router reported a route this task never queued: somebody else navigated
 *   and won, `settleRoute` is never coming, and there is nothing left to wait for
 *   either. This is why the suppression cannot outlive the window — it covers the
 *   measured case (a close followed by an explicit `/invoices/:id/edit` in one
 *   task, where the winner names a departing tab) and equally a winner that names
 *   no tab at all, like `/settings`, which used to wedge the set forever and left
 *   the closed invoice unable to ever get a pill again.
 * - Anything else is one of this task's own queued routes, still being worked
 *   through: keep waiting.
 *
 * Returns the *same object* while there is still something to wait for, so the
 * caller can write the result back unconditionally without looping.
 */
export function settleDepartures(departing: DepartingTabs, pathname: string): DepartingTabs {
  if (departing.ids.length === 0) return departing;
  if (pathname === departing.settleRoute) return NO_DEPARTING_TABS;
  if (!departing.routes.includes(pathname)) return NO_DEPARTING_TABS;
  return departing;
}

/**
 * The tab list after a render, given the closes still in flight.
 *
 * Arriving at a tabbable route appends its tab — unless that tab is one the user
 * has just closed and the router has not caught up with, which is the whole point
 * of `DepartingTabs`. Any other route syncs normally, so a genuinely re-opened
 * invoice still gets its tab back.
 */
export function syncTabs(
  tabs: readonly string[],
  pathname: string,
  departing: DepartingTabs,
): readonly string[] {
  const id = tabIdForPath(pathname);
  if (id !== null && departing.ids.includes(id)) return tabs;
  return openTabForPath(tabs, pathname);
}

/**
 * One tab gone from whatever list is handed in. Same reference when it is not
 * there.
 *
 * This is deliberately the *whole* of what a close writes to the tab list. The
 * close's route and focus decisions are one authoritative outcome computed once,
 * outside the state write; re-running the transition inside the updater instead
 * re-derives "which tab is active" from a `previous` React chose, which is not
 * the list the outcome was decided against — and that mis-derivation is what left
 * one of two same-task closes un-applied.
 */
export function removeTab(tabs: readonly string[], id: string): readonly string[] {
  if (!tabs.includes(id)) return tabs;
  return tabs.filter((tab) => tab !== id);
}

/** Which tab takes over when `id` is closed: the right neighbour, else the left. */
export function successorTabId(tabs: readonly string[], id: string): string | null {
  const index = tabs.indexOf(id);
  if (index === -1) return null;
  return tabs[index + 1] ?? tabs[index - 1] ?? null;
}

/** What a close does: the remaining tabs, and where to navigate (or nowhere). */
export interface TabTransition {
  readonly tabs: readonly string[];
  /** `null` means "stay where you are" — only ever for a non-active close. */
  readonly route: string | null;
}

/**
 * Closing a tab.
 *
 * Closing an inactive tab only removes it — the route is untouched, so the page
 * the user is reading does not move under them. Closing the *active* tab has to
 * navigate, because the route it left behind no longer has a pill: the right
 * neighbour if there is one, else the left one, else the list. That last case is
 * the one that matters — without it the app sits on `/invoices/:id` with an
 * empty strip, which is the state the whole feature exists to make impossible.
 */
export function closeTabTransition(
  tabs: readonly string[],
  id: string,
  activeId: string | null,
): TabTransition {
  if (!tabs.includes(id)) return { tabs, route: null };
  const remaining = tabs.filter((tab) => tab !== id);
  if (id !== activeId) return { tabs: remaining, route: null };
  const successor = successorTabId(tabs, id);
  return { tabs: remaining, route: successor === null ? INVOICES_ROUTE : tabRoute(successor) };
}

/**
 * Where keyboard focus goes when a tab is closed.
 *
 * A close destroys the DOM node that had focus — the close button inside the
 * pill — and the browser's fallback for that is `<body>`, which drops the user
 * out of the toolbar entirely. So the strip says where to go instead:
 *
 * - `tab`: the surviving right neighbour, else the left one. The same rule the
 *   *route* follows, so the pill that gains focus is the pill that gains the page.
 * - `new`: the trailing `+`. Reachable when the closed id was not in the list yet
 *   tabs remain — the strip is still on screen and the `+` is the one control in
 *   it that is always present.
 * - `page`: the strip itself is gone (the last tab closed and `InvoiceTabs`
 *   renders null), so focus has to land on the page the close navigated to.
 */
export type CloseFocusTarget =
  | { readonly kind: 'tab'; readonly id: string }
  | { readonly kind: 'new' }
  | { readonly kind: 'page' };

/** Which control should hold focus after `id` is closed out of `tabs`. */
export function closeFocusTarget(tabs: readonly string[], id: string): CloseFocusTarget {
  const index = tabs.indexOf(id);
  if (index === -1) return tabs.length === 0 ? { kind: 'page' } : { kind: 'new' };
  const neighbour = tabs[index + 1] ?? tabs[index - 1];
  if (neighbour !== undefined) return { kind: 'tab', id: neighbour };
  return { kind: 'page' };
}

/** Everything one close decides, as one value. */
export interface CloseOutcome {
  readonly tabs: readonly string[];
  /** `null` means "stay where you are" — only ever for a non-active close. */
  readonly route: string | null;
  /**
   * The route the router has to reach before this close is reconciled: this
   * close's own destination, else a navigation an earlier action in the same task
   * already queued. `null` when nothing at all is in flight, and then nothing has
   * to be suppressed. See `DepartingTabs`.
   */
  readonly settleRoute: string | null;
  readonly focus: CloseFocusTarget;
}

/**
 * One close, resolved against the state that is actually current.
 *
 * The two arguments that are easy to get wrong, and the bug each one fixes:
 *
 * - `tabs` must be the *latest* list, not the one a render captured. Two closes
 *   in one browser task both run before React re-renders, so the second one has
 *   to see the first one's result or it writes an absolute list that resurrects
 *   the tab the first one dropped.
 * - `queuedRoute` is the destination of a navigation already queued in this same
 *   task (again: no re-render yet, so `useLocation` still reports the old
 *   pathname). Which tab is *active* has to be read from where the router is
 *   going, not from where it has been, or the second close mistakes the incoming
 *   active tab for an inactive one, removes it without navigating, and leaves the
 *   app on a route with no pill.
 */
export function closeTab(
  tabs: readonly string[],
  id: string,
  pathname: string,
  queuedRoute: string | null,
): CloseOutcome {
  const from = queuedRoute ?? pathname;
  const transition = closeTabTransition(tabs, id, tabIdForPath(from));
  return {
    tabs: transition.tabs,
    route: transition.route,
    settleRoute: transition.route ?? queuedRoute,
    focus: closeFocusTarget(tabs, id),
  };
}

/**
 * The trailing `+`.
 *
 * Always navigates to `/invoices/new`. When a draft tab is already open that
 * navigation *activates* it instead of adding a second one — the append in
 * `openTabForPath` is a no-op for an id already in the list, and there is only
 * one draft route, so two draft tabs could never both be reachable anyway.
 */
export function plusTransition(tabs: readonly string[]): TabTransition {
  return { tabs: openTabForPath(tabs, tabRoute(DRAFT_TAB_ID)), route: tabRoute(DRAFT_TAB_ID) };
}

/** Visible text on a pill: the draft's fixed label, or the invoice's number. */
export function tabLabel(id: string, labels: InvoiceTabLabels): string {
  if (id === DRAFT_TAB_ID) return DRAFT_TAB_LABEL;
  return labels[id] ?? PENDING_TAB_LABEL;
}

/**
 * Accessible name of a pill's close control. Per-tab on purpose: a strip of
 * buttons all named "Close" tells a screen-reader user nothing about which
 * document they are about to drop.
 */
export function tabCloseLabel(id: string, labels: InvoiceTabLabels): string {
  if (id === DRAFT_TAB_ID) return 'Close new invoice';
  const number = labels[id];
  /*
    No number yet (or never — a fetch can fail): the name falls back to the id
    rather than a bare "Close invoice", because two unlabelled pills with one
    name are two buttons a screen-reader user cannot tell apart, and the one they
    press drops a document. The id is in the accessible name only; the *visible*
    text stays `PENDING_TAB_LABEL`, so no cuid is ever painted on screen.
  */
  return number === undefined ? `Close invoice ${id}` : `Close invoice ${number}`;
}

/** Which invoice ids on screen still need their number fetched. */
export function unlabelledTabIds(
  tabs: readonly string[],
  labels: InvoiceTabLabels,
): readonly string[] {
  return tabs.filter((id) => id !== DRAFT_TAB_ID && labels[id] === undefined);
}

/**
 * The label fetches the strip has going, and the ones that came back empty.
 *
 * The fetch loop is guarded on "has this id been asked for already", or a second
 * render would fire the same `invoices:get` twice and a dead one would refire on
 * every render for the life of the window. So the guard has to be retired when a
 * tab closes — see `forgetClosedLabels` — and *that* is where a close racing an
 * in-flight request went wrong: the close cleanup ran while the request was still
 * pending, so there was no failure mark to retire yet, and the mark the request
 * added when it finally failed belonged to a tab the user had since reopened.
 * Nothing was ever going to clear it and the reopened pill read `Invoice` for
 * good.
 *
 * A request therefore carries a `token`, and a completion is only allowed to
 * write anything if `inFlight` still holds *that* token for the id. Closing the
 * tab drops the entry, so the request that outlives its tab settles into nothing
 * and the reopened tab's own request — a different token — is the one that
 * answers. `nextToken` is a single monotonic counter rather than a per-id
 * generation, because per-id bookkeeping for closed ids is state that grows with
 * every close and is never read again.
 */
export interface LabelRequests {
  /** Ids with an `invoices:get` in flight, each under the token that started it. */
  readonly inFlight: Readonly<Record<string, number>>;
  /**
   * Ids whose request resolved with no invoice, or threw. Not asked for again
   * while the tab stays open: the placeholder is stable and a per-render retry
   * loop is not. Dropped the moment the tab closes, so reopening does retry.
   */
  readonly failed: readonly string[];
  /** The token the next request takes. Only ever increments. */
  readonly nextToken: number;
}

/** No fetch has been made yet. */
export const NO_LABEL_REQUESTS: LabelRequests = { inFlight: {}, failed: [], nextToken: 1 };

/** Which open tabs still need an `invoices:get` fired for them right now. */
export function pendingLabelIds(
  tabs: readonly string[],
  labels: InvoiceTabLabels,
  requests: LabelRequests,
): readonly string[] {
  return unlabelledTabIds(tabs, labels).filter(
    (id) => requests.inFlight[id] === undefined && !requests.failed.includes(id),
  );
}

/** One request started, and the token its completion has to still hold. */
export function startLabelRequest(
  requests: LabelRequests,
  id: string,
): { readonly requests: LabelRequests; readonly token: number } {
  const token = requests.nextToken;
  return {
    requests: {
      inFlight: { ...requests.inFlight, [id]: token },
      failed: requests.failed,
      nextToken: token + 1,
    },
    token,
  };
}

/**
 * Whether a settled request still speaks for the pill on screen.
 *
 * False once the tab has closed — including when it has been *reopened* since,
 * because the reopen fired its own request under its own token. A stale
 * completion must write neither a label (a cache entry for a pill that does not
 * exist) nor a failure mark (the poison above).
 */
export function labelRequestIsCurrent(
  requests: LabelRequests,
  id: string,
  token: number,
): boolean {
  return requests.inFlight[id] === token;
}

/** A current request, finished. `didFail` is "nothing came back", not "threw". */
export function settleLabelRequest(
  requests: LabelRequests,
  id: string,
  didFail: boolean,
): LabelRequests {
  const inFlight = Object.fromEntries(
    Object.entries(requests.inFlight).filter(([key]) => key !== id),
  );
  const failed = didFail && !requests.failed.includes(id) ? [...requests.failed, id] : requests.failed;
  return { inFlight, failed, nextToken: requests.nextToken };
}

/**
 * Everything remembered about tabs that are no longer open, dropped.
 *
 * The `failed` mark goes so a reopened tab is asked for again, and the `inFlight`
 * entry goes so the request still running under it can no longer write anything —
 * the reopen is free to fire its own. Same reference when there is nothing to
 * drop, so the effect that calls it cannot loop.
 */
export function retireClosedRequests(
  requests: LabelRequests,
  tabs: readonly string[],
): LabelRequests {
  const flightIds = Object.keys(requests.inFlight);
  const keptFlight = flightIds.filter((id) => tabs.includes(id));
  const keptFailed = requests.failed.filter((id) => tabs.includes(id));
  if (keptFlight.length === flightIds.length && keptFailed.length === requests.failed.length) {
    return requests;
  }
  return {
    inFlight: Object.fromEntries(keptFlight.map((id) => [id, requests.inFlight[id] as number])),
    failed: keptFailed,
    nextToken: requests.nextToken,
  };
}

/**
 * The routes this browser task has queued, with `route` on the end.
 *
 * De-duplicated against the last entry, and that is the whole of the bound it
 * needs: the list is cleared on every committed pathname, so it can only grow
 * while the route does not change — which is exactly the repeated-same-route case
 * (clicking the already-active pill, or pressing `+` on `/invoices/new`). The
 * queueing semantics are untouched, because the last entry is what a close reads
 * as "where the router is headed" and membership is what `DepartingTabs` tests
 * against: appending a route that is already last changes neither.
 */
export function queueRoute(routes: readonly string[], route: string): readonly string[] {
  return routes.at(-1) === route ? routes : [...routes, route];
}

/**
 * The label cache with every closed tab's entry dropped.
 *
 * Two things depend on this. The cache is unbounded otherwise — a session that
 * opens and closes fifty invoices keeps fifty numbers for pills that no longer
 * exist. And a reopened tab must fetch again: the fetch is guarded by "has this
 * id been asked for", so keeping the entry (or, worse, keeping a *failure* mark)
 * for a tab the user has closed is what makes a single failed `invoices:get`
 * poison that invoice for the life of the window.
 *
 * Returns the *same reference* when there is nothing to drop, so the effect that
 * calls it cannot loop.
 */
export function forgetClosedLabels(
  labels: InvoiceTabLabels,
  tabs: readonly string[],
): InvoiceTabLabels {
  const open = Object.keys(labels).filter((id) => tabs.includes(id));
  if (open.length === Object.keys(labels).length) return labels;
  return Object.fromEntries(open.map((id) => [id, labels[id] as string]));
}
