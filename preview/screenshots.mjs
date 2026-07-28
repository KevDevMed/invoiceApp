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

import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';
import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '.artifacts');
const ORIGIN = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:4300';
/**
 * The renderer is served under `/app` (the site root is the marketing landing
 * page). Renderer routing is hash-based, so every app route hangs off this.
 */
const APP_ORIGIN = `${ORIGIN}/app`;
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

/**
 * What `preview/seed.ts` produces, as a fixture contract. Kept in step with the
 * constants asserted in `preview/__tests__/seed.test.ts`; if the seed changes,
 * both move together.
 *
 * `seedOnBoot` only seeds an empty database, so a `preview-data/` directory left
 * over from an older, smaller seed survives untouched and the server happily
 * serves it. Every expectation below is then computed from that stale file and
 * the run fails somewhere far away — "seed provides a status narrow enough to
 * shrink the page", a 30s timeout in a range label — blaming the seed for a
 * fixture problem. The preflight below catches that before a browser opens.
 */
const SEED_CONTRACT = {
  clients: 10,
  invoices: 66,
  byStatus: { paid: 32, sent: 16, draft: 10, overdue: 4, void: 4 },
};

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

/**
 * Every way the served database differs from what the current seed produces, as
 * human-readable lines. Empty means the fixture is the current one.
 */
function fixtureMismatches(actual) {
  const lines = [];
  if (actual.clients !== SEED_CONTRACT.clients) {
    lines.push(`clients: current seed produces ${SEED_CONTRACT.clients}, this database holds ${actual.clients}`);
  }
  if (actual.listTotal !== SEED_CONTRACT.invoices) {
    lines.push(`invoices: current seed produces ${SEED_CONTRACT.invoices}, this database holds ${actual.listTotal}`);
  }
  const statuses = new Set([...Object.keys(SEED_CONTRACT.byStatus), ...actual.byStatus.keys()]);
  for (const status of [...statuses].sort()) {
    const want = SEED_CONTRACT.byStatus[status] ?? 0;
    const got = actual.byStatus.get(status) ?? 0;
    if (want !== got) lines.push(`status "${status}": current seed produces ${want}, this database holds ${got}`);
  }
  return lines;
}

/**
 * Refuses to assert anything against a database the current seed did not
 * produce. Prints the real cause and the remedy on the first lines of output —
 * a stale fixture must never surface as a failing UI check.
 */
function assertCurrentFixture(actual) {
  const mismatches = fixtureMismatches(actual);
  if (mismatches.length === 0) return;

  console.log('FAIL  preview database was not produced by the current seed');
  console.log('        This is a stale fixture, not a UI or seed defect. Nothing below was run.');
  console.log(`        database: ${DB_PATH}`);
  for (const line of mismatches) console.log(`        ${line}`);
  console.log('        Cause: seedOnBoot only seeds an empty database, so a preview-data/');
  console.log('        directory created by an earlier seed is served unchanged.');
  console.log('        Remedy: stop the preview server, then restart it as');
  console.log('        `PREVIEW_RESET=1 npm run preview:serve`, which wipes and reseeds the demo');
  console.log(`        tables — or delete ${DB_PATH}`);
  console.log('        and start the server again. Then rerun this harness.');
  process.exit(1);
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

/**
 * Geometry of the shared content column (`src/renderer/ui/Page.tsx`) and of the
 * scroll region that owns it, in CSS pixels:
 *
 *   { left, right }   the two gutters between the column and the region's
 *                     padding box — equal when the column is centred
 *   { columnWidth, availableWidth }  the column and the space it may occupy
 *
 * Found from the page's own h1 by walking up to the first scrolling ancestor,
 * so nothing here keys off a design-system class name. `clientWidth` is used for
 * the region so a vertical scrollbar is excluded from the available space.
 * Returns null when the page has no h1 or no scrolling ancestor.
 */
async function contentColumnGutters(page) {
  return page.evaluate(() => {
    const heading = document.querySelector('h1');
    if (!heading) return null;
    let node = heading;
    while (node.parentElement) {
      const region = node.parentElement;
      const styles = getComputedStyle(region);
      if (styles.overflowY === 'auto' || styles.overflowY === 'scroll') {
        const column = node.getBoundingClientRect();
        const box = region.getBoundingClientRect();
        const padLeft = parseFloat(styles.paddingLeft);
        const padRight = parseFloat(styles.paddingRight);
        const borderLeft = parseFloat(styles.borderLeftWidth);
        const contentLeft = box.left + borderLeft + padLeft;
        const availableWidth = region.clientWidth - padLeft - padRight;
        const left = column.left - contentLeft;
        return {
          left,
          right: availableWidth - left - column.width,
          columnWidth: column.width,
          availableWidth,
          // Content inside the column must not move: the h1 still starts at the
          // column's own left edge.
          headingOffset: heading.getBoundingClientRect().left - column.left,
          overflowsHorizontally: document.documentElement.scrollWidth > window.innerWidth,
        };
      }
      node = region;
    }
    return null;
  });
}

/** One line describing what contentColumnGutters measured, for check details. */
function gutterDetail(gutters) {
  if (gutters === null) return 'no scrolling ancestor found above the page h1';
  return (
    `left gutter: ${gutters.left.toFixed(1)}, right gutter: ${gutters.right.toFixed(1)}, ` +
    `column: ${gutters.columnWidth.toFixed(1)}, available: ${gutters.availableWidth.toFixed(1)}`
  );
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

/** How many of the current page's row checkboxes are checked. */
async function checkedRowCount(page) {
  const boxes = await bodyRows(page).getByRole('checkbox', { name: 'Select row' }).all();
  const states = await Promise.all(boxes.map((box) => box.isChecked()));
  return states.filter(Boolean).length;
}

/** The "N selected on this page" banner text, or null when no banner is shown. */
async function selectionBanner(page) {
  const banner = page.getByText(/\d+ selected on this page/);
  if ((await banner.count()) === 0) return null;
  return (await banner.first().innerText()).trim();
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
 * Reads the two colours dark mode has to change: the document body, and the
 * background of the widest painted element inside the page — the app shell,
 * which is what carries the white top bar, sidebar and rows in light mode.
 *
 * Kept as source rather than a function so the same reader backs both the
 * one-shot read and the browser-side wait predicate below. Nothing here keys
 * off a class name: the shell is found by paint and area, not by identity.
 */
const READ_PAINTED_COLORS = `(() => {
  const painted = (value) => Boolean(value) && value !== 'transparent' && !/,\\s*0\\)$/.test(value);
  let surface = null;
  let widest = 0;
  for (const element of document.querySelectorAll('body *')) {
    const background = getComputedStyle(element).backgroundColor;
    if (!painted(background)) continue;
    const box = element.getBoundingClientRect();
    const area = box.width * box.height;
    if (area > widest) {
      widest = area;
      surface = background;
    }
  }
  return { body: getComputedStyle(document.body).backgroundColor, surface };
})()`;

async function paintedColors(page) {
  return page.evaluate(READ_PAINTED_COLORS);
}

/**
 * Blocks until the page is really painted in `mode` — body *and* app shell.
 * The condition is the wait: no fixed padding, so a screenshot taken after
 * this resolves cannot land on a pre-repaint frame. Returns false on timeout
 * so the caller can report a FAIL instead of throwing.
 */
async function waitForTheme(page, mode) {
  const wantBright = mode === 'light';
  try {
    await page.waitForFunction(
      `(() => {
         const colors = ${READ_PAINTED_COLORS};
         if (!colors.surface) return false;
         const bright = (color) => {
           const parts = color.match(/[\\d.]+/g);
           if (!parts || parts.length < 3) return false;
           return (Number(parts[0]) + Number(parts[1]) + Number(parts[2])) / 3 > 128;
         };
         return bright(colors.body) === ${wantBright} && bright(colors.surface) === ${wantBright};
       })()`,
      null,
      { timeout: 15_000 },
    );
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

async function main() {
  // A shot from an earlier run must never stand in for one this run refused to
  // take: start from an empty directory.
  rmSync(ARTIFACTS, { recursive: true, force: true });
  mkdirSync(ARTIFACTS, { recursive: true });

  const expected = readFromSqlite();
  // Before a browser opens and before any expectation is trusted: is this the
  // fixture the current seed makes?
  assertCurrentFixture(expected);
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
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().waitFor();
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

  check('invoice list result count matches SQLite', await resultCount(page), expected.listTotal);
  check('first page renders one page of rows', await bodyRows(page).count(), 10);
  check('footer range label', await rangeLabel(page), `1-10 of ${expected.listTotal}`);
  check('first row is the newest invoice', await firstRowNumber(page), expected.numbersInOrder[0]);
  await shoot(page, 'invoices');

  // --- Content column centring ---------------------------------------------
  // Every route renders through the shared Page (src/renderer/ui/Page.tsx),
  // which caps its content column (1120 here, 860 on Settings). On a viewport
  // wider than the cap the leftover space has to be split into two equal
  // gutters; a column pinned to the left leaves the whole remainder on the
  // right. Both halves of the contract are asserted: symmetry when the cap
  // bites, and a full-width column when it does not.
  console.log('\nContent column centring');
  const CENTRE_TOLERANCE = 2;
  const wide = await contentColumnGutters(page);
  const wideCentred = checkTrue(
    'invoices column is centred at 1440 wide',
    wide !== null && Math.abs(wide.left - wide.right) <= CENTRE_TOLERANCE,
    gutterDetail(wide),
  );
  checkTrue(
    'invoices column cap actually bites at 1440 wide',
    wide !== null && Math.min(wide.left, wide.right) >= CENTRE_TOLERANCE,
    gutterDetail(wide),
  );
  checkTrue(
    'heading still starts at the column left edge',
    wide !== null && Math.abs(wide.headingOffset) <= CENTRE_TOLERANCE,
    `h1 offset from column left: ${wide === null ? 'not measured' : wide.headingOffset.toFixed(1)}`,
  );
  // Photographed only once the centring it illustrates is proven on screen.
  if (wideCentred) await shoot(page, 'invoices-centred');
  else console.log('  screenshot skipped: invoices-centred (column was not centred)');

  // A tighter cap on the same viewport — proof the gutters follow maxWidth
  // rather than a single hardcoded number.
  await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Settings', exact: true }).first().waitFor({ timeout: 15_000 });
  const settings = await contentColumnGutters(page);
  checkTrue(
    'settings column (cap 860) is centred at 1440 wide',
    settings !== null &&
      Math.abs(settings.left - settings.right) <= CENTRE_TOLERANCE &&
      Math.min(settings.left, settings.right) > 100,
    gutterDetail(settings),
  );

  // Narrow viewport: the cap no longer bites, so the column fills the region
  // and nothing spills sideways.
  await page.setViewportSize({ width: 900, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
  const narrow = await contentColumnGutters(page);
  checkTrue(
    'column still fills the width at 900 wide',
    narrow !== null &&
      Math.abs(narrow.columnWidth - narrow.availableWidth) <= CENTRE_TOLERANCE &&
      narrow.left <= CENTRE_TOLERANCE,
    gutterDetail(narrow),
  );
  checkTrue(
    'no horizontal page scrollbar at 900 wide',
    narrow !== null && !narrow.overflowsHorizontally,
    `document scrollWidth exceeds the viewport: ${narrow === null ? 'not measured' : narrow.overflowsHorizontally}`,
  );

  // Back to the viewport and the page the rest of the run expects.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

  // --- Pagination ----------------------------------------------------------
  console.log('\nPagination');
  await page.getByRole('button', { name: 'Go to next page' }).click();
  await page.waitForTimeout(400);
  check('page 2 range label', await rangeLabel(page), `11-20 of ${expected.listTotal}`);
  check('page 2 starts at the 11th invoice', await firstRowNumber(page), expected.numbersInOrder[10]);
  check('page 2 still renders ten rows', await bodyRows(page).count(), 10);

  await page.getByRole('button', { name: 'Go to previous page' }).click();
  await page.waitForTimeout(400);
  check('back on page 1', await rangeLabel(page), `1-10 of ${expected.listTotal}`);

  await page.getByRole('combobox', { name: 'Results per page' }).click();
  await page.getByRole('option', { name: '25', exact: true }).click();
  await page.waitForTimeout(400);
  check('25 per page renders 25 rows', await bodyRows(page).count(), 25);
  check('25 per page range label', await rangeLabel(page), `1-25 of ${expected.listTotal}`);

  await page.getByRole('combobox', { name: 'Results per page' }).click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await page.waitForTimeout(400);
  check('back to 10 per page', await bodyRows(page).count(), 10);

  // --- Selection -----------------------------------------------------------
  console.log('\nSelection');
  await page.getByRole('checkbox', { name: 'Select all rows' }).check();
  await page.waitForTimeout(300);
  const rowBoxes = await bodyRows(page).getByRole('checkbox', { name: 'Select row' }).all();
  const checkedStates = await Promise.all(rowBoxes.map((box) => box.isChecked()));
  const allChecked = check(
    'select-all checks every row checkbox',
    checkedStates.filter(Boolean).length,
    rowBoxes.length,
  );
  const countShown = check(
    'selection count matches the checked rows',
    (await page.getByText(/\d+ selected on this page/).innerText()).trim(),
    `${rowBoxes.length} selected on this page`,
  );
  // Photographed only once the selection it illustrates is proven on screen.
  if (allChecked && countShown) await shoot(page, 'invoices-selected');
  else console.log('  screenshot skipped: invoices-selected (selection did not hold)');

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
  const twoTokenCount = check(
    'two tokens narrow to the SQLite count',
    await resultCount(page),
    expected.paidForClient,
  );
  const twoTokenStatuses = await visibleStatuses(page);
  const twoTokenClients = await visibleClients(page);
  const twoTokenRows = checkTrue(
    'every row matches both tokens',
    twoTokenStatuses.length > 0 &&
      twoTokenStatuses.every((status) => status === 'paid') &&
      twoTokenClients.every((name) => name.includes(FILTER_CLIENT)),
    `statuses: ${twoTokenStatuses.join(',')} | clients: ${[...new Set(twoTokenClients)].join(',')}`,
  );
  // The typeahead list stays open over the first rows after a token is added;
  // close it so the shot shows the table the tokens produced. Waiting on the
  // options being gone beats waiting a fixed number of milliseconds.
  await page.keyboard.press('Escape');
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().click();
  const popoverClosed = await page
    .waitForFunction(
      `[...document.querySelectorAll('[role="option"]')].every((option) => {
         const box = option.getBoundingClientRect();
         return box.width === 0 || box.height === 0 || getComputedStyle(option).visibility === 'hidden';
       })`,
      null,
      { timeout: 5_000 },
    )
    .then(() => true)
    .catch(() => false);
  // Closing the popover is itself an interaction, so the state is re-asserted
  // here: the image is taken after the last check that describes it, not before.
  const stillFiltered = checkTrue(
    'filtered view is intact when the shot is taken',
    popoverClosed && (await resultCount(page)) === expected.paidForClient,
    `options open: ${!popoverClosed}, results: ${await resultCount(page)}`,
  );
  if (twoTokenCount && twoTokenRows && stillFiltered) await shoot(page, 'invoices-filtered');
  else console.log('  screenshot skipped: invoices-filtered (filtered state did not hold)');

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

  // --- Selection contract --------------------------------------------------
  // The contract, verbatim: "Changing the active filters, the search term, or
  // the sort order clears the row selection. Changing page or page size does
  // NOT clear it." Asserted against the contract, not against whatever the list
  // happens to do today.
  console.log('\nSelection contract');

  // (a) filters clear the selection, and clearing the filter does not bring it back.
  await page.getByRole('checkbox', { name: 'Select all rows' }).check();
  await page.waitForTimeout(300);
  check('contract baseline: select-all checks the whole page', await checkedRowCount(page), 10);

  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Void' },
  });
  await removeFilterToken(page, 'Status: is');
  check(
    'applying then clearing a filter leaves no selection banner',
    await selectionBanner(page),
    null,
  );
  check('applying then clearing a filter leaves no row checked', await checkedRowCount(page), 0);

  // Whatever the two checks above concluded, the next scenario starts clean.
  const headerBox = page.getByRole('checkbox', { name: 'Select all rows' });
  if (await headerBox.isChecked()) await headerBox.uncheck();
  await page.waitForTimeout(300);
  await headerBox.check();
  await page.waitForTimeout(300);
  await headerBox.uncheck();
  await page.waitForTimeout(300);

  // (b) paging and page size keep it. Page 2 holds none of the selected rows, so
  // the banner is legitimately absent there — the selection is read back on a
  // page that shows the selected rows again, after the page-size change sends
  // the list back to page one.
  await headerBox.check();
  await page.waitForTimeout(300);
  check('contract baseline: ten rows selected before paging', await checkedRowCount(page), 10);

  await page.getByRole('button', { name: 'Go to next page' }).click();
  await page.waitForTimeout(400);
  check('paging moved the list on', await rangeLabel(page), `11-20 of ${expected.listTotal}`);

  await page.getByRole('combobox', { name: 'Results per page' }).click();
  await page.getByRole('option', { name: '25', exact: true }).click();
  await page.waitForTimeout(400);
  check('page-size change shows the first page again', await rangeLabel(page), `1-25 of ${expected.listTotal}`);
  check('page and page-size changes keep the ten rows checked', await checkedRowCount(page), 10);
  check(
    'page and page-size changes keep the selection banner',
    await selectionBanner(page),
    '10 selected on this page',
  );

  // Back to the state the rest of the run expects: ten per page, nothing selected.
  await page.getByRole('combobox', { name: 'Results per page' }).click();
  await page.getByRole('option', { name: '10', exact: true }).click();
  await page.waitForTimeout(400);
  if (!(await headerBox.isChecked())) await headerBox.check();
  await page.waitForTimeout(300);
  await headerBox.uncheck();
  await page.waitForTimeout(300);

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
  await page.goto(`${APP_ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByText(FILTER_CLIENT).first().waitFor({ timeout: 15_000 });
  check(
    'clients page renders one page of clients',
    (await page.getByRole('row').count()) - 1,
    Math.min(10, expected.clients),
  );
  await shoot(page, 'clients');

  // --- Reports -------------------------------------------------------------
  console.log('\nReports tiles vs SQLite');
  await page.goto(`${APP_ORIGIN}/#/reports`, { waitUntil: 'networkidle' });
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
  await page.goto(`${APP_ORIGIN}/#/models`, { waitUntil: 'networkidle' });
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
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
  // The theme mode is persisted in the database, so a previous run may have
  // left it dark. Start from a known light baseline.
  await page.getByRole('radio', { name: 'Light' }).click();
  const lightSettled = await waitForTheme(page, 'light');
  const lightColors = await paintedColors(page);
  checkTrue(
    'light baseline paints body and app surface light',
    lightSettled,
    `body: ${lightColors.body}, surface: ${lightColors.surface}`,
  );

  await page.getByRole('radio', { name: 'Dark' }).click();
  const darkSettled = await waitForTheme(page, 'dark');
  const darkColors = await paintedColors(page);
  const repaintOk = checkTrue(
    'dark mode repaints body and app surface, not just body',
    darkSettled && darkColors.body !== lightColors.body && darkColors.surface !== lightColors.surface,
    `light: body ${lightColors.body} / surface ${lightColors.surface}\n        dark:  body ${darkColors.body} / surface ${darkColors.surface}`,
  );
  const rowsOk = check('dark mode keeps the list rendered', await bodyRows(page).count(), 10);
  // The shot exists to show dark mode. It is only taken once the page is
  // proven dark, so the artifact can never contradict the check above.
  if (repaintOk && rowsOk) await shoot(page, 'invoices-dark');
  else console.log('  screenshot skipped: invoices-dark (page was not dark)');

  await page.goto(`${APP_ORIGIN}/#/reports`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: /Revenue by month/ }).waitFor({ timeout: 15_000 });
  // The mode is persisted, but the reports route paints its own surface: wait
  // for that repaint too rather than assuming the previous page's state.
  const reportsSettled = await waitForTheme(page, 'dark');
  const reportsColors = await paintedColors(page);
  if (
    checkTrue(
      'reports page stays dark after navigation',
      reportsSettled,
      `body: ${reportsColors.body}, surface: ${reportsColors.surface}`,
    )
  ) {
    await shoot(page, 'reports-dark');
  } else {
    console.log('  screenshot skipped: reports-dark (page was not dark)');
  }

  await page.getByRole('radio', { name: 'Light' }).click();
  await waitForTheme(page, 'light');

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
