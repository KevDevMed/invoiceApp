/**
 * IPC handlers for the invoices domain, including PDF export.
 * Auto-discovered by the registry glob.
 */

import { getDatabase } from '../../db/client';
import {
  createInvoice,
  deleteInvoice,
  getInvoice,
  InvoiceNotFoundError,
  listInvoices,
  setInvoiceStatus,
  updateInvoice,
} from '../../domain/invoices/repository';
import { IPC_CONTRACT } from '../../shared/ipc-contract';
import { SETTINGS_KEYS } from '../../shared/types';
import { renderInvoiceHtml, type BusinessSettings } from '../pdf/invoice-template';
import { renderHtmlToPdf } from '../pdf/render';
import { registerHandler } from './registry';

function businessSettings(): BusinessSettings {
  const read = (key: string): string => {
    const row = getDatabase()
      .prepare<[string], { value: string }>('SELECT value FROM settings WHERE key = ?')
      .get(key);
    return row?.value ?? '';
  };
  return {
    name: read(SETTINGS_KEYS.businessName),
    address: read(SETTINGS_KEYS.businessAddress),
  };
}

export function register(): void {
  registerHandler('invoices:list', IPC_CONTRACT['invoices:list'].request, (payload) =>
    listInvoices(getDatabase(), payload),
  );

  registerHandler('invoices:get', IPC_CONTRACT['invoices:get'].request, ({ id }) =>
    getInvoice(getDatabase(), id),
  );

  registerHandler('invoices:create', IPC_CONTRACT['invoices:create'].request, (payload) =>
    createInvoice(getDatabase(), payload),
  );

  registerHandler('invoices:update', IPC_CONTRACT['invoices:update'].request, ({ id, patch }) =>
    updateInvoice(getDatabase(), id, patch),
  );

  registerHandler('invoices:delete', IPC_CONTRACT['invoices:delete'].request, ({ id }) =>
    deleteInvoice(getDatabase(), id),
  );

  registerHandler('invoices:setStatus', IPC_CONTRACT['invoices:setStatus'].request, ({ id, status }) =>
    setInvoiceStatus(getDatabase(), id, status),
  );

  registerHandler(
    'invoices:exportPdf',
    IPC_CONTRACT['invoices:exportPdf'].request,
    async ({ id, targetPath }) => {
      const db = getDatabase();
      const invoice = getInvoice(db, id);
      if (!invoice) throw new InvoiceNotFoundError(id);

      const html = renderInvoiceHtml(invoice, invoice.client, businessSettings());
      return renderHtmlToPdf(html, {
        targetPath,
        defaultFileName: `${invoice.number}.pdf`,
      });
    },
  );
}
