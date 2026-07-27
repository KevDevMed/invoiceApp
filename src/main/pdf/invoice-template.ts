/**
 * Invoice HTML template.
 *
 * A pure string function — no Electron, no DOM, no remote assets — so it is
 * unit-testable and safe to feed straight into an offscreen window as a data
 * URL. Every interpolated value goes through `escapeHtml`; a client named
 * `<script>` prints literally instead of executing.
 */

import type { Client, InvoiceWithItems } from '../../shared/types';
import { formatBpsAsPercent, formatMilli, formatMoney } from '../../shared/money';

export interface BusinessSettings {
  readonly name: string;
  readonly address: string;
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function money(cents: number, currency: string): string {
  // Fixed locale so the document renders identically on every machine.
  return formatMoney(cents, currency, 'en-US');
}

function multiline(value: string): string {
  return escapeHtml(value).replaceAll('\n', '<br>');
}

function clientBlock(client: Client | null): string {
  if (!client) return '<p class="muted">No client on record</p>';
  const lines = [
    client.name,
    client.addressLine1,
    client.addressLine2,
    [client.city, client.region, client.postalCode].filter(Boolean).join(', '),
    client.country,
    client.email,
    client.taxId ? `Tax ID: ${client.taxId}` : null,
  ].filter((line): line is string => Boolean(line && line.trim()));
  return `<p>${lines.map((line) => escapeHtml(line)).join('<br>')}</p>`;
}

export function renderInvoiceHtml(
  invoice: InvoiceWithItems,
  client: Client | null,
  business: BusinessSettings,
): string {
  const rows = invoice.items
    .map(
      (item) => `
        <tr>
          <td class="desc">${escapeHtml(item.description)}</td>
          <td class="num">${escapeHtml(formatMilli(item.quantityMilli))}</td>
          <td class="num">${escapeHtml(money(item.unitPriceCents, invoice.currency))}</td>
          <td class="num">${escapeHtml(money(item.amountCents, invoice.currency))}</td>
        </tr>`,
    )
    .join('');

  const notes = invoice.notes
    ? `<section class="notes"><h2>Notes</h2><p>${multiline(invoice.notes)}</p></section>`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Invoice ${escapeHtml(invoice.number)}</title>
<style>
  /* Print-sized for both A4 (210mm) and US Letter (215.9mm): the content
     column fits the narrower A4 width and centers on Letter. */
  @page { margin: 18mm 16mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: system-ui, -apple-system, 'Segoe UI', sans-serif;
    font-size: 11pt;
    color: #0b0b0b;
    background: #ffffff;
    max-width: 178mm;
    margin: 0 auto;
  }
  header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 24pt; }
  h1 { font-size: 20pt; margin: 0 0 4pt; }
  h2 { font-size: 10pt; text-transform: uppercase; letter-spacing: 0.06em; color: #52514e; margin: 0 0 6pt; }
  p { margin: 0; line-height: 1.45; }
  .muted { color: #898781; }
  .meta { text-align: right; }
  .meta table { border-collapse: collapse; margin-left: auto; }
  .meta td { padding: 1pt 0 1pt 12pt; }
  .meta td:first-child { color: #52514e; }
  .parties { display: flex; gap: 32pt; margin-bottom: 24pt; }
  .parties > div { flex: 1; }
  table.items { width: 100%; border-collapse: collapse; margin-bottom: 16pt; }
  table.items th {
    text-align: left; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.06em;
    color: #52514e; border-bottom: 1px solid #c3c2b7; padding: 0 6pt 6pt 0;
  }
  table.items td { border-bottom: 1px solid #e1e0d9; padding: 6pt 6pt 6pt 0; vertical-align: top; }
  table.items .num, table.items th.num { text-align: right; font-variant-numeric: tabular-nums; }
  .totals { margin-left: auto; width: 60mm; border-collapse: collapse; }
  .totals td { padding: 3pt 0; font-variant-numeric: tabular-nums; }
  .totals td:last-child { text-align: right; }
  .totals tr.grand td { border-top: 1px solid #0b0b0b; font-weight: 600; padding-top: 6pt; }
  .notes { margin-top: 24pt; }
  footer { margin-top: 32pt; font-size: 9pt; color: #898781; }
</style>
</head>
<body>
  <header>
    <div>
      <h1>Invoice</h1>
      <p class="muted">${escapeHtml(invoice.number)}</p>
    </div>
    <div class="meta">
      <table>
        <tr><td>Issue date</td><td>${escapeHtml(invoice.issueDate)}</td></tr>
        <tr><td>Due date</td><td>${escapeHtml(invoice.dueDate)}</td></tr>
        <tr><td>Status</td><td>${escapeHtml(invoice.status)}</td></tr>
        <tr><td>Currency</td><td>${escapeHtml(invoice.currency)}</td></tr>
      </table>
    </div>
  </header>

  <section class="parties">
    <div>
      <h2>From</h2>
      <p>${business.name.trim() ? multiline(business.name) : '<span class="muted">Your business</span>'}</p>
      ${business.address.trim() ? `<p>${multiline(business.address)}</p>` : ''}
    </div>
    <div>
      <h2>Bill to</h2>
      ${clientBlock(client)}
    </div>
  </section>

  <table class="items">
    <thead>
      <tr>
        <th>Description</th>
        <th class="num">Qty</th>
        <th class="num">Unit price</th>
        <th class="num">Amount</th>
      </tr>
    </thead>
    <tbody>${rows}
    </tbody>
  </table>

  <table class="totals">
    <tr><td>Subtotal</td><td>${escapeHtml(money(invoice.subtotalCents, invoice.currency))}</td></tr>
    <tr><td>Tax (${escapeHtml(formatBpsAsPercent(invoice.taxRateBps))}%)</td><td>${escapeHtml(money(invoice.taxCents, invoice.currency))}</td></tr>
    <tr class="grand"><td>Total</td><td>${escapeHtml(money(invoice.totalCents, invoice.currency))}</td></tr>
  </table>

  ${notes}

  <footer>Generated by InvoiceApp</footer>
</body>
</html>`;
}
