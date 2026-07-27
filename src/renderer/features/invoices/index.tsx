/**
 * Invoices feature barrel. The route table mounts this under `invoices/*`, so
 * the list, the editor, and the new-invoice form are nested routes here.
 */

import { Route, Routes } from 'react-router';

import { InvoiceEditor } from './InvoiceEditor';
import { InvoiceList } from './InvoiceList';

export function InvoicesPage(): React.JSX.Element {
  return (
    <Routes>
      <Route index element={<InvoiceList />} />
      <Route path="new" element={<InvoiceEditor />} />
      <Route path=":id" element={<InvoiceEditor />} />
    </Routes>
  );
}
