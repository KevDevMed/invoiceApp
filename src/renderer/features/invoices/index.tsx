/**
 * Invoices feature barrel. The route table mounts this under `invoices/*`, so
 * the list, the read-only detail view, and the editor are nested routes here.
 *
 * `:id` is the detail page and `:id/edit` is the editor — opening an invoice
 * shows it before it offers to change it.
 */

import { Route, Routes } from 'react-router';

import { InvoiceDetail } from './InvoiceDetail';
import { InvoiceEditor } from './InvoiceEditor';
import { InvoiceList } from './InvoiceList';

export function InvoicesPage(): React.JSX.Element {
  return (
    <Routes>
      <Route index element={<InvoiceList />} />
      <Route path="new" element={<InvoiceEditor />} />
      <Route path=":id" element={<InvoiceDetail />} />
      <Route path=":id/edit" element={<InvoiceEditor />} />
    </Routes>
  );
}
