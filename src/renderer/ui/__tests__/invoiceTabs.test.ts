/**
 * The tab strip's decisions, tested as data.
 *
 * `InvoiceTabs.tsx` cannot be mounted here (root vitest project is
 * `environment: 'node'`), which is exactly why every rule worth asserting was
 * put in `invoiceTabs.ts` instead: route -> tab, the transitions, the
 * close-focus rule and the label strings are all pure.
 */

import { describe, expect, it } from 'vitest';

import {
  closeFocusTarget,
  closeTab,
  closeTabTransition,
  DRAFT_TAB_ID,
  forgetClosedLabels,
  DRAFT_TAB_LABEL,
  INVOICES_ROUTE,
  NEW_TAB_BUTTON_LABEL,
  NO_DEPARTING_TABS,
  openTabForPath,
  PENDING_TAB_LABEL,
  plusTransition,
  recordDeparture,
  recordNavigation,
  removeTab,
  settleDepartures,
  successorTabId,
  syncTabs,
  tabCloseLabel,
  tabIdForPath,
  tabLabel,
  tabRoute,
  unlabelledTabIds,
} from '../invoiceTabs';

describe('tabIdForPath', () => {
  it('gives the draft route the one draft tab', () => {
    expect(tabIdForPath('/invoices/new')).toBe(DRAFT_TAB_ID);
    // A trailing slash is the same route.
    expect(tabIdForPath('/invoices/new/')).toBe(DRAFT_TAB_ID);
  });

  it('collapses :id and :id/edit onto one tab', () => {
    // The claim the feature rests on: viewing an invoice and then editing it is
    // one open document. Two ids here would be two pills for one invoice.
    expect(tabIdForPath('/invoices/inv_42')).toBe('inv_42');
    expect(tabIdForPath('/invoices/inv_42/edit')).toBe('inv_42');
    expect(tabIdForPath('/invoices/inv_42/edit/')).toBe('inv_42');
  });

  it('leaves the list route, and every route outside invoices, with no tab', () => {
    for (const path of [
      '/invoices',
      '/invoices/',
      '/',
      '/clients',
      '/clients/inv_42',
      '/settings',
      '/reports',
      '/invoicesomething/inv_42',
    ]) {
      expect(tabIdForPath(path)).toBeNull();
    }
  });

  it('refuses route shapes the app does not mount', () => {
    // `features/invoices/index.tsx` mounts index, `new`, `:id`, `:id/edit` and
    // nothing else. A pill invented for anything else could never be
    // re-activated by clicking it.
    expect(tabIdForPath('/invoices/inv_42/pdf')).toBeNull();
    expect(tabIdForPath('/invoices/inv_42/edit/deep')).toBeNull();
    expect(tabIdForPath('/invoices/new/edit')).toBeNull();
  });
});

describe('tabRoute', () => {
  it('routes the draft tab and an invoice tab', () => {
    expect(tabRoute(DRAFT_TAB_ID)).toBe('/invoices/new');
    expect(tabRoute('inv_42')).toBe('/invoices/inv_42');
  });

  it('round-trips through tabIdForPath', () => {
    for (const id of [DRAFT_TAB_ID, 'inv_42']) {
      expect(tabIdForPath(tabRoute(id))).toBe(id);
    }
  });
});

describe('openTabForPath', () => {
  it('appends a tab for a route that is not open yet, keeping order', () => {
    expect(openTabForPath([], '/invoices/inv_1')).toEqual(['inv_1']);
    expect(openTabForPath(['inv_1'], '/invoices/new')).toEqual(['inv_1', 'new']);
  });

  it('does not duplicate a tab that is already open', () => {
    const tabs = ['inv_1', 'inv_2'];
    // Same reference, not merely an equal array: the shell stores this result on
    // every route change, and a fresh array would re-render the strip each time.
    expect(openTabForPath(tabs, '/invoices/inv_2')).toBe(tabs);
    expect(openTabForPath(tabs, '/invoices/inv_2/edit')).toBe(tabs);
  });

  it('treats the editor as the tab it already opened', () => {
    expect(openTabForPath([], '/invoices/inv_9/edit')).toEqual(['inv_9']);
    expect(openTabForPath(['inv_9'], '/invoices/inv_9/edit')).toEqual(['inv_9']);
  });

  it('opens nothing for the list or for another section', () => {
    const tabs = ['inv_1'];
    for (const path of ['/invoices', '/settings', '/clients/c_1']) {
      expect(openTabForPath(tabs, path)).toBe(tabs);
    }
  });
});

describe('syncTabs', () => {
  const departing = (ids: readonly string[], settleRoute: string | null) => ({
    ids,
    routes: [settleRoute ?? ''],
    settleRoute,
  });

  it('refuses to re-open a tab whose close is still in flight', () => {
    // The regression: the shorter list lands one render before the router
    // reports the new route, so the route still points at the closed tab.
    expect(syncTabs(['b'], '/invoices/a', departing(['a'], '/invoices/b'))).toEqual(['b']);
    expect(syncTabs(['b'], '/invoices/a/edit', departing(['a'], '/invoices/b'))).toEqual(['b']);
  });

  it('suppresses every queued departure, not only the last one', () => {
    // The scalar this replaced could name one departing route; three closes in
    // one task queue three, and the render that needs suppressing carries the
    // *first*. Every one of them has to be refused on that render.
    const queued = departing(['a', 'b', 'c'], '/invoices/d');
    for (const path of ['/invoices/a', '/invoices/b', '/invoices/c']) {
      expect(syncTabs(['d'], path, queued)).toEqual(['d']);
    }
  });

  it('syncs normally for a route no close is departing from', () => {
    expect(syncTabs(['b'], '/invoices/b', departing(['a'], '/invoices/b'))).toEqual(['b']);
    expect(syncTabs(['b'], '/invoices/c', departing(['a'], '/invoices/b'))).toEqual(['b', 'c']);
  });

  it('behaves like openTabForPath when nothing is departing', () => {
    expect(syncTabs([], '/invoices/a', NO_DEPARTING_TABS)).toEqual(['a']);
    const tabs = ['a'];
    expect(syncTabs(tabs, '/invoices', NO_DEPARTING_TABS)).toBe(tabs);
  });

  it('still re-opens an invoice the user navigates back to later', () => {
    // Once the departures are settled the suppression is gone, which is what
    // keeps Back after a close a re-open rather than a route with no pill.
    expect(syncTabs([], '/invoices/a', NO_DEPARTING_TABS)).toEqual(['a']);
    expect(syncTabs([], '/invoices/a', departing(['zz'], '/invoices/q'))).toEqual(['a']);
  });
});

describe('removeTab', () => {
  it('removes one id and keeps the order of the rest', () => {
    expect(removeTab(['a', 'b', 'c'], 'b')).toEqual(['a', 'c']);
  });

  it('returns the same list, by reference, for an id that is not open', () => {
    const tabs = ['a', 'b'];
    expect(removeTab(tabs, 'zz')).toBe(tabs);
  });

  it('removes only the named id whatever else the list has gained', () => {
    /*
      The state updater's whole contract. React can hand it a `previous` that is
      not the list the close was resolved against — the route sync appends during
      render — and re-deriving the transition from that list is what removed the
      wrong id. Removal cannot depend on which tab is active.
    */
    expect(removeTab(['a', 'b', 'late'], 'a')).toEqual(['b', 'late']);
  });
});

describe('DepartingTabs', () => {
  it('accumulates every queued close instead of replacing it', () => {
    let queued = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    queued = recordDeparture(queued, 'b', ['/invoices/a'], '/invoices/c');
    queued = recordDeparture(queued, 'c', ['/invoices/a'], '/invoices/d');
    expect(queued.ids).toEqual(['a', 'b', 'c']);
    expect(queued.settleRoute).toBe('/invoices/d');
    // Every route the task explains: where it started, and each place it asked
    // to go. Anything else naming a departing tab is somebody else navigating.
    expect(queued.routes).toEqual(['/invoices/a', '/invoices/b', '/invoices/c', '/invoices/d']);
  });

  it('records nothing when no navigation is in flight to wait for', () => {
    // An inactive close on a committed route syncs against that route, so there
    // is nothing to suppress — and an id nothing would ever release.
    expect(recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/b'], null)).toBe(NO_DEPARTING_TABS);
  });

  it('never queues one id twice', () => {
    const once = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    expect(recordDeparture(once, 'a', ['/invoices/a'], '/invoices/b').ids).toEqual(['a']);
  });

  it('moves the finishing line to the newest navigation', () => {
    const queued = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    expect(recordNavigation(queued, '/invoices/d')).toEqual({
      ids: ['a'],
      routes: ['/invoices/a', '/invoices/b', '/invoices/d'],
      settleRoute: '/invoices/d',
    });
  });

  it('spends no render on a navigation with nothing departing', () => {
    expect(recordNavigation(NO_DEPARTING_TABS, '/invoices/d')).toBe(NO_DEPARTING_TABS);
    const queued = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    expect(recordNavigation(queued, '/invoices/b')).toBe(queued);
  });

  it('releases the whole set once the router reports the route asked for', () => {
    const queued = recordDeparture(
      recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b'),
      'b',
      ['/invoices/a'],
      INVOICES_ROUTE,
    );
    // Still catching up: the same object back, so the render cannot loop.
    expect(settleDepartures(queued, '/invoices/a')).toBe(queued);
    expect(settleDepartures(queued, '/invoices/b')).toBe(queued);
    expect(settleDepartures(queued, INVOICES_ROUTE)).toBe(NO_DEPARTING_TABS);
    expect(settleDepartures(NO_DEPARTING_TABS, '/invoices/a')).toBe(NO_DEPARTING_TABS);
  });

  it('gives way to a navigation this task never asked for', () => {
    /*
      Measured: a close followed by an explicit `/invoices/:id/edit` in the same
      task overwrites the strip's own `navigate` before the router commits it, so
      `settleRoute` never arrives. Without this the suppression would outlive the
      window and that invoice could never have a pill again.
    */
    const queued = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    expect(settleDepartures(queued, '/invoices/a/edit')).toBe(NO_DEPARTING_TABS);
  });

  it('gives way to a winning navigation that names no tab at all', () => {
    /*
      The same rule, and the hole the "names a departing tab" version left: the
      close asks for `/invoices/b`, something else in the task asks for
      `/settings` and wins, so `/invoices/b` never arrives. `/settings` names no
      tab, so nothing released the set — `a` stayed suppressed for the life of the
      window, and the user could sit on invoice A's page with no A pill and
      re-open A as often as they liked without a pill ever appearing.

      There is nothing of this task's left to wait for either way, so what the
      winner points at cannot matter: a route this task never queued settles it.
    */
    const queued = recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b');
    expect(settleDepartures(queued, '/settings')).toBe(NO_DEPARTING_TABS);
    expect(settleDepartures(queued, '/invoices/zz')).toBe(NO_DEPARTING_TABS);
    expect(settleDepartures(queued, INVOICES_ROUTE)).toBe(NO_DEPARTING_TABS);
  });

  it('keeps waiting while the router works through this task’s own routes', () => {
    // The settle route is in `routes` too (`recordNavigation` puts it there), so
    // the order of the two exits matters: an arrival at `/invoices/c` releases
    // because it is the finishing line, not because it is unqueued.
    const queued = recordNavigation(
      recordDeparture(NO_DEPARTING_TABS, 'a', ['/invoices/a'], '/invoices/b'),
      '/invoices/c',
    );
    expect(settleDepartures(queued, '/invoices/a')).toBe(queued);
    expect(settleDepartures(queued, '/invoices/b')).toBe(queued);
    expect(settleDepartures(queued, '/invoices/c')).toBe(NO_DEPARTING_TABS);
  });
});

/**
 * The hook's loop, as data.
 *
 * Measured on the running app (`HashRouter`, React 19): every click dispatched in
 * one browser task runs before any re-render, and the first render *after* that
 * batch carries the final tab list together with the pathname the task started
 * on — the committed route only catches up over the renders that follow. So a
 * task is "the handlers, then a render per committed pathname, starting with the
 * old one". That first render is where a resurrected tab came from.
 */
function runTask(
  tabs: readonly string[],
  pathname: string,
  actions: readonly ({ readonly close: string } | { readonly select: string })[],
  commits: readonly string[],
): { readonly tabs: readonly string[]; readonly route: string } {
  // `latest` is the hook's ref; `state` is what React holds. They are separate
  // on purpose: the ref moves inside the task, the state only between renders.
  let latest = tabs;
  let state = tabs;
  let departing = NO_DEPARTING_TABS;
  let queuedRoutes: readonly string[] = [];
  let route = pathname;

  for (const action of actions) {
    if ('select' in action) {
      const selected = tabRoute(action.select);
      queuedRoutes = [...queuedRoutes, selected];
      departing = recordNavigation(departing, selected);
      route = selected;
      continue;
    }
    const outcome = closeTab(latest, action.close, pathname, queuedRoutes.at(-1) ?? null);
    if (outcome.tabs === latest) continue;
    latest = outcome.tabs;
    state = removeTab(state, action.close);
    if (outcome.route !== null) {
      queuedRoutes = [...queuedRoutes, outcome.route];
      route = outcome.route;
    }
    departing = recordDeparture(departing, action.close, [pathname, ...queuedRoutes], outcome.settleRoute);
  }

  for (const committed of [pathname, ...commits]) {
    departing = settleDepartures(departing, committed);
    state = syncTabs(state, committed, departing);
  }
  return { tabs: state, route };
}

describe('closes in one browser task', () => {
  it('applies three chained active closes and resurrects none of them', () => {
    // G1/Tier 2: open a b c d, activate a, close a, b, c in one task. Measured
    // before the fix: pills [d, a] — the first closed invoice came back, and the
    // strip and the address bar disagreed.
    expect(runTask(['a', 'b', 'c', 'd'], '/invoices/a', [{ close: 'a' }, { close: 'b' }, { close: 'c' }], [
      '/invoices/b',
      '/invoices/c',
      '/invoices/d',
    ])).toEqual({ tabs: ['d'], route: '/invoices/d' });
  });

  it('closes the active tab and the successor it just handed the route to', () => {
    // F1/Tier 1: close active a, then close the incoming b. Measured before the
    // fix: `#/invoices` with tab a surviving and no active pill.
    expect(runTask(['a', 'b'], '/invoices/a', [{ close: 'a' }, { close: 'b' }], [INVOICES_ROUTE])).toEqual(
      { tabs: [], route: INVOICES_ROUTE },
    );
  });

  it('survives N simultaneous closes, not just two', () => {
    const tabs = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const closes = tabs.slice(0, 6).map((id) => ({ close: id }));
    const commits = tabs.slice(1).map((id) => `/invoices/${id}`);
    expect(runTask(tabs, '/invoices/a', closes, commits)).toEqual({
      tabs: ['g'],
      route: '/invoices/g',
    });
  });

  it('keeps a close that lands during an in-flight pill selection', () => {
    // G2: click d's pill, then d's close, in one task. Measured before the fix:
    // all four tabs remained and the route settled on the tab just closed,
    // because the close read the stale rendered pathname, called d inactive, and
    // the route sync then re-appended it.
    expect(runTask(['a', 'b', 'c', 'd'], '/invoices/a', [{ select: 'd' }, { close: 'd' }], [
      '/invoices/d',
      '/invoices/c',
    ])).toEqual({ tabs: ['a', 'b', 'c'], route: '/invoices/c' });
  });

  it('lets a pill clicked after a close win the route', () => {
    expect(runTask(['a', 'b', 'c', 'd'], '/invoices/b', [{ close: 'b' }, { select: 'd' }], [
      '/invoices/c',
      '/invoices/d',
    ])).toEqual({ tabs: ['a', 'c', 'd'], route: '/invoices/d' });
  });

  it('re-opens a closed invoice the user goes Back to, once the close has settled', () => {
    const closed = runTask(['a', 'b'], '/invoices/a', [{ close: 'a' }], ['/invoices/b']);
    expect(closed.tabs).toEqual(['b']);
    // Back is its own task, by which point the departures are released.
    expect(syncTabs(closed.tabs, '/invoices/a', NO_DEPARTING_TABS)).toEqual(['b', 'a']);
  });

  it('leaves four inactive closes alone — no navigation, so nothing to suppress', () => {
    expect(
      runTask(
        ['a', 'b', 'c', 'd', 'e', 'f'],
        '/invoices/f',
        [{ close: 'a' }, { close: 'b' }, { close: 'c' }, { close: 'd' }],
        [],
      ),
    ).toEqual({ tabs: ['e', 'f'], route: '/invoices/f' });
  });

  it('lets an explicit navigation to the closed invoice’s own route re-open it', () => {
    // The close asks for `/invoices/a`; something else in the same task asks for
    // the editor of the invoice being closed and gets there first. That route
    // wants that document, so the tab comes back rather than the app sitting on a
    // route with no pill — and the suppression cannot outlive the window.
    expect(runTask(['a', 'b'], '/invoices/b', [{ close: 'b' }], ['/invoices/b/edit'])).toEqual({
      tabs: ['a', 'b'],
      route: '/invoices/a',
    });
  });

  it('re-opens a closed invoice after an unrelated route won the close’s navigation', () => {
    /*
      Tabs [a, b] on `/invoices/a`. Closing `a` asks for `/invoices/b`, and before
      the router commits it something else in the same task asks for `/settings`
      and wins — `/invoices/b` never arrives. Measured before the fix: `a` stayed
      queued as departing on every render that followed, so the user sat on
      `/invoices/a` with no A pill and re-opening A did nothing, for the life of
      the window (only the abandoned `/invoices/b` or a reload recovered).
    */
    let departing = recordDeparture(
      NO_DEPARTING_TABS,
      'a',
      ['/invoices/a', '/invoices/b'],
      '/invoices/b',
    );
    let tabs = removeTab(['a', 'b'], 'a');
    expect(tabs).toEqual(['b']);

    // Renders: the batch's stale route, then the winner, then the user's own later
    // navigations — each its own task, long after `/invoices/b` stopped coming.
    for (const committed of ['/invoices/a', '/settings', INVOICES_ROUTE, '/invoices/a']) {
      departing = settleDepartures(departing, committed);
      tabs = syncTabs(tabs, committed, departing);
    }
    expect(departing.ids).toEqual([]);
    expect(tabs).toEqual(['b', 'a']);
  });

  it('ignores repeat clicks on a stale close control', () => {
    const repeated = Array.from({ length: 10 }, () => ({ close: 'a' }));
    expect(runTask(['a', 'b', 'c'], '/invoices/c', repeated, [])).toEqual({
      tabs: ['b', 'c'],
      route: '/invoices/c',
    });
  });
});

describe('successorTabId', () => {
  it('prefers the right neighbour', () => {
    expect(successorTabId(['a', 'b', 'c'], 'b')).toBe('c');
    expect(successorTabId(['a', 'b', 'c'], 'a')).toBe('b');
  });

  it('falls back to the left neighbour at the end of the strip', () => {
    expect(successorTabId(['a', 'b', 'c'], 'c')).toBe('b');
  });

  it('has no successor for the last remaining tab, or an unknown one', () => {
    expect(successorTabId(['a'], 'a')).toBeNull();
    expect(successorTabId(['a', 'b'], 'zz')).toBeNull();
  });
});

describe('closeTabTransition', () => {
  it('closing an inactive tab removes it and does not move the route', () => {
    expect(closeTabTransition(['a', 'b', 'c'], 'a', 'b')).toEqual({
      tabs: ['b', 'c'],
      route: null,
    });
  });

  it('closing the active tab navigates to the right neighbour', () => {
    expect(closeTabTransition(['a', 'b', 'c'], 'b', 'b')).toEqual({
      tabs: ['a', 'c'],
      route: '/invoices/c',
    });
  });

  it('closing the last-but-one active tab falls back to the left neighbour', () => {
    expect(closeTabTransition(['a', 'b'], 'b', 'b')).toEqual({
      tabs: ['a'],
      route: '/invoices/a',
    });
  });

  it('closing the only tab lands on the list, never on a route with no tab', () => {
    expect(closeTabTransition(['a'], 'a', 'a')).toEqual({ tabs: [], route: INVOICES_ROUTE });
    expect(closeTabTransition([DRAFT_TAB_ID], DRAFT_TAB_ID, DRAFT_TAB_ID)).toEqual({
      tabs: [],
      route: INVOICES_ROUTE,
    });
  });

  it('closing while no tab is active (on the list) only removes', () => {
    expect(closeTabTransition(['a', 'b'], 'a', null)).toEqual({ tabs: ['b'], route: null });
  });

  it('closing an id that is not open changes nothing', () => {
    const tabs = ['a', 'b'];
    expect(closeTabTransition(tabs, 'zz', 'a')).toEqual({ tabs, route: null });
  });
});

describe('closeTab', () => {
  /*
    The hook cannot be mounted here, so what is asserted is the contract it now
    obeys: every close is resolved against the *latest* list and against any
    navigation already queued in the same browser task. Threading those two
    values through two calls is exactly what two clicks in one task do.
  */
  it('keeps both closes when two inactive tabs are closed in one task', () => {
    // F1, Tier 2's live case: active `c`, close `a` then `b` in one task.
    const first = closeTab(['a', 'b', 'c'], 'a', '/invoices/c', null);
    expect(first.tabs).toEqual(['b', 'c']);
    expect(first.route).toBeNull();
    const second = closeTab(first.tabs, 'b', '/invoices/c', first.route);
    expect(second.tabs).toEqual(['c']);
    expect(second.route).toBeNull();
  });

  it('reads the active tab from the queued navigation, not the stale route', () => {
    // F1, Tier 1's case: close active `a` (queues `/invoices/b`), then close the
    // incoming `b` before the router has moved. Judging `b` by the *old* pathname
    // called it inactive, removed it without navigating, and left the app on
    // `/invoices/b` with an empty strip.
    const first = closeTab(['a', 'b'], 'a', '/invoices/a', null);
    expect(first).toEqual({
      tabs: ['b'],
      route: '/invoices/b',
      settleRoute: '/invoices/b',
      focus: { kind: 'tab', id: 'b' },
    });
    const second = closeTab(first.tabs, 'b', '/invoices/a', first.route);
    expect(second.tabs).toEqual([]);
    expect(second.route).toBe(INVOICES_ROUTE);
    expect(second.settleRoute).toBe(INVOICES_ROUTE);
  });

  it('suppresses nothing when nothing at all is in flight', () => {
    expect(closeTab(['a', 'b'], 'a', '/invoices/b', null).settleRoute).toBeNull();
  });

  it('waits on an already-queued navigation even when the close does not move', () => {
    // G2: the pill click has navigated, the close of a *different* tab does not —
    // but the route sync still has an uncommitted route to catch up with, so the
    // departure has to be suppressed until it lands.
    expect(closeTab(['a', 'b', 'c'], 'b', '/invoices/a', '/invoices/c').settleRoute).toBe(
      '/invoices/c',
    );
  });

  it('changes nothing, by reference, for an id that is not open', () => {
    // The hook uses this identity to decide there is no commit to focus after.
    const tabs = ['a'];
    expect(closeTab(tabs, 'zz', '/invoices/a', null).tabs).toBe(tabs);
  });

  it('treats the editor route as the tab it belongs to', () => {
    expect(closeTab(['a'], 'a', '/invoices/a/edit', null).route).toBe(INVOICES_ROUTE);
  });
});

describe('closeFocusTarget', () => {
  it('hands focus to the surviving right neighbour, else the left', () => {
    // F3: without this the close button's removal drops focus to <body>.
    expect(closeFocusTarget(['a', 'b', 'c'], 'b')).toEqual({ kind: 'tab', id: 'c' });
    expect(closeFocusTarget(['a', 'b', 'c'], 'c')).toEqual({ kind: 'tab', id: 'b' });
  });

  it('follows the same neighbour the route follows', () => {
    for (const id of ['a', 'b', 'c']) {
      const target = closeFocusTarget(['a', 'b', 'c'], id);
      expect(target).toEqual({ kind: 'tab', id: successorTabId(['a', 'b', 'c'], id) });
    }
  });

  it('lands on the page when the last tab closes and the strip unmounts', () => {
    expect(closeFocusTarget(['a'], 'a')).toEqual({ kind: 'page' });
  });

  it('falls back to the trailing + while the strip is still on screen', () => {
    expect(closeFocusTarget(['a', 'b'], 'zz')).toEqual({ kind: 'new' });
    expect(closeFocusTarget([], 'zz')).toEqual({ kind: 'page' });
  });
});

describe('forgetClosedLabels', () => {
  it('drops a closed tab’s number so reopening it fetches again', () => {
    // F4: the cache kept every closed tab's entry for the life of the window,
    // and the request guard kept a failed id from ever being asked for again.
    expect(forgetClosedLabels({ a: 'INV-0001', b: 'INV-0002' }, ['b'])).toEqual({
      b: 'INV-0002',
    });
    expect(forgetClosedLabels({ a: 'INV-0001' }, [])).toEqual({});
  });

  it('returns the same object when every label is still open', () => {
    // Reference identity, or the effect that calls it re-runs forever.
    const labels = { a: 'INV-0001' };
    expect(forgetClosedLabels(labels, ['a', DRAFT_TAB_ID])).toBe(labels);
    expect(forgetClosedLabels({}, ['a'])).toEqual({});
  });

  it('leaves a reopened tab eligible for a fresh request', () => {
    const kept = forgetClosedLabels({ a: 'INV-0001' }, []);
    expect(unlabelledTabIds(['a'], kept)).toEqual(['a']);
  });
});

describe('plusTransition', () => {
  it('opens a draft tab and navigates to the draft route', () => {
    expect(plusTransition(['a'])).toEqual({ tabs: ['a', 'new'], route: '/invoices/new' });
  });

  it('activates the existing draft instead of adding a second one', () => {
    // One draft route means at most one draft tab; pressing + twice is an
    // activation the second time, not an append.
    const once = plusTransition([]);
    const twice = plusTransition(once.tabs);
    expect(twice.tabs).toEqual([DRAFT_TAB_ID]);
    expect(twice.route).toBe('/invoices/new');
    expect(twice.tabs.filter((id) => id === DRAFT_TAB_ID)).toHaveLength(1);
  });
});

describe('labels', () => {
  const labels = { inv_42: 'INV-0042' };

  it('names the draft tab and an invoice tab', () => {
    expect(tabLabel(DRAFT_TAB_ID, labels)).toBe(DRAFT_TAB_LABEL);
    expect(tabLabel('inv_42', labels)).toBe('INV-0042');
  });

  it('shows a stable placeholder while the number is missing — never the raw id', () => {
    expect(tabLabel('inv_99', labels)).toBe(PENDING_TAB_LABEL);
    expect(tabLabel('inv_99', labels)).not.toContain('inv_99');
    expect(tabLabel('inv_99', labels)).not.toBe('');
  });

  it('names every close control after the invoice it closes', () => {
    expect(tabCloseLabel('inv_42', labels)).toBe('Close invoice INV-0042');
    expect(tabCloseLabel(DRAFT_TAB_ID, labels)).toBe('Close new invoice');
    expect(tabCloseLabel('inv_99', labels)).toBe('Close invoice inv_99');
    // Distinct names, so a screen-reader user can tell the buttons apart.
    expect(tabCloseLabel('inv_42', labels)).not.toBe(tabCloseLabel(DRAFT_TAB_ID, labels));
  });

  it('names two unlabelled close controls apart', () => {
    // F5: `['a','b']` with no labels used to give two buttons called
    // "Close invoice", and a failed fetch made that permanent. The id is in the
    // accessible name only — never in the visible label.
    const names = ['inv_a', 'inv_b'].map((id) => tabCloseLabel(id, {}));
    expect(new Set(names).size).toBe(2);
    expect(tabLabel('inv_a', {})).toBe(PENDING_TAB_LABEL);
    expect(tabLabel('inv_a', {})).not.toContain('inv_a');
  });

  it('does not give the + the same name as the tab it opens', () => {
    expect(NEW_TAB_BUTTON_LABEL).not.toBe(DRAFT_TAB_LABEL);
  });
});

describe('unlabelledTabIds', () => {
  it('asks only for invoice ids whose number is not cached yet', () => {
    expect(unlabelledTabIds(['inv_1', DRAFT_TAB_ID, 'inv_2'], { inv_1: 'INV-0001' })).toEqual([
      'inv_2',
    ]);
  });

  it('never asks for the draft tab, which has no invoice to fetch', () => {
    expect(unlabelledTabIds([DRAFT_TAB_ID], {})).toEqual([]);
  });

  it('asks for nothing once every number is cached — re-activating cannot refetch', () => {
    expect(unlabelledTabIds(['inv_1'], { inv_1: 'INV-0001' })).toEqual([]);
  });
});
