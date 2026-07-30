import { describe, expect, it } from 'vitest';

import { breadcrumbTrail, EDIT_STEP_LABEL } from '../breadcrumbTrail';

/** Labels only, which is what the band actually reads out. */
function labels(pathname: string, invoiceLabel?: string): readonly string[] {
  return breadcrumbTrail(pathname, invoiceLabel).map((step) => step.label);
}

/** The one step marked current, or null when the trail marks none. */
function current(pathname: string, invoiceLabel?: string): string | null {
  const marked = breadcrumbTrail(pathname, invoiceLabel).filter((step) => step.isCurrent);
  return marked.length === 1 ? (marked[0]?.label ?? null) : null;
}

describe('breadcrumbTrail', () => {
  it('names the sidebar group above the section', () => {
    expect(labels('/invoices')).toEqual(['Billing', 'Invoices']);
    expect(labels('/clients')).toEqual(['Billing', 'Clients']);
    expect(labels('/reports')).toEqual(['Insights', 'Reports']);
    expect(labels('/models')).toEqual(['Local AI', 'Models']);
    expect(labels('/assistant')).toEqual(['Local AI', 'Assistant']);
  });

  // Settings is the one section with no group — it is anchored in the footer,
  // under no caption — so there is no ancestor to name.
  it('has no ancestor for the ungrouped section', () => {
    expect(labels('/settings')).toEqual(['Settings']);
  });

  // The 404 placeholder. A trail naming a page the nav does not have is worse
  // than an empty band.
  it('is empty off the nav', () => {
    expect(breadcrumbTrail('/nowhere')).toEqual([]);
    expect(breadcrumbTrail('/')).toEqual([]);
  });

  it('marks exactly the last step as current', () => {
    expect(current('/invoices')).toBe('Invoices');
    expect(current('/settings')).toBe('Settings');
    expect(current('/invoices/inv_1', 'INV-0047')).toBe('INV-0047');
    expect(current('/invoices/inv_1/edit', 'INV-0047')).toBe(EDIT_STEP_LABEL);
  });

  // The current step is the page you are on; making it a link would be a link
  // to where you already are.
  it('gives every step but the last a route', () => {
    const trail = breadcrumbTrail('/invoices/inv_1/edit', 'INV-0047');
    expect(trail.map((step) => step.href)).toEqual([
      // The group is a sidebar caption, not a route.
      undefined,
      '#/invoices',
      '#/invoices/inv_1',
      undefined,
    ]);
  });

  describe('below /invoices', () => {
    it('names the draft rather than its route segment', () => {
      expect(labels('/invoices/new')).toEqual(['Billing', 'Invoices', 'New invoice']);
    });

    // A draft has no id to link to, and `new` is not a document.
    it('gives the draft step no route', () => {
      const trail = breadcrumbTrail('/invoices/new');
      expect(trail.at(-1)?.href).toBeUndefined();
    });

    it('uses the invoice number the tab strip already fetched', () => {
      expect(labels('/invoices/inv_1', 'INV-0047')).toEqual(['Billing', 'Invoices', 'INV-0047']);
    });

    // The number arrives asynchronously. Until it does the step wears the same
    // placeholder its pill does, so the two never disagree on screen.
    it('falls back to the tab strip’s own placeholder', () => {
      expect(labels('/invoices/inv_1')).toEqual(['Billing', 'Invoices', 'Invoice']);
    });

    it('separates viewing an invoice from editing it', () => {
      expect(labels('/invoices/inv_1/edit', 'INV-0047')).toEqual([
        'Billing',
        'Invoices',
        'INV-0047',
        EDIT_STEP_LABEL,
      ]);
    });

    // A trailing slash is a route the router still resolves; an empty segment
    // must not become an empty step.
    it('ignores empty segments', () => {
      expect(labels('/invoices/')).toEqual(['Billing', 'Invoices']);
    });
  });

  // The nav highlights a section for anything nested under it, and the trail
  // has to agree — but only for real children, not for a prefix match.
  it('does not treat a prefix sibling as nested', () => {
    expect(breadcrumbTrail('/invoices-archive')).toEqual([]);
  });
});
