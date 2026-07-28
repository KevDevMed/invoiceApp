/**
 * Invoices feature barrel. The route table mounts this under `invoices/*`, so
 * the list, the read-only detail view, and the editor are nested routes here.
 *
 * `:id` is the detail page and `:id/edit` is the editor — opening an invoice
 * shows it before it offers to change it.
 */

import { Route, Routes, useParams } from 'react-router';

import { InvoiceDetail } from './InvoiceDetail';
import { InvoiceEditor } from './InvoiceEditor';
import { InvoiceList } from './InvoiceList';

/**
 * `new` and `:id/edit` render the same component type at the same position in
 * the tree, so React reconciles rather than remounts when you move between
 * them: one instance, and every `useState` in it survives the route change.
 * Keying by invoice id makes each route its own instance, so a new invoice
 * starts from a genuinely fresh editor instead of the last one's draft.
 */
function KeyedInvoiceEditor(): React.JSX.Element {
  const { id } = useParams<{ id: string }>();
  return <InvoiceEditor key={id ?? 'new'} />;
}

export function InvoicesPage(): React.JSX.Element {
  return (
    <Routes>
      <Route index element={<InvoiceList />} />
      <Route path="new" element={<KeyedInvoiceEditor />} />
      <Route path=":id" element={<InvoiceDetail />} />
      <Route path=":id/edit" element={<KeyedInvoiceEditor />} />
    </Routes>
  );
}
