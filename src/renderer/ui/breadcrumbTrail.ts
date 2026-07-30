/**
 * The breadcrumb trail, as a pure function of the route.
 *
 * The shell used to argue that a breadcrumb was redundant — the nav says where
 * you are and the page heading says it again. That held while the content
 * column opened straight onto the page. It does not hold now: the tab strip put
 * a row of *sibling documents* above the heading, and the collapsed rail throws
 * the nav labels away entirely, so the one thing neither of them states is the
 * path you took to get here. The trail is a 36px band under the strip that says
 * it once, quietly, in supporting type.
 *
 * Pure and here rather than in the component for the same reason `chrome.ts`
 * exists: the root vitest project is `environment: 'node'`, so the band cannot
 * be mounted in a test but every decision it makes can be asserted directly.
 */

import { isSectionSelected, SECTION_ROUTES } from '../chrome';
import { DRAFT_TAB_ID, DRAFT_TAB_LABEL, INVOICES_ROUTE, PENDING_TAB_LABEL } from './invoiceTabsState';

/** One step of the trail. `href` absent means the step is not navigable. */
export interface BreadcrumbStep {
  readonly label: string;
  /** HashRouter href (`#/path`), or undefined for a step with no route. */
  readonly href?: string;
  /** The page you are on. Exactly one step carries it whenever the trail is non-empty. */
  readonly isCurrent: boolean;
}

/** Label of the deepest step on `/invoices/:id/edit`. */
export const EDIT_STEP_LABEL = 'Edit';

/** Last segment of the editor route. Mirrors `invoiceTabsState`'s own. */
const EDIT_SEGMENT = 'edit';

/**
 * The trail for a route.
 *
 * Three shapes, and no more:
 *
 *   - `[]` off the nav entirely (the 404 placeholder). An empty band beats a
 *     trail that names a page the nav does not have.
 *   - `[group, section]` for every top-level section. The group is the sidebar
 *     caption the section sits under and has no route of its own, so it is
 *     plain text — which is also what the design asks for, ancestor in
 *     secondary ink and current page in semibold.
 *   - the same plus one or two invoice steps, because `/invoices` is the only
 *     section whose children are documents rather than views of one page.
 *
 * `invoiceLabel` is the open invoice's number, which only the tab strip's label
 * cache knows (it arrives from an async `invoices:get`). Absent, the step wears
 * the same `PENDING_TAB_LABEL` its pill does, so the two never disagree about
 * what to call an invoice whose number has not landed yet.
 */
export function breadcrumbTrail(pathname: string, invoiceLabel?: string): readonly BreadcrumbStep[] {
  const section = SECTION_ROUTES.find((route) => isSectionSelected(pathname, route.path));
  if (section === undefined) return [];

  const ancestors: BreadcrumbStep[] =
    section.group === undefined ? [] : [{ label: section.group, isCurrent: false }];

  const leaves = section.path === INVOICES_ROUTE ? invoiceSteps(pathname, invoiceLabel) : [];

  return [
    ...ancestors,
    {
      label: section.label,
      href: `#${section.path}`,
      isCurrent: leaves.length === 0,
    },
    ...leaves,
  ].map((step, index, all) => ({ ...step, isCurrent: index === all.length - 1 }));
}

/**
 * The steps below `/invoices`, if any.
 *
 * The document routes are `new`, `:id` and `:id/edit` — the same three
 * `tabIdForPath` parses, and deliberately not derived from it: that function
 * answers "which tab owns this route", which collapses `:id` and `:id/edit`
 * onto one answer. The trail is the one place those two must stay distinct.
 */
function invoiceSteps(pathname: string, invoiceLabel?: string): readonly BreadcrumbStep[] {
  const rest = pathname.slice(INVOICES_ROUTE.length).split('/').filter(Boolean);
  const [id, tail] = rest;
  if (id === undefined) return [];
  if (id === DRAFT_TAB_ID) return [{ label: DRAFT_TAB_LABEL, isCurrent: true }];

  const document: BreadcrumbStep = {
    label: invoiceLabel ?? PENDING_TAB_LABEL,
    href: `#${INVOICES_ROUTE}/${id}`,
    isCurrent: true,
  };
  if (tail !== EDIT_SEGMENT) return [document];
  return [document, { label: EDIT_STEP_LABEL, isCurrent: true }];
}
