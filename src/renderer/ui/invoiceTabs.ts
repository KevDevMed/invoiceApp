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
 * The tab list after a render, given a close that is still in flight.
 *
 * `openTabForPath` alone is not enough, and the bug it hides is worth naming.
 * Closing the active tab does two things — drop the tab, navigate away — and the
 * router reports the new route one render *later* than the shorter list. On that
 * intermediate render the route still points at the tab that was just closed, so
 * a plain sync re-appends it: close the active tab and it comes straight back,
 * at the end of the strip.
 *
 * `closingPathname` is the route being left. While the router still reports it,
 * the list is left exactly as it is. Any other route — including the one the
 * close navigated to — syncs normally, so a genuinely re-opened invoice still
 * gets its tab back.
 */
export function syncTabs(
  tabs: readonly string[],
  pathname: string,
  closingPathname: string | null,
): readonly string[] {
  if (closingPathname !== null && pathname === closingPathname) return tabs;
  return openTabForPath(tabs, pathname);
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
   * The pathname to suppress syncing against until the router catches up, or
   * `null` when this close does not navigate and so nothing has to be
   * suppressed. See `syncTabs`.
   */
  readonly closingPathname: string | null;
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
    closingPathname: transition.route === null ? null : from,
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
