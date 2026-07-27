/**
 * Drives the running preview with a real browser and proves it works.
 *
 *   node --import tsx --import ./preview/register-raw.mjs preview/server.ts   # terminal 1
 *   node preview/screenshots.mjs                                              # terminal 2
 *
 * Screenshots land in `preview/.artifacts/`. Every number the Reports page
 * shows is checked against a direct read of the SQLite file — not against the
 * API response, which would only prove the page renders whatever it is handed.
 *
 * Environment: PREVIEW_ORIGIN (default http://127.0.0.1:4300),
 *              PREVIEW_DB_PATH (default ./preview-data/preview.db).
 */

import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '.artifacts');
const ORIGIN = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:4300';
const DB_PATH = process.env.PREVIEW_DB_PATH ?? path.resolve(process.cwd(), 'preview-data/preview.db');

const NODE_ABI_BINDING = path.resolve(
  process.cwd(),
  'node_modules/better-sqlite3/build/node-abi/better_sqlite3.node',
);

const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}\n        sqlite: ${expected}\n        screen: ${actual}`);
  if (!ok) failures.push(label);
}

function money(cents) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

/** The summary, computed straight out of the database file. */
function readSummaryFromSqlite() {
  const db = new Database(DB_PATH, {
    readonly: true,
    nativeBinding: existsSync(NODE_ABI_BINDING) ? NODE_ABI_BINDING : undefined,
  });
  const asOf = new Date().toISOString().slice(0, 10);
  const row = db
    .prepare(
      `SELECT
         COUNT(*) AS invoiceCount,
         COALESCE(SUM(CASE WHEN status = 'draft' THEN total_cents END), 0) AS draftCents,
         COALESCE(SUM(CASE WHEN status = 'sent' AND due_date >= :asOf THEN total_cents END), 0) AS sentCents,
         COALESCE(SUM(CASE WHEN status = 'paid' THEN total_cents END), 0) AS paidCents,
         COALESCE(SUM(CASE WHEN (status = 'sent' AND due_date < :asOf) OR status = 'overdue'
                          THEN total_cents END), 0) AS overdueCents
       FROM invoices
       WHERE status != 'void'`,
    )
    .get({ asOf });
  const clients = db.prepare('SELECT COUNT(*) AS n FROM clients').get().n;
  const months = db
    .prepare("SELECT COUNT(DISTINCT strftime('%Y-%m-01', issue_date)) AS n FROM invoices WHERE status != 'void'")
    .get().n;
  db.close();

  return {
    ...row,
    clients,
    months,
    outstandingCents: row.sentCents + row.overdueCents,
    totalInvoicedCents: row.draftCents + row.sentCents + row.paidCents + row.overdueCents,
  };
}

/** Text of the stat tile with the given label, read off the rendered page. */
async function tileValue(page, label) {
  return page.evaluate((wanted) => {
    for (const element of document.querySelectorAll('*')) {
      if (element.children.length !== 0) continue;
      if (element.textContent?.trim() !== wanted) continue;
      const tile = element.closest('div')?.parentElement;
      const heading = tile?.querySelector('h1, h2, h3, h4, h5, h6');
      if (heading) return heading.textContent?.trim() ?? null;
    }
    return null;
  }, label);
}

async function shoot(page, name) {
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  console.log(`  screenshot: ${file}`);
  return file;
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const expected = readSummaryFromSqlite();
  console.log('SQLite (read directly from the preview database file):');
  console.log(`  ${DB_PATH}`);
  console.log(`  ${JSON.stringify(expected, null, 2).replace(/\n/g, '\n  ')}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  const shots = [];

  // --- Invoices -----------------------------------------------------------
  await page.goto(`${ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().waitFor();
  await page.getByText('INV-0001').first().waitFor({ timeout: 15_000 });
  const invoiceRows = await page.locator('text=/^INV-\\d{4}$/').count();
  console.log(`Invoices page: ${invoiceRows} invoice numbers rendered`);
  shots.push(await shoot(page, 'invoices'));

  // The banner must be visible on the app itself, not just on one route.
  const bannerText = await page.locator('#preview-banner').innerText();
  console.log(`Preview banner: ${JSON.stringify(bannerText.replace(/\n/g, ' '))}`);
  if (!bannerText.includes('PDF export and local models need the desktop app')) {
    failures.push('preview banner text');
  }

  // --- Clients ------------------------------------------------------------
  await page.goto(`${ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByText('Northwind Analytics').first().waitFor({ timeout: 15_000 });
  shots.push(await shoot(page, 'clients'));

  // --- Reports ------------------------------------------------------------
  await page.goto(`${ORIGIN}/#/reports`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Revenue by month/ }).waitFor({ timeout: 15_000 });
  const chartBars = await page.locator('svg rect, svg path').count();
  console.log(`Reports page: chart contains ${chartBars} svg shapes`);
  if (chartBars === 0) failures.push('revenue chart is empty');
  shots.push(await shoot(page, 'reports'));

  console.log('\nReports tiles vs SQLite:');
  check('Total invoiced', await tileValue(page, 'Total invoiced'), money(expected.totalInvoicedCents));
  check('Paid', await tileValue(page, 'Paid'), money(expected.paidCents));
  check('Outstanding', await tileValue(page, 'Outstanding'), money(expected.outstandingCents));
  check('Overdue', await tileValue(page, 'Overdue'), money(expected.overdueCents));
  check('Draft', await tileValue(page, 'Draft'), money(expected.draftCents));

  // --- Models (desktop-only) ---------------------------------------------
  await page.goto(`${ORIGIN}/#/models`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Models/ }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const modelsText = await page.locator('body').innerText();
  const saysDesktopOnly = /desktop-only|llama\.cpp/i.test(modelsText);
  console.log(`\nModels page mentions the desktop-only limitation: ${saysDesktopOnly}`);
  if (!saysDesktopOnly) failures.push('models page does not explain the desktop-only state');
  shots.push(await shoot(page, 'models-desktop-only'));

  // --- Download page ------------------------------------------------------
  await page.goto(`${ORIGIN}/download`, { waitUntil: 'networkidle' });
  shots.push(await shoot(page, 'download-page'));

  await browser.close();

  console.log('\nArtifacts:');
  for (const shot of shots) console.log(`  ${shot}`);

  if (consoleErrors.length > 0) {
    console.log('\nBrowser console errors seen (expected: the desktop-only refusals):');
    for (const error of consoleErrors) console.log(`  ${error}`);
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
