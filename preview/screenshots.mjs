/**
 * Drives the running preview with a real browser and proves it works.
 *
 *   node --import tsx --import ./preview/register-raw.mjs preview/server.ts   # terminal 1
 *   node preview/screenshots.mjs                                              # terminal 2
 *
 * Screenshots land in `preview/.artifacts/`. Nothing here trusts the API: every
 * number the pages show is checked against a direct read of the SQLite file, and
 * every interaction (filter tokens, clear all, pagination, page size, selection,
 * navigation, theme) is asserted on the resulting DOM rather than only
 * photographed.
 *
 * Locators are role- and text-based on purpose. The design system's class names
 * are not a contract; `getByRole('row')` and `getByRole('checkbox')` are.
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

/**
 * The preview server refuses PDF export and local-model calls with 501, and the
 * pages surface that in the UI. Those are the only console errors a healthy run
 * may produce; anything else fails the run.
 */
const TOLERATED_CONSOLE_ERRORS = [/501 \(Not Implemented\)/];

/** The client used for the two-token filter test. */
const FILTER_CLIENT = 'Northwind Analytics';

/** Major units for the "Amount at least" token. Compared against total_cents. */
const AMOUNT_THRESHOLD_MAJOR = 20_000;

const failures = [];
const shots = [];

function pass(label, detail) {
  console.log(`PASS  ${label}${detail === undefined ? '' : `\n        ${detail}`}`);
}

function fail(label, detail) {
  console.log(`FAIL  ${label}${detail === undefined ? '' : `\n        ${detail}`}`);
  failures.push(label);
}

/** Asserts equality, printing both sides whichever way it goes. */
function check(label, actual, expected) {
  const ok = Object.is(actual, expected);
  const detail = `expected: ${JSON.stringify(expected)}\n        actual:   ${JSON.stringify(actual)}`;
  if (ok) pass(label, detail);
  else fail(label, detail);
  return ok;
}

/** Asserts a condition that is not a simple equality. */
function checkTrue(label, condition, detail) {
  if (condition) pass(label, detail);
  else fail(label, detail);
  return condition;
}

function money(cents) {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(cents / 100);
}

// ---------------------------------------------------------------------------
// SQLite — the source of truth every screen assertion is compared against
// ---------------------------------------------------------------------------

function openDb() {
  return new Database(DB_PATH, {
    readonly: true,
    nativeBinding: existsSync(NODE_ABI_BINDING) ? NODE_ABI_BINDING : undefined,
  });
}

/** The reports summary and the list facts, computed straight out of the file. */
function readFromSqlite() {
  const db = openDb();
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

  // The list screen shows every invoice, void included.
  const listTotal = db.prepare('SELECT COUNT(*) AS n FROM invoices').get().n;
  const byStatus = new Map(
    db
      .prepare('SELECT status, COUNT(*) AS n FROM invoices GROUP BY status')
      .all()
      .map((entry) => [entry.status, entry.n]),
  );
  const aboveThreshold = db
    .prepare('SELECT COUNT(*) AS n FROM invoices WHERE total_cents >= ?')
    .get(AMOUNT_THRESHOLD_MAJOR * 100).n;
  const paidForClient = db
    .prepare(
      `SELECT COUNT(*) AS n FROM invoices i JOIN clients c ON c.id = i.client_id
       WHERE i.status = 'paid' AND c.name = ?`,
    )
    .get(FILTER_CLIENT).n;

  // Default list order: newest issue date first, invoice number breaking ties
  // (see sortInvoices in src/renderer/features/invoices/filters.ts).
  const numbersInOrder = db
    .prepare('SELECT number FROM invoices ORDER BY issue_date DESC, number ASC')
    .all()
    .map((entry) => entry.number);

  db.close();

  return {
    ...row,
    clients,
    months,
    listTotal,
    byStatus,
    aboveThreshold,
    paidForClient,
    numbersInOrder,
    outstandingCents: row.sentCents + row.overdueCents,
    totalInvoicedCents: row.draftCents + row.sentCents + row.paidCents + row.overdueCents,
  };
}

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

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
  shots.push(file);
  return file;
}

/** Data rows only — the header row has no per-row checkbox. */
function bodyRows(page) {
  return page.getByRole('row').filter({ has: page.getByRole('checkbox', { name: 'Select row' }) });
}

/** The filter bar's own live result count ("32 results"), as a number. */
async function resultCount(page) {
  const text = await page.getByRole('group', { name: 'Filter invoices' }).innerText();
  const match = /(\d[\d,]*)\s+results/.exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** The footer range label, e.g. "1-10 of 66". */
async function rangeLabel(page) {
  return (await page.getByText(/^\d+(-\d+)? of \d+$/).first().innerText()).trim();
}

async function firstRowNumber(page) {
  return (await bodyRows(page).first().getByText(/^INV-\d{4}$/).innerText()).trim();
}

/** Every visible row's status badge text, top to bottom. */
async function visibleStatuses(page) {
  return bodyRows(page)
    .getByText(/^(draft|sent|paid|overdue|void)$/)
    .allInnerTexts();
}

/** Every visible row's client name, top to bottom. */
async function visibleClients(page) {
  const rows = await bodyRows(page).all();
  return Promise.all(rows.map(async (row) => (await row.getByRole('cell').nth(1).innerText()).trim()));
}

/**
 * Adds one filter token through the UI exactly as a person would: open the
 * filter control, pick the field, pick the operator, pick or type the value.
 * Enum tokens apply as soon as the value is chosen; typed values need Apply.
 */
async function addFilterToken(page, { field, operator, value }) {
  // Opened from the keyboard: a plain click on the bar does not reopen the
  // field list right after a token was removed (see the report), and ArrowDown
  // on the focused combobox is the documented affordance either way.
  const bar = page.getByRole('combobox', { name: 'Filter invoices' });
  await bar.focus();
  await page.keyboard.press('ArrowDown');
  await page.getByRole('option', { name: field, exact: true }).click();

  // In the open token popover the comboboxes run: 0 the filter bar's own input,
  // 1 field, 2 operator, 3 value.
  if (operator !== undefined) {
    await page.waitForTimeout(300);
    await page.getByRole('combobox').nth(2).click();
    await page.waitForTimeout(300);
    await page.getByRole('option', { name: operator, exact: true }).click();
  }

  if (value.kind === 'option') {
    await page.waitForTimeout(300);
    await page.getByRole('combobox').nth(3).click();
    await page.getByRole('option', { name: value.label, exact: true }).click();
  } else {
    await page.getByRole('spinbutton').fill(String(value.number));
    await page.getByRole('button', { name: 'Apply' }).click();
  }

  // The list refetches on a 200ms debounce.
  await page.waitForTimeout(700);
}

/**
 * Removes every token still in the bar, one click at a time. Cleanup only —
 * the "Clear all" behaviour itself is asserted where it belongs.
 */
async function forceEmptyFilterBar(page) {
  for (let guard = 0; guard < 10; guard += 1) {
    const remaining = await page.getByRole('button', { name: /^Remove / }).count();
    if (remaining === 0) return;
    await page.getByRole('button', { name: /^Remove / }).last().click();
    await page.waitForTimeout(500);
  }
}

async function removeFilterToken(page, label) {
  await page.getByRole('button', { name: `Remove ${label}` }).click();
  await page.waitForTimeout(700);
}

/**
 * Clicks a control that may sit under the fixed preview banner at the bottom of
 * the window — the table footer does, once a page holds 25 rows. The banner is
 * preview chrome rather than app UI, so its overlap is not a finding, but it
 * does swallow pointer events; dispatching the click on the element itself
 * still exercises the component's real handler.
 */
async function clickThroughBanner(locator) {
  await locator.scrollIntoViewIfNeeded();
  await locator.evaluate((element) => {
    element.click();
  });
}

/** Background colour of the document body — the thing dark mode has to change. */
async function bodyBackground(page) {
  return page.evaluate(() => getComputedStyle(document.body).backgroundColor);
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });

  const expected = readFromSqlite();
  console.log('SQLite (read directly from the preview database file):');
  console.log(`  ${DB_PATH}`);
  console.log(
    `  invoices: ${expected.listTotal}, clients: ${expected.clients}, months: ${expected.months}`,
  );
  console.log(`  by status: ${JSON.stringify(Object.fromEntries(expected.byStatus))}`);
  console.log(`  paid invoices for ${FILTER_CLIENT}: ${expected.paidForClient}\n`);

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // --- Invoices: the list as it first renders ------------------------------
  console.log('Invoices list');
  await page.goto(`${ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().waitFor();
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

  check('invoice list result count matches SQLite', await resultCount(page), expected.listTotal);
  check('first page renders one page of rows', await bodyRows(page).count(), 10);
  check('footer range label', await rangeLabel(page), `1-10 of ${expected.listTotal}`);
  check('first row is the newest invoice', await firstRowNumber(page), expected.numbersInOrder[0]);
  await shoot(page, 'invoices');

  // The banner must be visible on the app itself, not just on one route.
  const bannerText = await page.locator('#preview-banner').innerText();
  checkTrue(
    'preview banner explains the desktop-only limits',
    bannerText.includes('PDF export and local models need the desktop app'),
    JSON.stringify(bannerText.replace(/\n/g, ' ')),
  );

  // --- Pagination ----------------------------------------------------------
  console.log('\nPagination');
  await clickThroughBanner(page.getByRole('button', { name: 'Go to next page' }));
  await page.waitForTimeout(400);
  check('page 2 range label', await rangeLabel(page), `11-20 of ${expected.listTotal}`);
  check('page 2 starts at the 11th invoice', await firstRowNumber(page), expected.numbersInOrder[10]);
  check('page 2 still renders ten rows', await bodyRows(page).count(), 10);

  await clickThroughBanner(page.getByRole('button', { name: 'Go to previous page' }));
  await page.waitForTimeout(400);
  check('back on page 1', await rangeLabel(page), `1-10 of ${expected.listTotal}`);

  await clickThroughBanner(page.getByRole('combobox', { name: 'Results per page' }));
  await page.getByRole('option', { name: '25', exact: true }).click();
  await page.waitForTimeout(400);
  check('25 per page renders 25 rows', await bodyRows(page).count(), 25);
  check('25 per page range label', await rangeLabel(page), `1-25 of ${expected.listTotal}`);

  await clickThroughBanner(page.getByRole('combobox', { name: 'Results per page' }));
  await page.getByRole('option', { name: '10', exact: true }).click();
  await page.waitForTimeout(400);
  check('back to 10 per page', await bodyRows(page).count(), 10);

  // --- Selection -----------------------------------------------------------
  console.log('\nSelection');
  await page.getByRole('checkbox', { name: 'Select all rows' }).check();
  await page.waitForTimeout(300);
  const rowBoxes = await bodyRows(page).getByRole('checkbox', { name: 'Select row' }).all();
  const checkedStates = await Promise.all(rowBoxes.map((box) => box.isChecked()));
  check('select-all checks every row checkbox', checkedStates.filter(Boolean).length, rowBoxes.length);
  check(
    'selection count matches the checked rows',
    (await page.getByText(/\d+ selected on this page/).innerText()).trim(),
    `${rowBoxes.length} selected on this page`,
  );
  await shoot(page, 'invoices-selected');

  await page.getByRole('checkbox', { name: 'Select all rows' }).uncheck();
  await page.waitForTimeout(300);
  check(
    'clearing the header checkbox clears the selection',
    await page.getByText(/\d+ selected on this page/).count(),
    0,
  );

  // --- Inline filters ------------------------------------------------------
  console.log('\nInline filters');
  const voidCount = expected.byStatus.get('void') ?? 0;
  checkTrue(
    'seed provides a status narrow enough to shrink the page',
    voidCount > 0 && voidCount < 10,
    `void invoices in SQLite: ${voidCount}`,
  );

  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Void' },
  });
  check('filtered result count matches SQLite', await resultCount(page), voidCount);
  check('filtered row count drops', await bodyRows(page).count(), voidCount);
  check('filtered range label', await rangeLabel(page), `1-${voidCount} of ${voidCount}`);
  const statuses = await visibleStatuses(page);
  checkTrue(
    'every remaining row satisfies the filter',
    statuses.length === voidCount && statuses.every((status) => status === 'void'),
    `row statuses: ${statuses.join(',')}`,
  );

  await removeFilterToken(page, 'Status: is');
  check('removing the token restores the full list', await resultCount(page), expected.listTotal);
  check('removing the token restores a full page of rows', await bodyRows(page).count(), 10);

  // Two tokens at once — the shot that has to look like the reference.
  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Paid' },
  });
  await addFilterToken(page, {
    field: 'Client',
    value: { kind: 'option', label: FILTER_CLIENT },
  });
  check('two tokens narrow to the SQLite count', await resultCount(page), expected.paidForClient);
  const twoTokenStatuses = await visibleStatuses(page);
  const twoTokenClients = await visibleClients(page);
  checkTrue(
    'every row matches both tokens',
    twoTokenStatuses.length > 0 &&
      twoTokenStatuses.every((status) => status === 'paid') &&
      twoTokenClients.every((name) => name.includes(FILTER_CLIENT)),
    `statuses: ${twoTokenStatuses.join(',')} | clients: ${[...new Set(twoTokenClients)].join(',')}`,
  );
  // The typeahead list stays open over the first rows after a token is added;
  // close it so the shot shows the table the tokens produced.
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().click();
  await page.waitForTimeout(400);
  await shoot(page, 'invoices-filtered');

  // --- Clear all -----------------------------------------------------------
  console.log('\nClear all');
  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.waitForTimeout(700);
  check('clear all restores the full result count', await resultCount(page), expected.listTotal);
  check('clear all restores a full page of rows', await bodyRows(page).count(), 10);
  check('clear all removes every token', await page.getByRole('button', { name: /^Remove / }).count(), 0);

  // Whatever the check above concluded, the remaining tests need an empty bar.
  // This is cleanup after the assertion, not a softer assertion.
  await forceEmptyFilterBar(page);

  // --- A token with a chosen operator and a typed value --------------------
  console.log('\nOperator + typed value');
  await addFilterToken(page, {
    field: 'Amount',
    operator: 'at least',
    value: { kind: 'number', number: AMOUNT_THRESHOLD_MAJOR },
  });
  check(
    `amount at least ${AMOUNT_THRESHOLD_MAJOR} matches SQLite`,
    await resultCount(page),
    expected.aboveThreshold,
  );
  await removeFilterToken(page, 'Amount: at least');
  check('removing the amount token restores the full list', await resultCount(page), expected.listTotal);

  // --- Navigation ----------------------------------------------------------
  console.log('\nNavigation');
  const navTargets = [
    { label: 'Clients', route: '/clients', heading: 'Clients' },
    { label: 'Reports', route: '/reports', heading: 'Reports' },
    { label: 'Models', route: '/models', heading: 'Models' },
    { label: 'Assistant', route: '/assistant', heading: 'Assistant' },
    { label: 'Settings', route: '/settings', heading: 'Settings' },
    { label: 'Invoices', route: '/invoices', heading: 'Invoices' },
  ];
  for (const target of navTargets) {
    await page.getByRole('navigation', { name: 'Side navigation' }).getByRole('link', { name: target.label, exact: true }).click();
    await page.waitForTimeout(900);
    const heading = await page.getByRole('heading', { level: 1 }).first().innerText();
    const hash = new URL(page.url()).hash;
    checkTrue(
      `sidebar "${target.label}" navigates and renders its page`,
      hash.startsWith(`#${target.route}`) && heading.trim() === target.heading,
      `hash: ${hash}, h1: ${JSON.stringify(heading.trim())}`,
    );
  }

  // --- Clients -------------------------------------------------------------
  await page.goto(`${ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByText(FILTER_CLIENT).first().waitFor({ timeout: 15_000 });
  check(
    'clients page renders one page of clients',
    (await page.getByRole('row').count()) - 1,
    Math.min(10, expected.clients),
  );
  await shoot(page, 'clients');

  // --- Reports -------------------------------------------------------------
  console.log('\nReports tiles vs SQLite');
  await page.goto(`${ORIGIN}/#/reports`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Revenue by month/ }).waitFor({ timeout: 15_000 });
  const chartBars = await page.locator('svg rect, svg path').count();
  checkTrue('revenue chart renders shapes', chartBars > 0, `svg shapes: ${chartBars}`);
  await shoot(page, 'reports');

  check('Total invoiced', await tileValue(page, 'Total invoiced'), money(expected.totalInvoicedCents));
  check('Paid', await tileValue(page, 'Paid'), money(expected.paidCents));
  check('Outstanding', await tileValue(page, 'Outstanding'), money(expected.outstandingCents));
  check('Overdue', await tileValue(page, 'Overdue'), money(expected.overdueCents));
  check('Draft', await tileValue(page, 'Draft'), money(expected.draftCents));

  // --- Models (desktop-only) ----------------------------------------------
  console.log('\nDesktop-only surfaces');
  await page.goto(`${ORIGIN}/#/models`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Models/ }).first().waitFor({ timeout: 15_000 });
  await page.waitForTimeout(1500);
  const modelsText = await page.locator('body').innerText();
  checkTrue(
    'models page explains the desktop-only state',
    /desktop-only|desktop app|llama\.cpp/i.test(modelsText),
    'looking for desktop-only / llama.cpp copy',
  );
  await shoot(page, 'models-desktop-only');

  // --- Download page ------------------------------------------------------
  await page.goto(`${ORIGIN}/download`, { waitUntil: 'networkidle' });
  const downloadHeading = (await page.getByRole('heading').first().innerText()).trim();
  checkTrue(
    'download page renders its heading',
    /InvoiceApp/i.test(downloadHeading),
    JSON.stringify(downloadHeading),
  );
  await shoot(page, 'download-page');

  // --- Dark mode ----------------------------------------------------------
  console.log('\nDark mode');
  await page.goto(`${ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
  // The theme mode is persisted in the database, so a previous run may have
  // left it dark. Start from a known light baseline.
  await page.getByRole('radio', { name: 'Light' }).click();
  await page.waitForTimeout(900);
  const lightBackground = await bodyBackground(page);
  await page.getByRole('radio', { name: 'Dark' }).click();
  await page.waitForTimeout(900);
  const darkBackground = await bodyBackground(page);
  checkTrue(
    'dark mode repaints the page background',
    darkBackground !== lightBackground,
    `light: ${lightBackground}, dark: ${darkBackground}`,
  );
  check('dark mode keeps the list rendered', await bodyRows(page).count(), 10);
  await shoot(page, 'invoices-dark');

  await page.goto(`${ORIGIN}/#/reports`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Revenue by month/ }).waitFor({ timeout: 15_000 });
  await shoot(page, 'reports-dark');

  await page.getByRole('radio', { name: 'Light' }).click();
  await page.waitForTimeout(600);

  await browser.close();

  // --- Console errors -----------------------------------------------------
  const unexpected = consoleErrors.filter(
    (error) => !TOLERATED_CONSOLE_ERRORS.some((pattern) => pattern.test(error)),
  );
  console.log('\nBrowser console');
  console.log(`  ${consoleErrors.length} error(s) seen, ${unexpected.length} unexpected`);
  for (const error of consoleErrors) console.log(`    ${error}`);
  checkTrue(
    'no unexpected browser console errors',
    unexpected.length === 0,
    unexpected.length === 0 ? 'only the desktop-only 501s' : unexpected.join(' | '),
  );

  console.log('\nArtifacts:');
  for (const shot of shots) console.log(`  ${shot}`);

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
