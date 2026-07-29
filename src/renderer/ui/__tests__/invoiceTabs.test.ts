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
  closeTabTransition,
  DRAFT_TAB_ID,
  DRAFT_TAB_LABEL,
  INVOICES_ROUTE,
  NEW_TAB_BUTTON_LABEL,
  openTabForPath,
  PENDING_TAB_LABEL,
  plusTransition,
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
  it('refuses to re-open the tab whose close is still in flight', () => {
    // The regression: the shorter list lands one render before the router
    // reports the new route, so the route still points at the closed tab.
    expect(syncTabs(['b'], '/invoices/a', '/invoices/a')).toEqual(['b']);
    expect(syncTabs(['b'], '/invoices/a/edit', '/invoices/a/edit')).toEqual(['b']);
  });

  it('syncs normally once the route has caught up', () => {
    expect(syncTabs(['b'], '/invoices/b', '/invoices/a')).toEqual(['b']);
    expect(syncTabs(['b'], '/invoices/c', '/invoices/a')).toEqual(['b', 'c']);
  });

  it('behaves like openTabForPath when nothing is closing', () => {
    expect(syncTabs([], '/invoices/a', null)).toEqual(['a']);
    const tabs = ['a'];
    expect(syncTabs(tabs, '/invoices', null)).toBe(tabs);
  });

  it('still re-opens an invoice the user navigates back to later', () => {
    // The suppression is scoped to the one route being left, not to the id.
    expect(syncTabs([], '/invoices/a', '/invoices/zz')).toEqual(['a']);
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
    expect(tabCloseLabel('inv_99', labels)).toBe('Close invoice');
    // Distinct names, so a screen-reader user can tell the buttons apart.
    expect(tabCloseLabel('inv_42', labels)).not.toBe(tabCloseLabel(DRAFT_TAB_ID, labels));
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
