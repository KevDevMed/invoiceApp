/**
 * Drives the running preview with a real browser and proves it works.
 *
 *   node --import tsx --import ./preview/register-raw.mjs preview/server.ts   # terminal 1
 *   node preview/screenshots.mjs                                              # terminal 2
 *
 * Screenshots land in `preview/.artifacts/`. Nothing here trusts the API: every
 * number the pages show is checked against a direct read of the SQLite file, and
 * every interaction (row selection, J/K, segments, filter tokens, clear all,
 * navigation, theme, the editor's ghost row and its pager) is asserted on the
 * resulting DOM rather than only photographed.
 *
 * Locators are role- and text-based on purpose. The design system's class names
 * are not a contract; `getByRole('radio')`, `getByRole('textbox')` and the rows'
 * own accessible names are. The exceptions are the handful of app-owned classes
 * the shell sets deliberately — `.app-side-nav`, `.app-drag-region`,
 * `.app-unified-title-bar`, `.app-breadcrumb-bar`, `.app-invoice-tab*` — and
 * computed styles, which no locator can read.
 *
 * Rebuilt for the turn-3 designs: the shell's 40px bands, 56px collapsed rail
 * and breadcrumb band (option 3a), the invoice list's triage cockpit (option
 * 3c), and the editor's quiet line table and paper preview (option 2a). The
 * invoice *table* is gone, so everything that read a `row`, a row checkbox, a
 * page-size combobox or an `Open` button went with it.
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
// The cockpit's arithmetic, recomputed here from the raw rows
// ---------------------------------------------------------------------------

/*
  The triage list is not a page of a query any more: it is the whole set,
  bucketed by *when* rather than by status, each bucket carrying a per-currency
  sum. None of that is a number the API hands over — the renderer derives it in
  `features/invoices/listGrouping.ts` — so the only way to check it against the
  database is to derive it a second time, here, from the raw rows.

  This is a deliberate second implementation, not a shared one: a helper
  imported from `src/` would agree with the screen by construction and prove
  nothing. It is short because the rules are short, and where the rules are
  subtle (which side of "today" a due date falls on, which bucket a `sent`
  invoice lands in) that is exactly the part worth stating twice.
*/

const DAY_MS = 24 * 60 * 60 * 1000;
const DUE_SOON_DAYS = 7;
const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Whole calendar days from `from` to `to`, both `YYYY-MM-DD`. */
function daysBetween(from, to) {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/** `2026-08-18` -> `18 Aug`, with the year only when it is not this year. */
function shortDate(iso, today) {
  const [year, month, day] = iso.slice(0, 10).split('-');
  const label = MONTHS_SHORT[Number(month) - 1];
  const dayText = String(Number(day));
  return year === today.slice(0, 4) ? `${dayText} ${label}` : `${dayText} ${label} ${year}`;
}

function plural(count, unit) {
  return `${count} ${unit}${count === 1 ? '' : 's'}`;
}

/**
 * Which bucket a row is in. `sent` is the only status re-read against the
 * clock: sent and past its due date is overdue whether or not a job has run to
 * restate it, which is the rule the screen applies too.
 */
function rowStateOf(invoice, today) {
  if (invoice.status === 'void') return 'void';
  if (invoice.status === 'paid') return 'paid';
  if (invoice.status === 'draft') return 'draft';
  if (invoice.status === 'overdue') return 'overdue';
  const days = daysBetween(today, invoice.dueDate);
  if (days < 0) return 'overdue';
  return days <= DUE_SOON_DAYS ? 'due-soon' : 'later';
}

/** The half-sentence on a row's second line, after its number. */
function relativeTiming(invoice, state, today) {
  switch (state) {
    case 'overdue': {
      const late = Math.max(daysBetween(invoice.dueDate, today), 0);
      return late > 0 ? `${plural(late, 'day')} late` : 'marked overdue';
    }
    case 'due-soon': {
      const days = daysBetween(today, invoice.dueDate);
      if (days <= 0) return 'due today';
      if (days === 1) return 'due tomorrow';
      return `due in ${plural(days, 'day')}`;
    }
    case 'later':
      return `due ${shortDate(invoice.dueDate, today)}`;
    case 'draft':
      return `edited ${shortDate(invoice.updatedAt, today)}`;
    case 'paid':
      return invoice.paidAt === null ? 'paid' : `paid ${shortDate(invoice.paidAt, today)}`;
    default:
      return `voided ${shortDate(invoice.updatedAt, today)}`;
  }
}

const GROUP_ORDER = ['overdue', 'due-soon', 'later', 'drafts', 'paid', 'void'];
const GROUP_TITLES = {
  overdue: 'Overdue',
  'due-soon': 'Due this week',
  later: 'Later',
  drafts: 'Drafts',
  paid: 'Paid',
  void: 'Void',
};

const SEGMENTS = [
  { key: 'all', label: 'All', matches: () => true },
  { key: 'overdue', label: 'Overdue', matches: (state) => state === 'overdue' },
  { key: 'sent', label: 'Sent', matches: (state) => state === 'due-soon' || state === 'later' },
  { key: 'drafts', label: 'Drafts', matches: (state) => state === 'draft' },
];

/** Per-currency totals, biggest first — never one number across currencies. */
function sumByCurrency(invoices) {
  const byCurrency = new Map();
  for (const invoice of invoices) {
    byCurrency.set(invoice.currency, (byCurrency.get(invoice.currency) ?? 0) + invoice.totalCents);
  }
  return [...byCurrency]
    .map(([currency, cents]) => ({ currency, cents }))
    .sort((a, b) => b.cents - a.cents || a.currency.localeCompare(b.currency));
}

/** `$42,915` — the rounded headline figure the group captions carry. */
function formatMoneyRounded(cents, currency) {
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency,
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

/** `$42,915 · €8,100 +1` — totals joined, the remainder counted. */
function formatCurrencyTotals(totals, maxEntries = 2) {
  if (totals.length === 0) return '';
  const shown = totals.slice(0, Math.max(maxEntries, 1));
  const rest = totals.length - shown.length;
  const joined = shown.map((total) => formatMoneyRounded(total.cents, total.currency)).join(' · ');
  return rest > 0 ? `${joined} +${rest}` : joined;
}

/** `+3 currencies`, or null when the leading figure is the whole story. */
function extraCurrencyLabel(count) {
  if (count <= 0) return null;
  return `+${count} ${count === 1 ? 'currency' : 'currencies'}`;
}

/**
 * One headline figure plus a note that it is not the whole set — the shape the
 * captions and the page header took when `£124,333 · €103,073 · $83,819 +1`
 * turned out to be a wall rather than a sentence.
 *
 * Deliberately a second implementation of `summariseTotals` in
 * `features/invoices/listGrouping.ts`, for the same reason the bucketing above
 * is: importing it would agree with the screen by construction.
 *
 *   lead             the biggest per-currency total, formatted — or the
 *                    `preferredCurrency`'s total when the set holds it, which
 *                    is how the header keeps its two figures in one money
 *   more             `+3 currencies`, or null
 *   full             every currency joined — what the disclosure reveals, and
 *                    the string the old single-element assertions checked
 *   extraCurrencies  how many currencies `lead` is standing in front of
 */
function summariseTotals(totals, preferredCurrency = null) {
  const preferred =
    preferredCurrency === null
      ? undefined
      : totals.find((total) => total.currency === preferredCurrency);
  const first = preferred ?? totals[0];
  if (first === undefined) {
    return { lead: '', leadCurrency: null, more: null, full: '', extraCurrencies: 0 };
  }
  const extra = totals.length - 1;
  return {
    lead: formatMoneyRounded(first.cents, first.currency),
    leadCurrency: first.currency,
    more: extraCurrencyLabel(extra),
    full: formatCurrencyTotals(totals, totals.length),
    extraCurrencies: extra,
  };
}

/**
 * A caption's two elements as one printable line, for the check details and the
 * run's opening summary. The `[...]` is the harness's own punctuation, not the
 * screen's: the parts are asserted separately, and joining them without a
 * marker is exactly the mistake that made the previous assertion read
 * `Overdue · £124,333+3 currencies`.
 */
function captionLine(parts) {
  return parts.more === null ? parts.label : `${parts.label}  [${parts.more}]`;
}

/**
 * Within a group: open groups by due date, settled ones by when they last
 * moved, newest first.
 *
 * The settled groups sort on the *full* timestamps, not the calendar dates the
 * rows print. The seed now spreads `updated_at` and `paid_at` over real spans
 * rather than stamping them all at seed time, so the dates mostly differ — but
 * they still collide often enough (32 paid rows over 32 distinct days is one
 * per day at best) that sorting on the sliced date alone falls through to the
 * number tie-break and reverses pairs the screen shows the other way round.
 */
function compareInGroup(group, a, b) {
  let primary = 0;
  if (group === 'overdue' || group === 'due-soon' || group === 'later') {
    primary = a.dueDate.localeCompare(b.dueDate);
  } else if (group === 'paid') {
    primary = (b.paidAtFull ?? b.updatedAtFull).localeCompare(a.paidAtFull ?? a.updatedAtFull);
  } else {
    primary = b.updatedAtFull.localeCompare(a.updatedAtFull);
  }
  return primary !== 0 ? primary : a.number.localeCompare(b.number);
}

/**
 * Everything the cockpit states, for one segment: the group captions in order,
 * the rows under each, and the flattened reading order `J`/`K` walk.
 */
function cockpitFor(invoices, today, segment = 'all') {
  const matcher = SEGMENTS.find((entry) => entry.key === segment).matches;
  const buckets = new Map();
  for (const invoice of invoices) {
    const state = rowStateOf(invoice, today);
    if (!matcher(state)) continue;
    const key = state === 'draft' ? 'drafts' : state;
    const rows = buckets.get(key);
    if (rows === undefined) buckets.set(key, [invoice]);
    else rows.push(invoice);
  }

  const groups = [];
  for (const key of GROUP_ORDER) {
    const rows = buckets.get(key);
    if (rows === undefined || rows.length === 0) continue;
    rows.sort((a, b) => compareInGroup(key, a, b));
    // Paid carries no sum: money that has arrived is not money being chased,
    // and printing it beside four chase totals invites adding it to them.
    const totals = key === 'paid' ? [] : sumByCurrency(rows);
    const summary = summariseTotals(totals);
    // Two elements, not one string. The caption's leading currency is printed
    // at full strength and the rest ride beside it as a secondary-text label,
    // so `label` and `more` are separate nodes on screen and are asserted as
    // separate nodes here.
    const label = summary.lead === '' ? GROUP_TITLES[key] : `${GROUP_TITLES[key]} · ${summary.lead}`;
    groups.push({
      key,
      title: GROUP_TITLES[key],
      label,
      more: summary.more,
      full: summary.full,
      currencyCount: totals.length,
      caption: captionLine({ label, more: summary.more }),
      rows: rows.map((invoice) => ({
        id: invoice.id,
        number: invoice.number,
        clientName: invoice.clientName,
        // Which year the row was created in decides whether its Activity gutter
        // has to hold `15 Aug` or `15 Aug 2025` — the case the gutter widened
        // for, and the one worth photographing.
        createdYear: invoice.createdYear ?? null,
        timing: relativeTiming(invoice, rowStateOf(invoice, today), today),
        secondary: `${invoice.number} · ${relativeTiming(invoice, rowStateOf(invoice, today), today)}`,
      })),
    });
  }

  const flat = groups.flatMap((group) => group.rows);
  return { groups, flat, numbers: flat.map((row) => row.number) };
}

/** The four segment buttons, exactly as they are labelled on screen. */
function segmentLabels(invoices, today) {
  return SEGMENTS.map((segment) => {
    const count = invoices.filter((invoice) => segment.matches(rowStateOf(invoice, today))).length;
    return `${segment.label} ${count}`;
  });
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

  /*
    Every row the cockpit groups, with the four facts each row's second line and
    each group's caption are made of. `calendarDateOf` in the renderer is a
    `slice(0, 10)` on the stored ISO timestamp — no timezone conversion — so the
    same slice is taken here rather than a `Date` round trip that could move a
    late-evening row onto the next day.
  */
  const invoiceRows = db
    .prepare(
      `SELECT i.id, i.number, i.status, i.due_date AS dueDate, i.total_cents AS totalCents,
              i.currency, substr(i.updated_at, 1, 10) AS updatedAt,
              substr(i.paid_at, 1, 10) AS paidAt,
              i.updated_at AS updatedAtFull, i.paid_at AS paidAtFull,
              substr(i.created_at, 1, 4) AS createdYear,
              c.name AS clientName
         FROM invoices i JOIN clients c ON c.id = i.client_id`,
    )
    .all()
    .map((entry) => ({ ...entry, paidAt: entry.paidAt ?? null, paidAtFull: entry.paidAtFull ?? null }));

  db.close();

  const cockpit = cockpitFor(invoiceRows, asOf, 'all');
  const overdueSegment = cockpitFor(invoiceRows, asOf, 'overdue');

  /*
    The breadcrumb band's status line and the Invoices nav count are the same
    pair, and that pair is now *date-derived* — the same definition the
    segmented control uses, via `countOpenInvoices` in `listGrouping.ts`.

    It used to read the stored `status` column, which meant the word "overdue"
    had two meanings on one screen: the breadcrumb said 4 (rows a job had got
    round to restating) while the `Overdue` segment two inches below said 17
    (rows whose due date has passed). Both were defensible and one screen can
    only have one. So this is recomputed here from the raw rows and the clock,
    not read back off `status` — deriving it the same way the source does is
    the point, and the two figures are asserted equal on screen below.
  */
  const openStates = invoiceRows.map((invoice) => rowStateOf(invoice, asOf));
  const shellOpen = openStates.filter(
    (state) => state === 'overdue' || state === 'due-soon' || state === 'later',
  ).length;
  const shellOverdue = openStates.filter((state) => state === 'overdue').length;

  // The page header's two figures, as `summariseTotals` makes them: outstanding
  // leads with its own biggest currency, and its overdue slice is asked to lead
  // with that same currency so the two amounts in one sentence are the same
  // money. Both `full` strings are what the `+N currencies` disclosure reveals.
  const outstandingSummary = summariseTotals(
    sumByCurrency(
      invoiceRows.filter((invoice) => {
        const state = rowStateOf(invoice, asOf);
        return state === 'overdue' || state === 'due-soon' || state === 'later';
      }),
    ),
  );
  const overdueSummary = summariseTotals(
    sumByCurrency(invoiceRows.filter((invoice) => rowStateOf(invoice, asOf) === 'overdue')),
    outstandingSummary.leadCurrency,
  );

  return {
    ...row,
    asOf,
    clients,
    months,
    listTotal,
    byStatus,
    aboveThreshold,
    paidForClient,
    invoiceRows,
    cockpit,
    overdueSegment,
    segmentLabels: segmentLabels(invoiceRows, asOf),
    outstandingSummary,
    overdueSummary,
    outstandingLine: `${outstandingSummary.lead} outstanding`,
    overdueLine: `· ${overdueSummary.lead} overdue`,
    // The disclosure control's own label is the larger of the two remainders.
    breakdownLabel: extraCurrencyLabel(
      Math.max(outstandingSummary.extraCurrencies, overdueSummary.extraCurrencies),
    ),
    shellOpen,
    shellOverdue,
    shellStatusLine: `${shellOpen} open · ${shellOverdue} overdue`,
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
 *   { regionScrollWidth, regionClientWidth }  the region's own overflow, which
 *                     the document's width does not see: the region owns
 *                     `overflow: auto`, so it can scroll sideways on its own
 *   { documentScrollWidth, viewportWidth }  the separate, document-level check
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
          // Raw widths only; the tolerance that turns them into an overflow
          // verdict lives in Node, next to the other centring tolerances.
          regionScrollWidth: region.scrollWidth,
          regionClientWidth: region.clientWidth,
          documentScrollWidth: document.documentElement.scrollWidth,
          viewportWidth: window.innerWidth,
        };
      }
      node = region;
    }
    return null;
  });
}

/**
 * Sideways overflow of the shell's content pane, `.astryx-layout-content`.
 *
 * A separate reading from `contentColumnGutters` above, which measures the
 * scroll region around the *page* column. This one is the pane the design
 * system owns, and it is the box a decoration can bloom out of: the assistant
 * dock's `border-beam` used the `pulse-outside` preset, whose `inset: -30px`
 * glow hung 12px past the content box and gave every route a horizontal
 * scrollbar — visible on screen, invisible to every check the harness had,
 * because the document itself never grew.
 *
 * `widest` names the worst offender for the failure message. It cannot see a
 * pseudo-element, which is exactly what a beam usually is, so the verdict is
 * `scrollWidth` versus `clientWidth`; the name is a hint, not the check. It is
 * only looked for when the pane really is overflowing — a screen-reader-only
 * label parked off to one side is always the widest thing in the box, and
 * printing it on every passing route reads like a finding when it is not one.
 */
async function layoutContentOverflow(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.astryx-layout-content');
    if (pane === null) return null;
    const box = pane.getBoundingClientRect();
    let worst = null;
    if (pane.scrollWidth > pane.clientWidth) {
      for (const element of pane.querySelectorAll('*')) {
        const rect = element.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        if (getComputedStyle(element).clipPath !== 'none') continue;
        const spill = Math.max(rect.right - box.right, box.left - rect.left);
        if (spill > (worst?.spill ?? 1)) {
          worst = {
            spill,
            what: `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}">`,
          };
        }
      }
    }
    return {
      scrollWidth: pane.scrollWidth,
      clientWidth: pane.clientWidth,
      overflowX: getComputedStyle(pane).overflowX,
      widest: worst,
    };
  });
}

/**
 * The pane's Activity date gutter, cell by cell.
 *
 * Found by computed style and by the shape of the text — an inline-block that
 * refuses to wrap, holding `15 Aug` or `15 Aug 2025`. The gutter went 52px to
 * 76px because `shortDate` appends the year for any date outside the current
 * one and the longer form wrapped onto a second line, shunting every event
 * description down half a row. `lines` counts the text's own client rects, so
 * a wrap is counted rather than inferred from a height.
 */
async function activityGutterCells(page) {
  return page.evaluate(() => {
    const dateText = /^\d{1,2} [A-Z][a-z]{2}( \d{4})?$/;
    return [...document.querySelectorAll('*')]
      .filter((element) => dateText.test((element.textContent ?? '').trim()))
      .filter((element) => {
        const styles = getComputedStyle(element);
        return styles.display === 'inline-block' && styles.whiteSpace === 'nowrap';
      })
      .map((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          text: (element.textContent ?? '').trim(),
          width: element.getBoundingClientRect().width,
          lines: range.getClientRects().length,
          textWidth: range.getBoundingClientRect().width,
        };
      });
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

/**
 * Photographs one band of the window rather than the whole of it.
 *
 * Several of the things option 3a added are 36–40px tall and full width: shot
 * against a 960px-tall window they are a hairline nobody will ever look at.
 * `pad` grows the crop so the band is seen in the context that gives it its
 * meaning — the strip above it, the content below.
 */
async function shootRegion(page, name, box, pad = 12) {
  if (box === null || box === undefined) {
    console.log(`  screenshot skipped: ${name} (nothing to crop)`);
    return null;
  }
  const viewport = page.viewportSize();
  const clip = {
    x: Math.max(0, Math.round(box.left - pad)),
    y: Math.max(0, Math.round(box.top - pad)),
    width: Math.min(viewport.width, Math.round(box.width + pad * 2)),
    height: Math.min(viewport.height, Math.round(box.height + pad * 2)),
  };
  clip.width = Math.min(clip.width, viewport.width - clip.x);
  clip.height = Math.min(clip.height, viewport.height - clip.y);
  const file = path.join(ARTIFACTS, `${name}.png`);
  await page.screenshot({ path: file, clip });
  console.log(`  screenshot: ${file}`);
  shots.push(file);
  return file;
}

// ---------------------------------------------------------------------------
// The invoices cockpit, on screen
// ---------------------------------------------------------------------------

/*
  There is no table any more, so there is no `getByRole('row')` and no row
  checkbox. A row is a two-line `Item` whose only ARIA is the invisible button
  that carries its text, and the one thing that says which row is chosen is
  `aria-current="true"` on the row's root. The sidebar's own current link uses
  `aria-current="page"`, so `"true"` belongs to the selected row alone.

  Rows are found by the shape of their accessible name — `<client> INV-0000 ·
  <when>` — because the tab pills are named `INV-0000` exactly and the ` · `
  is what tells the two apart without reaching for a class name.
*/

/** Every row in the list column, in reading order. */
function listRows(page) {
  return page.getByRole('button', { name: /INV-\d{4} · / });
}

/** The rows' invoice numbers, top to bottom. */
async function rowNumbers(page) {
  return listRows(page).evaluateAll((elements) =>
    elements.map((element) => /INV-\d{4}/.exec(element.textContent ?? '')?.[0] ?? '?'),
  );
}

/**
 * Every row's number mapped to the relative-timing half of its second line —
 * `INV-0042` -> `edited 4 Jun`. The rest of the harness only ever read the
 * selected row's, which cannot see whether a whole group's dates are the same
 * date; the seed now spreads `updated_at` and `paid_at`, so it can.
 */
async function rowTimings(page) {
  return listRows(page).evaluateAll((elements) =>
    Object.fromEntries(
      elements.map((element) => {
        const text = (element.textContent ?? '').replace(/\s+/g, ' ').trim();
        const match = /(INV-\d{4}) · (.+)$/.exec(text);
        return match === null ? ['?', text] : [match[1], match[2]];
      }),
    ),
  );
}

/**
 * The row that is selected: its number, the text it shows, the rail and wash
 * that say so, and whether it is inside its scroller's viewport — `J` past the
 * fold has to bring the row with it, not just move a flag.
 */
async function selectedRow(page) {
  return page.evaluate(() => {
    const row = document.querySelector('[aria-current="true"]');
    if (row === null) return null;
    const styles = getComputedStyle(row);
    let scroller = row.parentElement;
    while (scroller !== null && !/auto|scroll/.test(getComputedStyle(scroller).overflowY)) {
      scroller = scroller.parentElement;
    }
    const box = row.getBoundingClientRect();
    const view = scroller === null ? null : scroller.getBoundingClientRect();
    return {
      number: /INV-\d{4}/.exec(row.textContent ?? '')?.[0] ?? null,
      text: (row.innerText ?? '').split('\n').map((line) => line.trim()).filter(Boolean).join(' · '),
      background: styles.backgroundColor,
      railColor: styles.borderInlineStartColor,
      railWidth: styles.borderInlineStartWidth,
      count: document.querySelectorAll('[aria-current="true"]').length,
      inView: view === null ? null : box.top >= view.top - 1 && box.bottom <= view.bottom + 1,
    };
  });
}

/**
 * The sticky group captions, in order, as two elements each.
 *
 * A caption is `Overdue · £124,333` at full strength with `+3 currencies`
 * beside it in secondary text — two sibling nodes, spaced by the row's own gap.
 * Flattening them with `textContent` produces `Overdue · £124,333+3
 * currencies`, a string that exists nowhere on screen and that no assertion
 * should ever be written against. So the parts are read separately: `label` is
 * the first child's text, `more` the second's, or null when the leading figure
 * is the whole set.
 *
 * Read through `textContent` rather than a text locator on purpose: the caption
 * is upper-cased by `text-transform`, so what the reader sees is `OVERDUE · …`
 * while the string the component produced — and the string this is checked
 * against — is `Overdue · …`. Found by `position: sticky` plus the title, so
 * neither a class name nor the casing is the contract.
 */
async function groupCaptionParts(page) {
  return page.evaluate(() => {
    const titles = /^(Overdue|Due this week|Later|Drafts|Paid|Void)( · |$|\+)/;
    return [...document.querySelectorAll('*')]
      .filter((element) => getComputedStyle(element).position === 'sticky')
      .filter((element) => titles.test((element.textContent ?? '').trim()))
      .map((element) => {
        const parts = [...element.children]
          .map((child) => (child.textContent ?? '').trim())
          .filter((text) => text !== '');
        // No element children at all means the caption is a bare text node.
        if (parts.length === 0) return { label: (element.textContent ?? '').trim(), more: null };
        return { label: parts[0], more: parts[1] ?? null };
      });
  });
}

/** The segmented control's buttons, in order, by the name they carry. */
async function segmentNames(page) {
  return page
    .getByRole('radiogroup', { name: 'Invoice state' })
    .getByRole('radio')
    .evaluateAll((elements) => elements.map((element) => (element.textContent ?? '').trim()));
}

/** Which segment is checked, or null when somehow none is. */
async function checkedSegment(page) {
  const names = await page
    .getByRole('radiogroup', { name: 'Invoice state' })
    .getByRole('radio')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getAttribute('aria-checked') === 'true')
        .map((element) => (element.textContent ?? '').trim()),
    );
  return names.length === 1 ? names[0] : null;
}

/** Waits until the list column has rendered its first row. */
async function awaitCockpit(page) {
  await page.getByRole('heading', { name: 'Invoices', exact: true }).first().waitFor({ timeout: 15_000 });
  await listRows(page).first().waitFor({ timeout: 15_000 });
  // The pane is fetched 120ms after the selection settles; give it the round
  // trip so a shot never photographs the spinner beside a rendered list.
  await page.waitForTimeout(900);
}

/**
 * Reveals the PowerSearch token bar, which is one click away rather than
 * always on screen now. Idempotent: the bar is also open whenever tokens exist.
 */
async function openFilterBar(page) {
  if ((await page.getByRole('combobox', { name: 'Filter invoices' }).count()) > 0) return;
  await page.getByRole('button', { name: /^Filters/ }).first().click();
  await page.getByRole('combobox', { name: 'Filter invoices' }).waitFor({ timeout: 10_000 });
  await page.waitForTimeout(300);
}

/**
 * The filter bar's own live result count ("32 results"), as a number.
 *
 * Still the `Filter invoices` group — but that group only exists while the bar
 * is revealed, so every caller opens it first.
 */
async function resultCount(page) {
  const group = page.getByRole('group', { name: 'Filter invoices' });
  if ((await group.count()) === 0) return null;
  const text = await group.first().innerText();
  const match = /(\d[\d,]*)\s+results/.exec(text);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/**
 * The page header's outstanding / overdue money lines, as shown.
 *
 * Both must carry money: the breadcrumb band's `20 open · 17 overdue` and the
 * pane's `319 days overdue` also end in the word, and neither is this line.
 */
async function headerMoneyLines(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('span')]
      .map((element) => (element.textContent ?? '').trim())
      .filter((text) => /(outstanding|overdue)$/.test(text) && /[£$€¥₹]/.test(text));
    return [...new Set(lines)];
  });
}

/**
 * The `Outstanding …` / `Overdue …` lines the `+N currencies` disclosure
 * reveals — every currency spelled out, which is what the header used to print
 * inline before it became a wall.
 *
 * Distinguished from `headerMoneyLines` by which end the word is on: the
 * headline is `£124,333 outstanding`, the breakdown is `Outstanding £124,333 ·
 * €103,073 · …`. Nothing here keys off a class name.
 *
 * The money has to follow the word immediately, with nothing between them: the
 * list's own `Overdue · £124,333` group caption is one space and one separator
 * away from matching, and it is on screen whether the disclosure is open or
 * shut — which would have made "the disclosure closes again" unfailable.
 */
async function headerBreakdownLines(page) {
  return page.evaluate(() => {
    const lines = [...document.querySelectorAll('span')]
      .map((element) => (element.textContent ?? '').trim())
      .filter((text) => /^(Outstanding|Overdue) [A-Z£$€¥₹]/.test(text));
    return [...new Set(lines)];
  });
}

/**
 * Numbers out of the breadcrumb band's status line, `20 open · 17 overdue`.
 * Returns null for a word the line does not carry, so a missing half fails
 * loudly rather than comparing undefined against undefined.
 */
function statusCounts(status) {
  const read = (word) => {
    const match = new RegExp(`(\\d[\\d,]*)\\s+${word}`).exec(status ?? '');
    return match === null ? null : Number(match[1].replace(/,/g, ''));
  };
  return { open: read('open'), overdue: read('overdue') };
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

/**
 * Sets the app's appearance and blocks until the repaint has landed.
 *
 * Appearance is no longer reachable from the invoices route: the sidebar keeps
 * only a two-state glyph, and the Light/Dark/Auto radios moved to
 * Settings > Appearance. So every mode switch is a round trip — go to Settings,
 * click the radio, wait for the paint, come back to wherever the caller was.
 *
 * `returnTo` is a full hash route (e.g. `#/invoices`) and is navigated even when
 * it is already the current one, because arriving from Settings is exactly what
 * the callers below need. Returns whatever `waitForTheme` decided, so a caller
 * can still report a FAIL rather than photographing an unsettled page.
 *
 * The final `reload()` is what makes the second reading worth taking. Hash
 * navigation only remounts the route — the document, the React tree and the
 * theme context all stay alive, so a `settings:set` that never persisted
 * anything would still have passed. A reload throws the whole renderer away and
 * the mode has to come back from storage, which is the claim being made.
 *
 * `Auto` is rejected rather than handled: `waitForTheme` decides settledness by
 * measuring painted brightness against an expected appearance, and `Auto` has
 * no expected appearance of its own — it resolves to whatever the host OS says.
 * A caller that wants it needs to assert something else.
 */
async function setAppearance(page, mode, returnTo = '#/invoices') {
  const expected = mode.toLowerCase();
  if (expected !== 'light' && expected !== 'dark') {
    throw new Error(`setAppearance: expected Light or Dark, got ${mode}`);
  }
  await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
  const radio = page.getByRole('radio', { name: mode, exact: true });
  await radio.first().waitFor({ timeout: 15_000 });
  await radio.first().click();
  const settled = await waitForTheme(page, expected);
  await page.goto(`${APP_ORIGIN}/${returnTo.startsWith('#') ? '' : '#'}${returnTo}`, {
    waitUntil: 'networkidle',
  });
  await page.reload({ waitUntil: 'networkidle' });
  // Fresh document: the mode below was read back from storage, not from memory.
  return (await waitForTheme(page, expected)) && settled;
}

/**
 * The whole window frame, measured off the real DOM in one pass.
 *
 * Option 3a rebuilt the frame around four bands, and where each of them lives
 * depends on whether the panel is collapsed, so a single reader is the only way
 * to state the invariant honestly:
 *
 *   lightsBand   the band holding the three placeholders — the sidebar's own
 *                40px drag band when expanded, the full-width unified title bar
 *                when collapsed. Box, drag region, aria-hidden.
 *   brandBand    the sidebar's second 40px band: brand lockup + collapse
 *                toggle. Null when collapsed, because the panel has no header.
 *   stripBand    the content column's tab-strip band (the `.app-drag-region`
 *                outside the panel — the shell gave the unified bar its own
 *                class specifically so this stays unambiguous).
 *   crumbBand    the 36px breadcrumb band under it.
 *   unified      the collapsed frame's full-width title bar, or null.
 *   dots         one entry per placeholder, wherever it is, with the painted
 *                colour, the box, whether it could take focus or a tooltip.
 *   footer       the interactive elements in the panel's foot — the nearest
 *                ancestor of the Settings link that is a direct child of it.
 *   rail         the panel's box, its collapsed flag, and its scroll overflow.
 *
 * `.app-side-nav`, `.app-drag-region`, `.app-unified-title-bar`,
 * `.app-breadcrumb-bar` and `.app-window-control-dot` are app-owned class names
 * the shell sets; everything else is found by role, name or structure.
 */
async function shellChrome(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.app-side-nav');
    if (!nav) return null;
    const box = (element) => {
      if (element === null) return null;
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      };
    };
    const describe = (element) =>
      element === null
        ? null
        : {
            ...box(element),
            appRegion: getComputedStyle(element).webkitAppRegion,
            ariaHidden: element.getAttribute('aria-hidden'),
          };

    const navBands = [...nav.querySelectorAll('.app-drag-region')];
    const unified = document.querySelector('.app-unified-title-bar');
    const stripBand = [...document.querySelectorAll('.app-drag-region')].find(
      (element) => element.closest('.app-side-nav') === null,
    );
    const crumbBand = document.querySelector('.app-breadcrumb-bar');
    const cluster = document.querySelector('.app-window-controls');
    const lightsBand = unified ?? navBands[0] ?? null;

    const dots = [...document.querySelectorAll('.app-window-control-dot')].map((dot) => ({
      color: getComputedStyle(dot).backgroundColor,
      appRegion: getComputedStyle(dot).webkitAppRegion,
      inBand: lightsBand !== null && lightsBand.contains(dot),
      inSideNav: dot.closest('.app-side-nav') !== null,
      focusable: dot.matches('a, button, input, select, textarea, [tabindex], [role="button"], [role="link"]'),
      hasTitle: dot.hasAttribute('title'),
      ...box(dot),
    }));

    const buttonName = (element) => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
    const buttonsIn = (root) =>
      root === null || root === undefined
        ? []
        : [...root.querySelectorAll('button')].map((button) => ({
            name: buttonName(button),
            appRegion: getComputedStyle(button).webkitAppRegion,
            ...box(button),
          }));

    // The foot of the panel: the nearest ancestor of the Settings link that is a
    // direct child of the panel itself. Structural, so no design-system class
    // name is a contract here.
    const settings = [...nav.querySelectorAll('a')].find((link) => buttonName(link) === 'Settings') ?? null;
    let footerRoot = settings;
    while (footerRoot !== null && footerRoot.parentElement !== nav) footerRoot = footerRoot.parentElement;
    const footer =
      footerRoot === null
        ? null
        : [...footerRoot.querySelectorAll('a, button, input, select, textarea, [tabindex], [role="button"]')].map(
            (element) => ({ tag: element.tagName.toLowerCase(), name: buttonName(element) }),
          );

    return {
      dots,
      cluster: cluster === null ? null : { ariaHidden: cluster.getAttribute('aria-hidden'), ...box(cluster) },
      lightsBand: describe(lightsBand),
      brandBand: describe(navBands.length > 1 ? navBands[1] : null),
      navBandCount: navBands.length,
      stripBand: describe(stripBand ?? null),
      crumbBand: describe(crumbBand),
      unified:
        unified === null
          ? null
          : {
              ...describe(unified),
              title: (unified.textContent ?? '').trim(),
              buttons: buttonsIn(unified).map((button) => button.name),
              dotCount: unified.querySelectorAll('.app-window-control-dot').length,
            },
      brandButtons: buttonsIn(navBands.length > 1 ? navBands[1] : null),
      controls: [...nav.querySelectorAll('button')].map((button) => ({
        name: buttonName(button),
        ...box(button),
      })),
      footer,
      rail: {
        ...box(nav),
        isCollapsed: nav.classList.contains('app-side-nav-collapsed'),
        scrollWidth: nav.scrollWidth,
        clientWidth: nav.clientWidth,
      },
    };
  });
}

/**
 * The breadcrumb trail and the status line beside it.
 *
 * The trail is a real landmark — `<nav aria-label="Page location">` — and its
 * current step is the one carrying `aria-current="page"`, so the route it
 * claims can be checked step by step rather than as one blob of text. The
 * status line has no role at all (it is supporting text at the band's inline
 * end), so it is read as the band's text minus the trail's.
 */
async function breadcrumbBand(page) {
  return page.evaluate(() => {
    const band = document.querySelector('.app-breadcrumb-bar');
    if (band === null) return null;
    const trail = band.querySelector('nav[aria-label="Page location"]');
    const steps =
      trail === null
        ? []
        : [...trail.querySelectorAll('li')].map((item) => {
            // The separator is aria-hidden; the step itself is the other child.
            const current = item.querySelector('[aria-current="page"]');
            const link = item.querySelector('a');
            const visible = [...item.children].find((child) => child.getAttribute('aria-hidden') !== 'true');
            return {
              label: (current ?? link ?? visible ?? item).textContent?.trim() ?? '',
              href: link === null ? null : link.getAttribute('href'),
              isCurrent: current !== null,
            };
          });
    /*
      The status line is the band's one inert child.

      This used to be `band.textContent.slice(trailText.length)`, which worked
      while the band held exactly two things. The assistant dock's launcher is
      its trailing control now — no longer a floating bubble — and it brings a
      whole subtree with it: a button, a panel of copy about the desktop-only
      runtime, and a `<style>` element full of `@property` declarations that the
      `border-beam` registers. `textContent` returns every word of it.

      So the band's *direct children* are sifted instead, and the status is the
      one that is neither the trail nor a control: no landmark, no interactive
      element, no injected stylesheet inside it. Structural, so no class name is
      a contract and a second inert child would be picked up rather than
      silently dropped.
    */
    const CHROME = 'nav, button, a, style, script, [role="button"], [role="dialog"]';
    const status = [...band.children]
      .filter((child) => !child.matches(CHROME) && child.querySelector(CHROME) === null)
      .map((child) => (child.textContent ?? '').replace(/\s+/g, ' ').trim())
      .filter((text) => text !== '')
      .join(' ');
    return {
      height: band.getBoundingClientRect().height,
      hasTrail: trail !== null,
      trailLabel: trail === null ? null : trail.getAttribute('aria-label'),
      steps,
      status: status.replace(/\s+/g, ' ').trim() || null,
    };
  });
}

/** Computed colour of the sidebar's update control, and its accessible name. */
async function updateControl(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.app-side-nav');
    const button = [...(nav?.querySelectorAll('button') ?? [])].find((element) => {
      const name = element.getAttribute('aria-label') ?? '';
      return !/sidebar|theme/i.test(name);
    });
    if (!button) return null;
    const glyph = button.querySelector('svg');
    return {
      name: button.getAttribute('aria-label'),
      // Icon's colour is `inherit`, so the button's `color` is the glyph's ink.
      color: getComputedStyle(button).color,
      glyphColor: glyph === null ? null : getComputedStyle(glyph).color,
      // The declared token, inherited from the app-shell. Not resolved —
      // `light-dark()` is only resolved on real properties — so it is reported
      // for the failure message rather than compared against a computed rgb.
      pendingToken: getComputedStyle(button).getPropertyValue('--color-icon-update-pending').trim(),
    };
  });
}

/** Is a computed `rgb(...)` colour recognisably blue rather than a grey ink? */
function isBlue(color) {
  const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
  if (parts.length < 3) return false;
  const [red, green, blue] = parts;
  return blue > red + 60 && blue > green + 60;
}

/**
 * Where the gradient is painted, as two independent readings.
 *
 * The design's whole claim is a *contrast*: the panel carries a vertical wash
 * and the backdrop behind it is flat. Asserting only "something paints a
 * gradient" passed against the previous, inverted design too — it is the pair
 * that pins this one down.
 */
async function gradientSurfaces(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.app-side-nav');
    if (!nav) return null;
    const panel = getComputedStyle(nav).backgroundImage;
    let backdrop = null;
    for (let node = nav.parentElement; node; node = node.parentElement) {
      const image = getComputedStyle(node).backgroundImage;
      if (image.includes('gradient')) {
        backdrop = `<${node.tagName.toLowerCase()} class="${node.getAttribute('class') ?? ''}"> ${image}`;
        break;
      }
    }
    // The walk ends at <html>, so "no gradient behind the panel" covers the
    // shell, the layout panels, <body> and the document element alike.
    return { panel, panelHasGradient: panel.includes('gradient'), backdrop };
  });
}

/**
 * The pane/panel relationship, read from computed styles.
 *
 * The design is a contrast between three surfaces: the window, the content pane
 * painted with it, and the panel's lit head above both. `gradientSurfaces` above
 * only proves *where* the gradient is; this proves the pane did not quietly keep
 * core's `--color-background-surface` default, which is the same colour as the
 * panel's first gradient stop.
 */
async function paneVersusPanel(page) {
  return page.evaluate(() => {
    const pane = document.querySelector('.astryx-layout-content');
    if (!pane) return null;
    const sum = (color) => {
      const parts = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return parts.length === 3 ? parts[0] + parts[1] + parts[2] : NaN;
    };
    const paneStyle = getComputedStyle(pane);
    const body = getComputedStyle(document.body).backgroundColor;
    // The panel's head is the gradient's first stop, resolved to real numbers by
    // getComputedStyle — the substring up to the first percentage.
    const image = getComputedStyle(document.querySelector('.app-side-nav')).backgroundImage;
    const head = /linear-gradient\((.+?)\s+0%/.exec(image)?.[1] ?? '';
    return {
      pane: paneStyle.backgroundColor,
      paneImage: paneStyle.backgroundImage,
      body,
      panelHead: head,
      // Transparent counts: the app-shell paints the body colour underneath. Read
      // the alpha rather than the sum, so an opaque black pane is not mistaken
      // for a see-through one.
      paneMatchesBody:
        paneStyle.backgroundColor === body ||
        (paneStyle.backgroundColor.match(/[\d.]+/g) ?? [])[3] === '0',
      panelHeadOffPane: sum(head) - sum(body) >= 30 || sum(body) - sum(head) >= 30,
    };
  });
}

// ---------------------------------------------------------------------------
// The open-invoice tab strip, in the content column's band
// ---------------------------------------------------------------------------

/** Accessible name of the trailing `+`, and of the draft tab it opens. */
const NEW_TAB_BUTTON = 'New invoice tab';
const DRAFT_TAB = 'New invoice';

/** The strip, by role and name — `role="toolbar"`, `aria-label="Open invoices"`. */
function tabStrip(page) {
  return page.getByRole('toolbar', { name: 'Open invoices' });
}

/** Every control in the strip, by accessible name, in DOM order. */
async function stripControlNames(page) {
  if ((await tabStrip(page).count()) === 0) return [];
  return tabStrip(page)
    .getByRole('button')
    .evaluateAll((elements) =>
      elements.map((element) => (element.getAttribute('aria-label') ?? element.textContent ?? '').trim()),
    );
}

/** Just the tabs: everything that is not a close control and not the `+`. */
async function tabNames(page) {
  const names = await stripControlNames(page);
  return names.filter((name) => !name.startsWith('Close ') && name !== NEW_TAB_BUTTON);
}

/** Which tab carries `aria-current="page"`. Exactly one, or none off-feature. */
async function activeTabName(page) {
  const current = await tabStrip(page)
    .getByRole('button')
    .evaluateAll((elements) =>
      elements
        .filter((element) => element.getAttribute('aria-current') === 'page')
        .map((element) => (element.textContent ?? '').trim()),
    );
  return current.length === 1 ? current[0] : (current.length === 0 ? null : current);
}

/**
 * The content column's band, measured off the real DOM.
 *
 * `.app-drag-region` and the two `.app-invoice-tab*` classes are app-owned (the
 * shell and `global.css` set them); the strip itself is found by its role. The
 * drag numbers are the reason this is an `evaluate` rather than locators:
 * `-webkit-app-region` is a computed style, and the invariant is about the exact
 * three elements below — the pill, its close control, and the empty part of the
 * band, which has to stay `drag` or the window loses its top edge.
 */
async function contentBand(page) {
  return page.evaluate(() => {
    const band = [...document.querySelectorAll('.app-drag-region')].find(
      (element) => element.closest('.app-side-nav') === null,
    );
    if (!band) return null;
    /*
      `-webkit-app-region` is not inherited, and its initial value is `none` —
      which is not a third behaviour but "unspecified": Chromium unions the rects
      of elements set to `drag` and subtracts the rects set to `no-drag`, so what
      a given pixel does is decided by the nearest ancestor that specifies a
      value. Reading the hit element's own computed value would report `none` for
      every plain wrapper inside the band and prove nothing.
    */
    const region = (element) => {
      for (let node = element; node !== null; node = node.parentElement) {
        const value = getComputedStyle(node).webkitAppRegion;
        if (value && value !== 'none') return value;
      }
      return element === null ? null : 'none';
    };
    const rect = band.getBoundingClientRect();
    const strip = band.querySelector('[role="toolbar"]');
    const pill = band.querySelector('.app-invoice-tab');
    const active = band.querySelector('.app-invoice-tab-active');
    const inactive = band.querySelector('.app-invoice-tab:not(.app-invoice-tab-active)');
    // A point in the band past everything interactive: still draggable?
    const empty = document.elementFromPoint(rect.right - 6, rect.top + rect.height / 2);
    return {
      height: rect.height,
      left: rect.left,
      right: rect.right,
      ariaHidden: band.getAttribute('aria-hidden'),
      hasStrip: strip !== null,
      stripRight: strip === null ? null : strip.getBoundingClientRect().right,
      pillLeft: pill === null ? null : pill.getBoundingClientRect().left,
      pillHeight: pill === null ? null : pill.getBoundingClientRect().height,
      bandRegion: region(band),
      emptyRegion: region(empty),
      pillRegion: region(pill),
      closeRegion: region(band.querySelector('.app-invoice-tab-close')),
      activeBackground: active === null ? null : getComputedStyle(active).backgroundColor,
      activeInk: active === null ? null : getComputedStyle(active).color,
      inactiveBackground: inactive === null ? null : getComputedStyle(inactive).backgroundColor,
      inactiveInk: inactive === null ? null : getComputedStyle(inactive).color,
      pageHeadingLeft: (() => {
        const heading = document.querySelector('h1');
        return heading === null ? null : heading.getBoundingClientRect().left;
      })(),
    };
  });
}

/** Accessible name of whatever currently has focus. */
async function focusedName(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return null;
    return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
  });
}

/** Presses Tab from the top of the document until focus lands inside the strip. */
async function tabIntoStrip(page, limit = 30) {
  await page.evaluate(() => {
    document.activeElement?.blur();
  });
  for (let index = 0; index < limit; index++) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => document.activeElement?.closest('.app-invoice-tabs') != null,
    );
    if (inside) return { name: await focusedName(page), presses: index + 1 };
  }
  return null;
}

/** Walks the toolbar's roving tabindex with ArrowRight, collecting names. */
async function arrowWalk(page, steps) {
  const names = [await focusedName(page)];
  for (let index = 0; index < steps; index++) {
    await page.keyboard.press('ArrowRight');
    names.push(await focusedName(page));
  }
  return names;
}

/**
 * The invoices the tab tests open, as `{ id, number }` in the cockpit's own
 * reading order. Filled once from SQLite in `main`.
 *
 * The per-row `Open` button is gone — the row *is* the link, and selecting a
 * row is state rather than navigation — so "click the nth Open" no longer
 * exists as a gesture. Opening an invoice on its own route is now one item in
 * the pane's overflow menu, which is asserted once, on its own, below; every
 * other test in the strip section is about the *strip*, and driving those
 * through a menu would make forty tab assertions depend on a dropdown.
 */
let tabFixtures = [];

/** Opens the nth invoice of the cockpit's reading order. Returns its hash. */
async function openInvoiceFromList(page, index) {
  const invoice = tabFixtures[index];
  if (invoice === undefined) throw new Error(`no invoice fixture at index ${index}`);
  await page.goto(`${APP_ORIGIN}/#/invoices/${invoice.id}`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return new URL(page.url()).hash;
}

/**
 * Selects the nth row in the list column and waits for the pane to catch up.
 * The pane fetch is debounced by 120ms and then does two round trips.
 */
async function selectRow(page, index) {
  await listRows(page).nth(index).click();
  await page.waitForTimeout(900);
  return selectedRow(page);
}

/**
 * What holds focus, and where it sits.
 *
 * A close destroys the button that had focus, so the only assertion that means
 * anything is on `document.activeElement` *after* the close: `BODY` is the
 * browser's fallback and the failure this exists to catch.
 */
async function focusTarget(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    if (!element) return { tag: null, name: null, inStrip: false };
    return {
      tag: element.tagName,
      id: element.id,
      name: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 60),
      inStrip: element.closest('.app-invoice-tabs') !== null,
    };
  });
}

/**
 * Whether the trailing `+` can actually be used at this width.
 *
 * Not "is the document wider than the window": with ten tabs open the document
 * stayed exactly `clientWidth` while the `+` sat 400px past the right edge, clipped
 * by the band, with no scrollbar anywhere able to bring it back. So this reads the
 * `+`'s rect against the viewport *and* hit-tests its centre point, and checks that
 * the overflow ended up inside the scroller where a scroll can reach it.
 */
async function plusReach(page) {
  return page.evaluate(() => {
    const strip = document.querySelector('.app-invoice-tabs');
    const toolbar = strip?.querySelector('[role="toolbar"]');
    const plus = strip?.querySelector('.app-invoice-tabs-new');
    const scroller = strip?.querySelector('.app-invoice-tabs-scroller');
    if (!strip || !toolbar || !plus || !scroller) return null;
    const button = plus.matches('button') ? plus : (plus.querySelector('button') ?? plus);
    const rect = button.getBoundingClientRect();
    const toolbarRect = toolbar.getBoundingClientRect();
    const hit = document.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
    return {
      left: rect.left,
      right: rect.right,
      toolbarRight: toolbarRect.right,
      viewportWidth: window.innerWidth,
      insideViewport:
        rect.left >= 0 &&
        rect.right <= window.innerWidth &&
        rect.top >= 0 &&
        rect.bottom <= window.innerHeight,
      insideToolbar: rect.left >= toolbarRect.left - 1 && rect.right <= toolbarRect.right + 1,
      // The real question: does a click at the `+`'s centre reach the `+`?
      hittable: hit !== null && (hit === button || button.contains(hit) || hit.contains(button)),
      hitClass: hit === null ? null : (hit.getAttribute('class') ?? hit.tagName),
      scrollerClientWidth: scroller.clientWidth,
      scrollerScrollWidth: scroller.scrollWidth,
      scrollerRight: scroller.getBoundingClientRect().right,
      // The active pill has to stay inside the scroller's own viewport, or the
      // invoice the user is reading has no reachable pill.
      activePillVisible: (() => {
        const active = strip.querySelector('.app-invoice-tab-active');
        if (active === null) return null;
        const pill = active.getBoundingClientRect();
        const box = scroller.getBoundingClientRect();
        return pill.left >= box.left - 1 && pill.right <= box.right + 1;
      })(),
    };
  });
}

/** The `-webkit-app-region` in force at one point, resolved up the tree. */
async function regionAtPoint(page, x, y) {
  return page.evaluate(({ x: px, y: py }) => {
    const hit = document.elementFromPoint(px, py);
    for (let node = hit; node !== null; node = node.parentElement) {
      const value = getComputedStyle(node).webkitAppRegion;
      if (value && value !== 'none') return { region: value, hit: hit?.getAttribute('class') ?? hit?.tagName };
    }
    return { region: 'none', hit: hit?.getAttribute('class') ?? hit?.tagName ?? null };
  }, { x, y });
}

/** The midpoint of the gap between the first two pills, or null with one pill. */
async function pillGapPoint(page) {
  return page.evaluate(() => {
    const pills = [...document.querySelectorAll('.app-invoice-tab')];
    if (pills.length < 2) return null;
    const first = pills[0].getBoundingClientRect();
    const second = pills[1].getBoundingClientRect();
    if (second.left - first.right < 2) return null;
    return { x: (first.right + second.left) / 2, y: (first.top + first.bottom) / 2 };
  });
}

/**
 * Presses several strip controls inside ONE browser task.
 *
 * The whole point: nothing re-renders between the clicks, so every handler sees
 * the same stale `pathname` and the same pre-click tab list. Three bugs only
 * exist in that window — a queued close resurrecting an earlier one, a close
 * right after a pill click being read as inactive — and `locator.click()` cannot
 * reach it, because Playwright yields between clicks and React commits.
 *
 * Steps are named by invoice number, not by id: the close control carries the
 * number in its accessible name, and its pill's first `<button>` is the
 * activation control (see `InvoiceTabs.tsx`'s header on Token's anatomy).
 */
async function stripClicksInOneTask(page, steps) {
  await page.evaluate((actions) => {
    for (const action of actions) {
      const pill = [...document.querySelectorAll('.app-invoice-tabs [data-invoice-tab]')].find(
        (candidate) =>
          candidate.querySelector('.app-invoice-tab-close')?.getAttribute('aria-label') ===
          `Close invoice ${action.name}`,
      );
      if (!pill) throw new Error(`no pill for ${action.name}`);
      const target =
        action.kind === 'close'
          ? pill.querySelector('.app-invoice-tab-close')
          : pill.querySelector('button');
      if (!target) throw new Error(`no ${action.kind} control for ${action.name}`);
      target.click();
    }
  }, steps);
  await page.waitForTimeout(900);
}

/** Where the pills are scrolled to, and whether they overflow at all. */
async function stripScroll(page) {
  return page.evaluate(() => {
    const scroller = document.querySelector('.app-invoice-tabs-scroller');
    if (scroller === null) return null;
    return {
      scrollLeft: scroller.scrollLeft,
      scrollWidth: scroller.scrollWidth,
      clientWidth: scroller.clientWidth,
      overflows: scroller.scrollWidth > scroller.clientWidth,
    };
  });
}

/** Sets the pill scroller's scroll position by hand, as a user's finger would. */
async function scrollStripToStart(page) {
  await page.evaluate(() => {
    const scroller = document.querySelector('.app-invoice-tabs-scroller');
    if (scroller === null) throw new Error('no pill scroller');
    scroller.scrollLeft = 0;
  });
  await page.waitForTimeout(120);
}

/** The shell's own inline overflow: many tabs must not widen the window. */
async function shellOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
}

// ---------------------------------------------------------------------------
// The editor: quiet line table, ghost row, paper preview
// ---------------------------------------------------------------------------

/**
 * Every line-item cell, by the field it holds and the row it is on.
 *
 * Cells are located by their hidden labels — `Description, line 3` — which are
 * the only names they have; the table is a stack of divs, not a `<table>`, so
 * there is no `row` or `cell` role to ask for. The chrome is read off the
 * *wrapper* rather than the `<input>`: `TextInput` puts the inline style there,
 * and the whole claim of option 2a is that the wrapper paints nothing at rest.
 */
async function lineCells(page) {
  return page.evaluate(() => {
    const cells = [];
    for (const input of document.querySelectorAll('input')) {
      const label = input.labels?.[0]?.textContent?.trim() ?? '';
      const match = /^(Description|Quantity|Rate), line (\d+)$/.exec(label);
      if (match === null) continue;
      const wrapper = input.closest('.astryx-text-input') ?? input.parentElement;
      const styles = getComputedStyle(wrapper);
      cells.push({
        field: match[1],
        line: Number(match[2]),
        value: input.value,
        placeholder: input.placeholder,
        focused: document.activeElement === input,
        background: styles.backgroundColor,
        borderColor: styles.borderTopColor,
        borderWidth: styles.borderTopWidth,
        // "Painted" is the question, and `transparent` and a zero alpha are the
        // two ways CSS says no.
        isPainted:
          styles.backgroundColor !== 'transparent' && !/,\s*0\)$/.test(styles.backgroundColor),
        hasBorderInk:
          styles.borderTopColor !== 'transparent' && !/,\s*0\)$/.test(styles.borderTopColor),
      });
    }
    return cells.sort((a, b) => a.line - b.line || a.field.localeCompare(b.field));
  });
}

/**
 * The trailing ghost row, as the DOM expresses it.
 *
 * Nothing in ARIA marks it — it is simply the last row, and it is blank. What
 * distinguishes it on screen is the description placeholder, the absence of a
 * grip and an overflow menu, and an em dash where the amount would be.
 */
async function ghostRow(page) {
  return page.evaluate(() => {
    const descriptions = [...document.querySelectorAll('input')].filter((input) =>
      /^Description, line \d+$/.test(input.labels?.[0]?.textContent?.trim() ?? ''),
    );
    const last = descriptions.at(-1);
    if (last === undefined) return null;
    const line = Number(/(\d+)$/.exec(last.labels[0].textContent.trim())[1]);
    // The row is the nearest ancestor that also holds the amount cell.
    let row = last.parentElement;
    while (row !== null && row.querySelectorAll('input').length < 3) row = row.parentElement;
    const text = row === null ? '' : row.textContent ?? '';
    return {
      line,
      lineCount: descriptions.length,
      placeholder: last.placeholder,
      value: last.value,
      hasMoveButton: document.querySelector(`[aria-label="Move line ${line}"]`) !== null,
      hasActionsButton: document.querySelector(`[aria-label="Line ${line} actions"]`) !== null,
      showsEmDash: text.includes('—'),
      // The row above it is a real row and does have both controls.
      previousHasMove: document.querySelector(`[aria-label="Move line ${line - 1}"]`) !== null,
    };
  });
}

/**
 * The preview rail: its fixed width, the A4 frame, and whether the pager and
 * the thumbnail strip are on screen at all.
 */
async function previewRail(page) {
  return page.evaluate(() => {
    const frame = [...document.querySelectorAll('*')].find(
      (element) => getComputedStyle(element).aspectRatio === '210 / 297',
    );
    if (frame === undefined) return null;
    // The rail is the fixed-width column the frame sits in: the first ancestor
    // that is as wide as `PREVIEW_RAIL_WIDTH` says it should be.
    let rail = frame.parentElement;
    for (let guard = 0; guard < 8 && rail !== null; guard += 1) {
      if (Math.round(rail.getBoundingClientRect().width) >= 470) break;
      rail = rail.parentElement;
    }
    const frameBox = frame.getBoundingClientRect();
    const pagesCaption = [...document.querySelectorAll('span')]
      .map((element) => (element.textContent ?? '').trim())
      .find((text) => /^PAGES · \d+$/.test(text));
    return {
      railWidth: rail === null ? null : Math.round(rail.getBoundingClientRect().width),
      aspectRatio: getComputedStyle(frame).aspectRatio,
      overflow: getComputedStyle(frame).overflow,
      frameWidth: Math.round(frameBox.width),
      frameHeight: Math.round(frameBox.height),
      // A4 is 210:297, so the frame's own proportion is the claim to check.
      ratio: frameBox.height === 0 ? null : frameBox.width / frameBox.height,
      pagesCaption: pagesCaption ?? null,
      thumbnails: document.querySelectorAll('[aria-label^="Show page "]').length,
      hasPager: document.querySelector('[aria-label="Next page"]') !== null,
      nextDisabled: document.querySelector('[aria-label="Next page"]')?.disabled ?? null,
      previousDisabled: document.querySelector('[aria-label="Previous page"]')?.disabled ?? null,
      // Read out of the pager itself rather than by pattern: the notes counter
      // is also `N / M`, and a page label found by shape alone would sometimes
      // be the character count.
      pageLabel: (() => {
        const next = document.querySelector('[aria-label="Next page"]');
        if (next === null) return null;
        const cluster = next.parentElement;
        return (
          [...(cluster?.children ?? [])]
            .map((element) => (element.textContent ?? '').trim())
            .find((text) => /^\d+ \/ \d+$/.test(text)) ?? null
        );
      })(),
    };
  });
}

/** Description cells, in row order — the ghost row is always the last one. */
function descriptionCells(page) {
  return page.getByRole('textbox', { name: /^Description, line \d+$/ });
}

/**
 * Types committed rows into the ghost row until the sheet spills onto a second
 * page, or gives up.
 *
 * Driven by the pager appearing rather than by a row count: nothing in the code
 * fixes how many lines fit — `documentPageCount` divides the sheet's *measured*
 * layout height by one A4 page — so a row budget written down here would be a
 * guess that rots the first time the document's type changes.
 */
async function fillUntilTwoPages(page, limit = 40) {
  for (let index = 0; index < limit; index += 1) {
    const count = await descriptionCells(page).count();
    const ghost = descriptionCells(page).nth(count - 1);
    await ghost.fill(`Line item ${index + 1} — engineering services rendered`);
    await ghost.press('Enter');
    await page.waitForTimeout(110);
    if ((await page.getByRole('button', { name: 'Next page' }).count()) > 0) {
      await page.waitForTimeout(400);
      return index + 1;
    }
  }
  return null;
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
  console.log(`  paid invoices for ${FILTER_CLIENT}: ${expected.paidForClient}`);
  console.log(`  as of ${expected.asOf}, the cockpit's groups should read:`);
  for (const group of expected.cockpit.groups) {
    console.log(`    ${group.caption}  (${group.rows.length} rows)`);
  }
  console.log(`  segments: ${expected.segmentLabels.join(' | ')}\n`);

  // The strip section opens invoices by route; the reading order is the
  // cockpit's own, so the tab labels below are the rows a reader would meet
  // top-first.
  tabFixtures = expected.cockpit.flat.map((row) => ({ id: row.id, number: row.number }));

  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  const consoleErrors = [];
  page.on('console', (message) => {
    if (message.type() === 'error') consoleErrors.push(message.text());
  });
  page.on('pageerror', (error) => consoleErrors.push(String(error)));

  // --- The invoices cockpit, as it first renders ---------------------------
  /*
    Option 3c replaced the table with a triage split: a 396px grouped list on
    the left, the selected invoice rendered in full on the right. Nothing here
    is paginated any more, so every one of the 66 rows is on screen, bucketed by
    *when* rather than by status, under captions that carry a per-currency sum.
    Every one of those numbers is recomputed from the database file above.
  */
  console.log('Invoices cockpit');
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await awaitCockpit(page);

  check('the whole set is on screen, not a page of it', await rowNumbers(page).then((r) => r.length), expected.listTotal);
  check(
    'rows are in the cockpit reading order SQLite predicts',
    (await rowNumbers(page)).join(','),
    expected.cockpit.numbers.join(','),
  );
  /*
    The caption is two elements now — the leading currency at full strength, the
    count of the others beside it as a label — so it is asserted as two. Both
    halves still come out of SQLite: the lead is the biggest per-currency sum of
    the rows the group holds, and `+N currencies` is how many sums it is
    standing in front of. Asserting the flattened string would have been the
    easy fix and would have baked in a concatenation the screen never renders.
  */
  const captions = await groupCaptionParts(page);
  check(
    'group captions lead with the biggest per-currency sum SQLite holds',
    captions.map((parts) => parts.label).join(' | '),
    expected.cockpit.groups.map((group) => group.label).join(' | '),
  );
  check(
    'group captions count the currencies the lead is standing in front of',
    captions.map((parts) => parts.more ?? '—').join(' | '),
    expected.cockpit.groups.map((group) => group.more ?? '—').join(' | '),
  );
  // The two parts are separate nodes, spaced by the row's own gap. Proven, not
  // assumed: if they ever collapse into one text node the check above would
  // still pass while the screen read `Overdue · £124,333+3 currencies`.
  checkTrue(
    'the caption’s sum and its currency count are separate, spaced elements',
    await page.evaluate(() => {
      const sticky = [...document.querySelectorAll('*')].find(
        (element) =>
          getComputedStyle(element).position === 'sticky' &&
          /^Overdue · /.test((element.textContent ?? '').trim()),
      );
      if (!sticky || sticky.children.length < 2) return false;
      const [lead, more] = [...sticky.children];
      return more.getBoundingClientRect().left - lead.getBoundingClientRect().right >= 2;
    }),
    'the Overdue caption holds two children with a real gap between them',
  );
  check('segment counts match SQLite', (await segmentNames(page)).join(' | '), expected.segmentLabels.join(' | '));
  check('the list opens on All', await checkedSegment(page), expected.segmentLabels[0]);

  /*
    The page header took the same shape. One figure each, and — the part worth
    naming — both led by the *same* currency: the second amount is a slice of
    the first, and two amounts in one sentence that are not in the same money
    cannot be read against each other at all. That invariant is asserted
    directly below rather than left implicit in the expected strings, because it
    is a real thing someone could regress by summarising the two independently.
  */
  const headerLines = await headerMoneyLines(page);
  check(
    'the page header states the outstanding and overdue sums',
    headerLines.join(' | '),
    `${expected.outstandingLine} | ${expected.overdueLine}`,
  );
  const headerSymbols = headerLines.map((line) => /[£$€¥₹]/.exec(line)?.[0] ?? '?');
  checkTrue(
    'both header figures are denominated in the same currency',
    headerSymbols.length === 2 &&
      headerSymbols[0] === headerSymbols[1] &&
      expected.outstandingSummary.leadCurrency !== null &&
      expected.overdueSummary.leadCurrency === expected.outstandingSummary.leadCurrency,
    `on screen: ${headerSymbols.join(' vs ')}; SQLite: ` +
      `${expected.outstandingSummary.leadCurrency} vs ${expected.overdueSummary.leadCurrency}`,
  );

  // The per-currency breakdown the header used to print inline is one click
  // away, and it is where the full cross-check against SQLite now lives.
  check(
    'the header offers the remaining currencies as a disclosure',
    await page.getByRole('button', { name: expected.breakdownLabel, exact: true }).count(),
    1,
  );
  await page.getByRole('button', { name: expected.breakdownLabel, exact: true }).click();
  await page.waitForTimeout(400);
  check(
    'the disclosure spells out every currency, and they match SQLite',
    (await headerBreakdownLines(page)).join(' | '),
    `Outstanding ${expected.outstandingSummary.full} | Overdue ${expected.overdueSummary.full}`,
  );
  await page.getByRole('button', { name: 'Hide currencies', exact: true }).click();
  await page.waitForTimeout(400);
  check('the disclosure closes again', (await headerBreakdownLines(page)).length, 0);
  // Hand the control back its resting state before anything is photographed:
  // it keeps focus after the click and the pointer is still sitting on it, so
  // `invoices.png` would otherwise show a hovered, focus-ringed pill in the
  // page header and read as the design's default.
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  await page.mouse.move(0, 0);
  await page.waitForTimeout(200);

  /*
    The rows' second lines, as a set rather than one at a time.

    The seed used to stamp every `updated_at` and `paid_at` at seed time, so a
    whole group's second lines read `edited 30 Jul` thirty-two times over and
    the design's "relative timing, so the reader can see what moved when" was a
    claim no screenshot could support. It spreads them now — 10 distinct edited
    dates across the drafts, 32 across the paid rows — so that claim is
    demonstrable and is asserted here: the Drafts group's lines are checked
    against SQLite one by one, and both settled groups are checked for actually
    carrying more than one date.
  */
  const timings = await rowTimings(page);
  const draftGroup = expected.cockpit.groups.find((group) => group.key === 'drafts');
  const draftLines = (draftGroup?.rows ?? []).map((row) => timings[row.number] ?? '(missing)');
  check(
    'each Drafts row states the edited-date SQLite holds for it',
    draftLines.join(' | '),
    (draftGroup?.rows ?? []).map((row) => row.timing).join(' | '),
  );
  checkTrue(
    'the Drafts group carries more than one distinct edited-date',
    new Set(draftLines).size > 1,
    `${new Set(draftLines).size} distinct second line(s) across ${draftLines.length} drafts`,
  );
  const paidGroup = expected.cockpit.groups.find((group) => group.key === 'paid');
  const paidLines = (paidGroup?.rows ?? []).map((row) => timings[row.number] ?? '(missing)');
  checkTrue(
    'the Paid group carries more than one distinct paid-date',
    new Set(paidLines).size > 1,
    `${new Set(paidLines).size} distinct second line(s) across ${paidLines.length} paid rows`,
  );

  // The row the reader lands on: selection is derived, so the top of the list
  // is chosen for them rather than the pane opening empty.
  const firstSelected = await selectedRow(page);
  check('exactly one row is selected on arrival', firstSelected?.count, 1);
  check('the selected row is the top of the list', firstSelected?.number, expected.cockpit.numbers[0]);
  check(
    'the selected row shows the relative timing SQLite predicts',
    firstSelected?.text.includes(expected.cockpit.flat[0].secondary),
    true,
  );
  // Selection is a white rail plus a wash, not another status colour.
  checkTrue(
    'the selected row carries a painted rail and a wash',
    firstSelected !== null &&
      firstSelected.railColor !== 'rgba(0, 0, 0, 0)' &&
      parseFloat(firstSelected.railWidth) >= 2 &&
      firstSelected.background !== 'rgba(0, 0, 0, 0)',
    `rail: ${firstSelected?.railWidth} ${firstSelected?.railColor}, wash: ${firstSelected?.background}`,
  );
  // The pane on the right is the selected invoice, in full.
  check(
    'the pane renders the selected invoice',
    (await page.getByRole('heading', { level: 2 }).first().innerText()).trim(),
    expected.cockpit.flat[0].clientName,
  );
  check(
    'the pane states the row’s position in the list',
    (await page.getByText(new RegExp(`^1 of ${expected.listTotal}$`)).first().innerText()).trim(),
    `1 of ${expected.listTotal}`,
  );

  // The two locators the redesign deleted, asserted gone rather than assumed.
  check('no per-row Open button survives', await page.getByRole('button', { name: 'Open', exact: true }).count(), 0);
  check(
    'no page-size combobox survives',
    await page.getByRole('combobox', { name: 'Results per page' }).count(),
    0,
  );
  check(
    'the filter bar is one click away, not always on screen',
    await page.getByRole('group', { name: 'Filter invoices' }).count(),
    0,
  );

  await shoot(page, 'invoices');

  // --- J / K walk the list, and the pane follows ---------------------------
  console.log('\nCockpit keyboard');
  await page.locator('body').click({ position: { x: 5, y: 500 } });
  await page.keyboard.press('j');
  await page.waitForTimeout(700);
  check('J moves the selection down one row', (await selectedRow(page))?.number, expected.cockpit.numbers[1]);
  await page.keyboard.press('j');
  await page.waitForTimeout(700);
  check('J again moves on', (await selectedRow(page))?.number, expected.cockpit.numbers[2]);
  await page.keyboard.press('k');
  await page.waitForTimeout(700);
  check('K moves the selection back up', (await selectedRow(page))?.number, expected.cockpit.numbers[1]);
  check(
    'the pane followed the keyboard',
    (await page.getByRole('heading', { level: 2 }).first().innerText()).trim(),
    expected.cockpit.flat[1].clientName,
  );
  // K at the top must park, not wrap: holding it has to leave the reader at the
  // start of the list rather than at the far end of it.
  for (let index = 0; index < 4; index += 1) await page.keyboard.press('k');
  await page.waitForTimeout(700);
  check('K parks at the top of the list rather than wrapping', (await selectedRow(page))?.number, expected.cockpit.numbers[0]);

  // `/` focuses the search box, and a keystroke in a text field is not a
  // navigation command.
  //
  // The guard is read *through* the search rather than beside it: `j` in the
  // box narrows the list to nothing, so there is no selected row to look at
  // while it is typed. What survives an empty list is `selectedId` — so a row
  // is chosen first, the keystroke is typed, and the search is cleared again.
  // If the guard had let `j` through as "next", the row that comes back would
  // be the one after it.
  const guardIndex = 6;
  await selectRow(page, guardIndex);
  const guardNumber = expected.cockpit.numbers[guardIndex];
  check('contract baseline for the keystroke guard', (await selectedRow(page))?.number, guardNumber);
  await page.keyboard.press('/');
  await page.waitForTimeout(300);
  check(
    'slash focuses the search box',
    await page.evaluate(() => document.activeElement?.labels?.[0]?.textContent?.trim() ?? null),
    'Search invoices',
  );
  await page.keyboard.press('j');
  await page.waitForTimeout(900);
  check(
    'the keystroke really did land in the field',
    await page.evaluate(() => (document.activeElement instanceof HTMLInputElement ? document.activeElement.value : null)),
    'j',
  );
  await page.getByRole('textbox', { name: 'Search invoices' }).fill('');
  await page.waitForTimeout(1200);
  check(
    'J typed into the search box did not also move the selection',
    (await selectedRow(page))?.number,
    guardNumber,
  );

  // --- A row selected deep in the list -------------------------------------
  const deepIndex = Math.min(24, expected.cockpit.numbers.length - 1);
  const deep = await selectRow(page, deepIndex);
  check('clicking a row deep in the list selects it', deep?.number, expected.cockpit.numbers[deepIndex]);
  checkTrue(
    'the deep selection is scrolled into view, not just flagged',
    deep?.inView === true,
    `row in its scroller's viewport: ${deep?.inView}`,
  );
  check(
    'selection is state, not navigation — the route does not move',
    new URL(page.url()).hash,
    '#/invoices',
  );
  check(
    'the pane shows the deep row’s invoice',
    (await page.getByRole('heading', { level: 2 }).first().innerText()).trim(),
    expected.cockpit.flat[deepIndex].clientName,
  );
  await shoot(page, 'invoices-selected');

  /*
    --- The pane's Activity date gutter -------------------------------------

    76px, not the 52 it started at, and `white-space: nowrap`. `shortDate`
    appends the year for any date outside the current one — `15 Aug 2025` — and
    at 52px that wrapped onto a second line, so every event description below it
    sat half a row lower than the ones above.

    Asserted on an invoice SQLite says was *created* in an earlier year, so the
    long form is guaranteed to be on screen: an assertion that only ever sees
    `15 Aug` would pass at 52px too and prove nothing.
  */
  const oldRowIndex = expected.cockpit.flat.findIndex(
    (row) => row.createdYear !== null && row.createdYear !== expected.asOf.slice(0, 4),
  );
  if (oldRowIndex === -1) {
    fail(
      'the Activity gutter holds a dated-in-another-year row to measure',
      'no seeded invoice was created outside the current year, so the wrap this guards cannot occur',
    );
  } else {
    await selectRow(page, oldRowIndex);
    const cells = await activityGutterCells(page);
    const withYear = cells.filter((cell) => /\d{4}$/.test(cell.text));
    checkTrue(
      'the pane’s Activity gutter is showing the long, year-bearing date form',
      withYear.length > 0,
      `${cells.length} gutter cell(s): ${cells.map((cell) => cell.text).join(', ') || 'none found'}`,
    );
    checkTrue(
      'every Activity date sits on one line',
      cells.length > 0 && cells.every((cell) => cell.lines === 1),
      cells.map((cell) => `${cell.text}: ${cell.lines} line(s)`).join(', ') || 'no gutter cells found',
    );
    checkTrue(
      'the Activity gutter is wide enough for the longest date it prints',
      cells.length > 0 && cells.every((cell) => cell.textWidth <= cell.width + 0.5),
      cells
        .map((cell) => `${cell.text}: text ${cell.textWidth.toFixed(1)} in gutter ${cell.width.toFixed(1)}`)
        .join(', ') || 'no gutter cells found',
    );
  }

  // --- The Overdue segment --------------------------------------------------
  console.log('\nCockpit segments');
  await page.getByRole('radio', { name: expected.segmentLabels[1], exact: true }).click();
  await page.waitForTimeout(900);
  check('the Overdue segment is the checked one', await checkedSegment(page), expected.segmentLabels[1]);
  check(
    'the Overdue segment narrows to the rows SQLite says are late',
    (await rowNumbers(page)).join(','),
    expected.overdueSegment.numbers.join(','),
  );
  const overdueCaptions = await groupCaptionParts(page);
  check(
    'and it leaves only the Overdue group',
    overdueCaptions.map(captionLine).join(' | '),
    expected.overdueSegment.groups.map((group) => group.caption).join(' | '),
  );
  // The narrowed caption's sum is the one number this segment exists to state,
  // so it is compared against SQLite as its own element rather than inside a
  // joined line.
  check(
    'the Overdue caption’s sum is the overdue rows’ biggest per-currency total',
    overdueCaptions[0]?.label,
    expected.overdueSegment.groups[0]?.label,
  );
  check(
    'the selection falls to the top of the narrowed list',
    (await selectedRow(page))?.number,
    expected.overdueSegment.numbers[0],
  );
  await shoot(page, 'invoices-segment-overdue');

  await page.getByRole('radio', { name: expected.segmentLabels[0], exact: true }).click();
  await page.waitForTimeout(900);
  check('All restores the whole set', await rowNumbers(page).then((r) => r.length), expected.listTotal);

  // --- Content column centring ---------------------------------------------
  // Routes that render through the shared Page (src/renderer/ui/Page.tsx) cap
  // their content column (1120 on Clients and Reports, 860 on Settings). On a
  // viewport wider than the cap the leftover space has to be split into two
  // equal gutters; a column pinned to the left leaves the whole remainder on
  // the right. Both halves of the contract are asserted: symmetry when the cap
  // bites, and a full-width column when it does not.
  //
  // Measured on Clients rather than on Invoices. The cockpit is not a Page any
  // more — option 3c made it a full-bleed split view with its own scrollers, so
  // it has no capped column to centre and `contentColumnGutters` would be
  // measuring the whole region and calling a zero gutter a pass. The contract
  // being guarded belongs to `Page`, and Clients is a Page.
  //
  // Measured at 1600, not at the run's default 1440. The sidebar is an inset
  // panel (see AppShell's `sideNavPanel`), so the shell consumes its own width
  // plus margins and at 1440 the content region lands on exactly the 1120 cap —
  // gutters of zero, which says nothing either way about centring.
  console.log('\nContent column centring');
  const CENTRE_TOLERANCE = 2;
  await page.setViewportSize({ width: 1600, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Clients', exact: true }).first().waitFor({ timeout: 15_000 });
  const wide = await contentColumnGutters(page);
  const wideCentred = checkTrue(
    'clients column is centred at 1600 wide',
    wide !== null && Math.abs(wide.left - wide.right) <= CENTRE_TOLERANCE,
    gutterDetail(wide),
  );
  checkTrue(
    'clients column cap actually bites at 1600 wide',
    wide !== null && Math.min(wide.left, wide.right) >= CENTRE_TOLERANCE,
    gutterDetail(wide),
  );
  checkTrue(
    'heading still starts at the column left edge',
    wide !== null && Math.abs(wide.headingOffset) <= CENTRE_TOLERANCE,
    `h1 offset from column left: ${wide === null ? 'not measured' : wide.headingOffset.toFixed(1)}`,
  );
  // Photographed only once the centring it illustrates is proven on screen.
  if (wideCentred) await shoot(page, 'clients-centred');
  else console.log('  screenshot skipped: clients-centred (column was not centred)');

  // A tighter cap on the same viewport — proof the gutters follow maxWidth
  // rather than a single hardcoded number.
  await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Settings', exact: true }).first().waitFor({ timeout: 15_000 });
  const settings = await contentColumnGutters(page);
  checkTrue(
    'settings column (cap 860) is centred at 1600 wide',
    settings !== null &&
      Math.abs(settings.left - settings.right) <= CENTRE_TOLERANCE &&
      Math.min(settings.left, settings.right) > 100,
    gutterDetail(settings),
  );

  // Narrow viewport: the cap no longer bites, so the column fills the region
  // and nothing spills sideways. 960 rather than the old 900 — that is the
  // window's own `minWidth` (src/main/window.ts), so it is the narrowest frame
  // the app can actually be put into.
  await page.setViewportSize({ width: 960, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Clients', exact: true }).first().waitFor({ timeout: 15_000 });
  const narrow = await contentColumnGutters(page);
  checkTrue(
    'column still fills the width at the 960px window minimum',
    narrow !== null &&
      Math.abs(narrow.columnWidth - narrow.availableWidth) <= CENTRE_TOLERANCE &&
      narrow.left <= CENTRE_TOLERANCE,
    gutterDetail(narrow),
  );
  // The scroll region owns `overflow: auto`, so it can scroll sideways while the
  // document's width never changes. That is the regression this guards, so it is
  // measured on the region; the document is asserted separately below.
  checkTrue(
    'scroll region does not overflow sideways at 960 wide',
    narrow !== null && narrow.regionScrollWidth <= narrow.regionClientWidth + CENTRE_TOLERANCE,
    narrow === null
      ? 'not measured'
      : `region scrollWidth: ${narrow.regionScrollWidth.toFixed(1)}, clientWidth: ${narrow.regionClientWidth.toFixed(1)}`,
  );
  checkTrue(
    'document does not overflow the viewport at 960 wide',
    narrow !== null && narrow.documentScrollWidth <= narrow.viewportWidth + CENTRE_TOLERANCE,
    narrow === null
      ? 'not measured'
      : `document scrollWidth: ${narrow.documentScrollWidth.toFixed(1)}, viewport: ${narrow.viewportWidth.toFixed(1)}`,
  );

  /*
    The cockpit's own width budget, which the Page contract above says nothing
    about. 396px of fixed list column plus the pane's min-content is a floor the
    split view cannot go under, so what is asserted is that the *document* never
    grows a horizontal scrollbar — and the floor itself is measured and printed,
    because it is a number the design owes an answer for rather than one the
    harness should quietly pick.
  */
  const cockpitFloor = await (async () => {
    let widest = null;
    for (const width of [960, 1120, 1200, 1440]) {
      await page.setViewportSize({ width, height: 960 });
      await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
      await awaitCockpit(page);
      const measured = await page.evaluate(() => {
        const heading = document.querySelector('h1');
        for (let node = heading; node?.parentElement; node = node.parentElement) {
          const region = node.parentElement;
          const styles = getComputedStyle(region);
          if (styles.overflowY === 'auto' || styles.overflowY === 'scroll') {
            return {
              regionScrollWidth: region.scrollWidth,
              regionClientWidth: region.clientWidth,
              documentScrollWidth: document.documentElement.scrollWidth,
              viewportWidth: window.innerWidth,
            };
          }
        }
        return null;
      });
      checkTrue(
        `the cockpit never widens the window at ${width}px`,
        measured !== null && measured.documentScrollWidth <= measured.viewportWidth + CENTRE_TOLERANCE,
        `document scrollWidth: ${measured?.documentScrollWidth}, viewport: ${measured?.viewportWidth}`,
      );
      if (measured !== null && widest === null && measured.regionScrollWidth > measured.regionClientWidth + CENTRE_TOLERANCE) {
        widest = { width, ...measured };
      }
      if (measured !== null && measured.regionScrollWidth <= measured.regionClientWidth + CENTRE_TOLERANCE) {
        return { fitsAt: width, firstOverflow: widest };
      }
    }
    return { fitsAt: null, firstOverflow: widest };
  })();
  console.log(
    `  info  cockpit content floor: it needs ${
      cockpitFloor.firstOverflow?.regionScrollWidth ?? 'n/a'
    }px of content width and first fits at a ${cockpitFloor.fitsAt ?? 'wider than 1440'}px window`,
  );
  checkTrue(
    'the cockpit fits without sideways scrolling at 1200px and wider',
    cockpitFloor.fitsAt !== null && cockpitFloor.fitsAt <= 1200,
    `first width with no sideways scroll: ${cockpitFloor.fitsAt}`,
  );

  // Back to the viewport and the page the rest of the run expects.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await awaitCockpit(page);

  /*
    --- The content pane scrolls vertically and only vertically --------------

    The assistant dock stopped being a floating bubble and became the trailing
    control of the breadcrumb band. Its `border-beam` preset went with it, from
    `pulse-outside` to `pulse-inner`, because the outward variant's `inset:
    -30px` bloom hung 12px past the content box and gave *every* route a
    horizontal scrollbar.

    Nothing here noticed. The document never grew — `.astryx-layout-content`
    owns the overflow, so it absorbed the bloom and scrolled sideways on its own
    — and the checks above measure the page column and the document. The
    cockpit width assertion caught it by accident, at one viewport, on one
    route, under a name that says nothing about it. This is the check that names
    it, on all four routes that render into the pane.
  */
  console.log('\nContent pane horizontal overflow');
  const OVERFLOW_TOLERANCE = 1;
  const paneRoutes = [
    { route: '#/invoices', ready: async () => awaitCockpit(page) },
    { route: '#/clients', ready: async () => page.getByRole('heading', { name: 'Clients', exact: true }).first().waitFor({ timeout: 15_000 }) },
    { route: '#/reports', ready: async () => page.getByRole('heading', { name: /Revenue by month/ }).first().waitFor({ timeout: 15_000 }) },
    { route: '#/settings', ready: async () => page.getByRole('heading', { name: 'Settings', exact: true }).first().waitFor({ timeout: 15_000 }) },
  ];
  for (const { route, ready } of paneRoutes) {
    await page.goto(`${APP_ORIGIN}/${route}`, { waitUntil: 'networkidle' });
    await ready();
    await page.waitForTimeout(500);
    const pane = await layoutContentOverflow(page);
    checkTrue(
      `the content pane has no horizontal overflow on ${route.slice(1)}`,
      pane !== null && pane.scrollWidth <= pane.clientWidth + OVERFLOW_TOLERANCE,
      pane === null
        ? 'no .astryx-layout-content in the document'
        : `scrollWidth: ${pane.scrollWidth}, clientWidth: ${pane.clientWidth}` +
          (pane.widest === null
            ? ''
            : `, widest spill: ${pane.widest.spill.toFixed(1)}px from ${pane.widest.what}`),
    );
  }

  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await awaitCockpit(page);

  // --- Sidebar pill panel ---------------------------------------------------
  // The sidebar is a floating pill: inset from every window edge, rounded,
  // shadowed, sitting on a gradient backdrop, with a toggle and a download
  // control in its top band. Geometry is measured off the real `.app-side-nav`
  // element — the class is the one contract the shell exposes for the panel
  // itself; everything interactive still goes through roles. The whole section
  // is guarded so a missing panel yields named FAILs, not a dead run.
  console.log('\nSidebar pill panel');
  try {
    const INSET_TOLERANCE = 1;

    /**
     * The panel's box against the viewport and against the content region: the
     * region is the first `overflow-y: auto|scroll` ancestor of the page h1,
     * same discovery rule as contentColumnGutters, so the "gap to the content"
     * is measured against what actually holds the page, not a class name.
     * Also walks `.app-side-nav` and its ancestors up to (not including) body
     * for sideways overflow that could render a scrollbar, naming the first
     * offender by class; clipped overhangs are reported informationally.
     */
    const panel = await page.evaluate(() => {
      const nav = document.querySelector('.app-side-nav');
      if (!nav) return null;
      const box = nav.getBoundingClientRect();

      let contentLeft = null;
      let node = document.querySelector('h1');
      while (node?.parentElement) {
        const styles = getComputedStyle(node.parentElement);
        if (styles.overflowY === 'auto' || styles.overflowY === 'scroll') {
          contentLeft = node.parentElement.getBoundingClientRect().left;
          break;
        }
        node = node.parentElement;
      }

      // Only an `overflow-x: auto|scroll` box is a scroll container, so only
      // those can paint a horizontal bar; a `clip`/`hidden` box still reports
      // the clipped content through scrollWidth without ever scrolling. The
      // first kind is a failure, the second is noted so growth stays visible.
      let overflowing = null;
      const clippedOverhangs = [];
      for (let element = nav; element && element !== document.body; element = element.parentElement) {
        if (element.scrollWidth > element.clientWidth + 1) {
          const description = `<${element.tagName.toLowerCase()} class="${element.getAttribute('class') ?? ''}"> ` +
            `scrollWidth ${element.scrollWidth} > clientWidth ${element.clientWidth} + 1`;
          const overflowX = getComputedStyle(element).overflowX;
          if (overflowX === 'auto' || overflowX === 'scroll') {
            if (overflowing === null) overflowing = description;
          } else {
            clippedOverhangs.push(`${description} (overflow-x: ${overflowX}, cannot scroll)`);
          }
        }
      }

      const styles = getComputedStyle(nav);
      return {
        top: box.top,
        left: box.left,
        bottom: window.innerHeight - box.bottom,
        rightGap: contentLeft === null ? null : contentLeft - box.right,
        borderRadius: styles.borderRadius,
        boxShadow: styles.boxShadow,
        overflowing,
        clippedOverhangs,
      };
    });

    const panelDetail =
      panel === null
        ? 'no .app-side-nav element in the document'
        : `top: ${panel.top.toFixed(1)}, left: ${panel.left.toFixed(1)}, bottom: ${panel.bottom.toFixed(1)}, ` +
          `gap to content: ${panel.rightGap === null ? 'content region not found' : panel.rightGap.toFixed(1)}`;
    const insetOk = checkTrue(
      'sidebar is inset from all four edges',
      panel !== null &&
        panel.top > 0 &&
        panel.left > 0 &&
        panel.bottom > 0 &&
        panel.rightGap !== null &&
        panel.rightGap > 0,
      panelDetail,
    );
    // Equal top/bottom/left gaps are what make it read as a floating panel
    // rather than a column with a stray margin.
    const insetEqual = checkTrue(
      'top, bottom and left insets are equal within 1px',
      panel !== null &&
        Math.abs(panel.top - panel.left) <= INSET_TOLERANCE &&
        Math.abs(panel.top - panel.bottom) <= INSET_TOLERANCE,
      panelDetail,
    );
    // border-radius resolves to a length once computed; the first number is the
    // one every corner shares on a uniform radius.
    const radiusPx = panel === null ? NaN : parseFloat(panel.borderRadius);
    const radiusOk = checkTrue(
      'sidebar corner radius is at least 12px',
      Number.isFinite(radiusPx) && radiusPx >= 12,
      `computed border-radius: ${panel === null ? 'not measured' : panel.borderRadius}`,
    );
    const shadowOk = checkTrue(
      'sidebar casts a shadow',
      panel !== null && panel.boxShadow !== 'none',
      `computed box-shadow: ${panel === null ? 'not measured' : panel.boxShadow}`,
    );
    checkTrue(
      'sidebar column has no sideways overflow',
      panel !== null && panel.overflowing === null,
      panel === null ? 'not measured' : panel.overflowing ?? 'no scrollable element overflows',
    );
    for (const overhang of panel?.clippedOverhangs ?? []) {
      console.log(`  info  clipped overhang: ${overhang}`);
    }

    // Photographed only once the pill it illustrates is proven on screen.
    if (insetOk && insetEqual && radiusOk && shadowOk) await shoot(page, 'sidebar-pill');
    else console.log('  screenshot skipped: sidebar-pill (panel geometry did not hold)');

    // --- Top-row controls: the toggle lives in the panel, above the brand row.
    const toggle = page.getByRole('button', { name: 'Toggle sidebar' });
    const toggleExists = checkTrue(
      'sidebar has a "Toggle sidebar" control',
      (await toggle.count()) > 0,
      `buttons named "Toggle sidebar": ${await toggle.count()}`,
    );
    if (toggleExists) {
      checkTrue(
        'toggle control is inside the sidebar panel',
        await toggle.first().evaluate((element) => element.closest('.app-side-nav') !== null),
        'element.closest(".app-side-nav")',
      );
      // Option 3a split the panel's head into two 40px bands: lights alone in
      // the first, brand *and* collapse toggle sharing the second. So the
      // toggle no longer sits above the brand — it sits beside it, at the far
      // end of the same row, and below the light band.
      const toggleBox = await toggle.first().boundingBox();
      const brandBox = await page.getByRole('link', { name: 'InvoiceApp' }).first().boundingBox();
      const bands = await shellChrome(page);
      checkTrue(
        'toggle shares the brand row and sits at its inline end',
        toggleBox !== null &&
          brandBox !== null &&
          toggleBox.y < brandBox.y + brandBox.height &&
          brandBox.y < toggleBox.y + toggleBox.height &&
          toggleBox.x > brandBox.x + brandBox.width,
        `toggle: ${JSON.stringify(toggleBox)}, brand: ${JSON.stringify(brandBox)}`,
      );
      checkTrue(
        'the brand row sits below the traffic-light band',
        bands?.lightsBand != null &&
          bands.brandBand != null &&
          bands.brandBand.top >= bands.lightsBand.bottom - 1,
        `lights band: ${bands?.lightsBand?.top}-${bands?.lightsBand?.bottom}, brand band: ${bands?.brandBand?.top}-${bands?.brandBand?.bottom}`,
      );

      const navWidth = async () =>
        page.evaluate(() => document.querySelector('.app-side-nav')?.getBoundingClientRect().width ?? null);
      const expandedWidth = await navWidth();
      await toggle.first().click();
      await page.waitForTimeout(600);
      const collapsedWidth = await navWidth();
      const collapsed = checkTrue(
        'toggle collapses the sidebar',
        expandedWidth !== null && collapsedWidth !== null && collapsedWidth < expandedWidth,
        `expanded: ${expandedWidth?.toFixed(1)}, collapsed: ${collapsedWidth?.toFixed(1)}`,
      );
      if (collapsed) await shoot(page, 'sidebar-collapsed');
      else console.log('  screenshot skipped: sidebar-collapsed (sidebar did not collapse)');

      await toggle.first().click();
      await page.waitForTimeout(600);
      const restoredWidth = await navWidth();
      checkTrue(
        'toggle restores the sidebar width',
        expandedWidth !== null && restoredWidth !== null && Math.abs(restoredWidth - expandedWidth) <= 1,
        `expanded: ${expandedWidth?.toFixed(1)}, restored: ${restoredWidth?.toFixed(1)}`,
      );

      // The panel must still navigate after a collapse round-trip.
      await page.locator('.app-side-nav').getByRole('link', { name: 'Clients', exact: true }).click();
      await page.waitForTimeout(900);
      checkTrue(
        'nav still navigates after a collapse round-trip',
        new URL(page.url()).hash.startsWith('#/clients'),
        `hash: ${new URL(page.url()).hash}`,
      );
      await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
      await awaitCockpit(page);
    }

    // --- The surface contract, in both themes: the *panel* paints a vertical
    // gradient and nothing behind it paints one. Both halves are asserted,
    // because "a gradient exists somewhere" was also true of the previous,
    // inverted design (washed window, flat panel).
    for (const mode of ['Light', 'Dark']) {
      const settled = await setAppearance(page, mode);
      const surfaces = await gradientSurfaces(page);
      checkTrue(
        `sidebar panel paints its own gradient in ${mode.toLowerCase()} mode`,
        settled && surfaces !== null && surfaces.panelHasGradient,
        surfaces === null
          ? 'no .app-side-nav found'
          : `theme settled: ${settled}, .app-side-nav background-image: ${surfaces.panel}`,
      );
      checkTrue(
        `backdrop behind the panel stays flat in ${mode.toLowerCase()} mode`,
        surfaces !== null && surfaces.backdrop === null,
        surfaces?.backdrop ?? 'no gradient on any ancestor of .app-side-nav',
      );
      // The other half of the contrast, and the one the first cut got wrong: the
      // content pane must be the *window* colour, not `--color-background-surface`
      // (core's default for `astryx-layout-content`, and the same colour as the
      // panel's head — which made the sidebar the darker of the two).
      const pane = await paneVersusPanel(page);
      checkTrue(
        `content pane is flat window colour in ${mode.toLowerCase()} mode`,
        pane !== null && pane.paneMatchesBody && pane.paneImage === 'none',
        pane === null
          ? 'no .astryx-layout-content found'
          : `pane: ${pane.pane}, body: ${pane.body}, pane background-image: ${pane.paneImage}`,
      );
      checkTrue(
        `panel head stands off the pane in ${mode.toLowerCase()} mode`,
        pane !== null && pane.panelHeadOffPane,
        pane === null ? 'no pane' : `panel head: ${pane.panelHead}, pane: ${pane.pane}`,
      );
      // Let the list finish arriving, or the shot photographs the spinner.
      await awaitCockpit(page);
      await shoot(page, `sidebar-${mode.toLowerCase()}`);
    }

    // --- The sidebar's own appearance toggle actually flips the mode.
    // It is a two-state glyph, so its accessible name states the destination
    // and changes with every press — which is also how this finds it twice.
    // The loop above left the app dark, so return to light first: the name to
    // look for depends on the mode, and a fixed name needs a fixed baseline.
    await setAppearance(page, 'Light');
    const darkToggle = page.getByRole('button', { name: 'Switch to dark theme' });
    const toggleFound = checkTrue(
      'sidebar offers a "Switch to dark theme" control',
      (await darkToggle.count()) > 0,
      `buttons named "Switch to dark theme": ${await darkToggle.count()}`,
    );
    if (toggleFound) {
      checkTrue(
        'appearance toggle is inside the sidebar panel',
        await darkToggle.first().evaluate((element) => element.closest('.app-side-nav') !== null),
        'element.closest(".app-side-nav")',
      );
      await darkToggle.first().click();
      const wentDark = await waitForTheme(page, 'dark');
      const afterColors = await paintedColors(page);
      checkTrue(
        'sidebar toggle switches the app to dark',
        wentDark,
        `body: ${afterColors.body}, surface: ${afterColors.surface}`,
      );
      const lightToggle = page.getByRole('button', { name: 'Switch to light theme' });
      checkTrue(
        'the toggle relabels itself to the new destination',
        (await lightToggle.count()) > 0,
        `buttons named "Switch to light theme": ${await lightToggle.count()}`,
      );
      if ((await lightToggle.count()) > 0) {
        await lightToggle.first().click();
        checkTrue(
          'sidebar toggle switches back to light',
          await waitForTheme(page, 'light'),
          `body: ${(await paintedColors(page)).body}`,
        );
      }
    }
    // --- Where the three-way control lives now. The sidebar glyph cannot
    // express `Auto`, so Settings has to, and it has to apply immediately —
    // outside the "Save settings" flow, like the update controls.
    await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Appearance', exact: true }).first().waitFor({ timeout: 15_000 });
    for (const name of ['Light', 'Dark', 'Auto']) {
      checkTrue(
        `settings appearance offers "${name}"`,
        (await page.getByRole('radio', { name, exact: true }).count()) > 0,
        `radios named "${name}": ${await page.getByRole('radio', { name, exact: true }).count()}`,
      );
    }
    await shoot(page, 'settings-appearance');

    // Back to the light baseline the rest of the run expects.
    await setAppearance(page, 'Light');
    await awaitCockpit(page);
  } catch (error) {
    fail('sidebar pill panel section did not complete', String(error));
  }

  // --- The window frame -----------------------------------------------------
  /*
    Option 3a rebuilt the frame around four bands, all of them 40px except the
    breadcrumb's 36:

      expanded   sidebar band 1: three traffic-light placeholders and nothing
                 else, so the drag region is real and nothing looks accidentally
                 right-aligned; sidebar band 2: brand lockup and the collapse
                 toggle; content column: the tab-strip band, then the breadcrumb
                 band under it.
      collapsed  three lights cannot share a 56px rail, so the lights, the
                 expand toggle and a centred `InvoiceApp — <page>` title move
                 into a full-width unified title bar and the rail starts
                 underneath. The panel then has no header of its own at all.

    The update and appearance glyphs are no longer in the band: they moved to
    the panel's footer beside Settings, where they have a home.

    The 40/36/56 numbers are the design, not an implementation detail, so they
    are asserted as numbers rather than as "smaller than before".
  */
  const BAND_HEIGHT = 40;
  const CRUMB_HEIGHT = 36;
  const COLLAPSED_RAIL_WIDTH = 56;
  console.log('\nWindow frame: bands, rail and breadcrumbs');
  try {
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await awaitCockpit(page);

    const expandedChrome = await shellChrome(page);
    const dots = expandedChrome?.dots ?? [];
    check('web build paints exactly three window-control placeholders', dots.length, 3);
    checkTrue(
      'placeholders are the macOS palette, in macOS order',
      dots.map((dot) => dot.color).join(' ') ===
        'rgb(255, 95, 87) rgb(254, 188, 46) rgb(40, 200, 64)',
      dots.map((dot) => dot.color).join(' ') || 'no dots found',
    );
    checkTrue(
      'placeholders are 12px circles, 8px apart',
      dots.length === 3 &&
        dots.every((dot) => Math.abs(dot.width - 12) <= 0.5 && Math.abs(dot.height - 12) <= 0.5) &&
        Math.abs(dots[1].left - dots[0].right - 8) <= 0.5 &&
        Math.abs(dots[2].left - dots[1].right - 8) <= 0.5,
      dots.map((dot) => `${dot.left.toFixed(1)}-${dot.right.toFixed(1)}`).join(' '),
    );
    // The whole reason the placeholders exist: they have to occupy the window
    // corner macOS occupies (x 13-70), inside the sidebar's own drag band.
    checkTrue(
      'placeholder cluster sits where the macOS lights do',
      dots.length === 3 && dots[0].left >= 8 && dots[0].left <= 20 && dots[2].right <= 70,
      dots.length === 3
        ? `cluster: ${dots[0].left.toFixed(1)} to ${dots[2].right.toFixed(1)} (want left 8-20, right <= 70)`
        : 'no cluster measured',
    );
    checkTrue(
      'placeholders are inside the sidebar title band',
      dots.length === 3 && dots.every((dot) => dot.inBand && dot.inSideNav),
      `in band: ${dots.map((dot) => dot.inBand).join(',')}, in panel: ${dots.map((dot) => dot.inSideNav).join(',')}`,
    );
    // Decoration standing in for OS chrome: not a focus stop, no tooltip, hidden
    // from assistive tech, and *inside* the drag region so the corner still
    // drags. `drag` on the band, `none` on the dots is what the last two mean.
    checkTrue(
      'placeholders are inert decoration',
      dots.length === 3 &&
        dots.every((dot) => !dot.focusable && !dot.hasTitle) &&
        expandedChrome?.cluster?.ariaHidden === 'true',
      `focusable: ${dots.map((dot) => dot.focusable).join(',')}, titles: ${dots.map((dot) => dot.hasTitle).join(',')}, cluster aria-hidden: ${expandedChrome?.cluster?.ariaHidden}`,
    );
    checkTrue(
      'the band drags and the dots do not carve a hole in it',
      expandedChrome?.lightsBand?.appRegion === 'drag' && dots.every((dot) => dot.appRegion === 'none'),
      `band: ${expandedChrome?.lightsBand?.appRegion}, dots: ${dots.map((dot) => dot.appRegion).join(',')}`,
    );

    // --- Band 1 holds the lights and nothing else -------------------------
    check('the light band is 40px tall', Math.round(expandedChrome?.lightsBand?.height ?? -1), BAND_HEIGHT);
    check('nothing interactive shares the light band', (await page.evaluate(() => {
      const band = document.querySelector('.app-side-nav .app-drag-region');
      return band === null ? -1 : band.querySelectorAll('a, button, input, [tabindex]').length;
    })), 0);

    // --- Band 2: brand lockup and the collapse toggle, and only those ------
    const brandNames = (expandedChrome?.brandButtons ?? []).map((button) => button.name);
    check('the brand band is 40px tall', Math.round(expandedChrome?.brandBand?.height ?? -1), BAND_HEIGHT);
    check('the brand band holds the collapse toggle alone', brandNames.join('|'), 'Toggle sidebar');
    checkTrue(
      'the collapse toggle opts out of the drag region',
      (expandedChrome?.brandButtons ?? []).every((button) => button.appRegion === 'no-drag'),
      (expandedChrome?.brandButtons ?? []).map((button) => `${button.name}: ${button.appRegion}`).join(', '),
    );
    check(
      'the collapse toggle states whether the panel is open',
      await page.getByRole('button', { name: 'Toggle sidebar' }).first().getAttribute('aria-expanded'),
      'true',
    );

    // --- The panel's foot: Settings, update, appearance --------------------
    // This is where option 3a put the two utility glyphs — beside Settings,
    // aligned to something, instead of floating in the traffic-light strip.
    const footNames = (expandedChrome?.footer ?? []).map((entry) => `${entry.tag}:${entry.name}`);
    checkTrue(
      'the panel foot holds Settings, the update glyph and the theme glyph, in that order',
      footNames.length === 3 &&
        footNames[0] === 'a:Settings' &&
        /^button:.*update/i.test(footNames[1]) &&
        /^button:Switch to (dark|light) theme$/.test(footNames[2]),
      JSON.stringify(footNames),
    );
    const footBox = await page.evaluate(() => {
      const settings = [...document.querySelectorAll('.app-side-nav a')].find(
        (link) => (link.textContent ?? '').trim() === 'Settings',
      );
      if (settings === undefined) return null;
      let root = settings;
      const nav = document.querySelector('.app-side-nav');
      while (root !== null && root.parentElement !== nav) root = root.parentElement;
      if (root === null) return null;
      const rect = root.getBoundingClientRect();
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
    });
    await shootRegion(page, 'sidebar-footer-light', footBox, 16);

    // --- The tab-strip band and the breadcrumb band under it ---------------
    // `contentBand()` takes the first `.app-drag-region` outside the panel, and
    // the shell gave the unified title bar its own class precisely so that
    // still means the tab strip. Verified, rather than trusted.
    check('the tab-strip band is 40px tall', Math.round(expandedChrome?.stripBand?.height ?? -1), BAND_HEIGHT);
    check('the breadcrumb band is 36px tall', Math.round(expandedChrome?.crumbBand?.height ?? -1), CRUMB_HEIGHT);
    checkTrue(
      'the breadcrumb band sits directly under the tab-strip band',
      expandedChrome?.stripBand != null &&
        expandedChrome.crumbBand != null &&
        Math.abs(expandedChrome.crumbBand.top - expandedChrome.stripBand.bottom) <= 1,
      `strip bottom: ${expandedChrome?.stripBand?.bottom}, crumb top: ${expandedChrome?.crumbBand?.top}`,
    );
    check(
      'contentBand() still finds the tab strip and not the title bar',
      Math.round((await contentBand(page))?.height ?? -1),
      BAND_HEIGHT,
    );

    // --- The trail says the route, step by step ---------------------------
    const listCrumbs = await breadcrumbBand(page);
    check('the breadcrumb band is a landmark', listCrumbs?.trailLabel, 'Page location');
    check(
      'the trail on /invoices is Billing / Invoices',
      listCrumbs?.steps.map((step) => step.label).join(' / '),
      'Billing / Invoices',
    );
    check('the last step is the current page', listCrumbs?.steps.at(-1)?.isCurrent, true);
    check('the group step is not a link', listCrumbs?.steps[0]?.href, null);
    check(
      'the status line states the open and overdue counts SQLite holds',
      listCrumbs?.status,
      expected.shellStatusLine,
    );
    /*
      "Overdue" used to mean two different things on this one screen: the
      breadcrumb counted the rows carrying `status = 'overdue'`, the segmented
      control counted the rows whose due date has passed. There is one
      definition now — `countOpenInvoices`, date-derived — so the two figures
      are asserted equal *to each other* on screen, not only each against its
      own expectation. Keeping them in step is the whole point of the fix, and
      only this check would notice them drifting apart again.
    */
    const crumbCounts = statusCounts(listCrumbs?.status);
    check(
      'the status line’s overdue figure is the date-derived one, not the stored flag',
      crumbCounts.overdue,
      expected.shellOverdue,
    );
    check(
      'the breadcrumb and the Overdue segment state the same number',
      crumbCounts.overdue,
      Number(/\d+/.exec((await segmentNames(page))[1] ?? '')?.[0] ?? NaN),
    );
    check('the status line’s open figure is the count of open rows', crumbCounts.open, expected.shellOpen);
    // The same pair, on the nav row, from the same fetch.
    check(
      'the Invoices nav row carries the same open count',
      (await page.getByRole('navigation', { name: 'Side navigation' }).getByRole('link', { name: /^Invoices/ }).innerText())
        .trim()
        .replace(/\s+/g, ' '),
      `Invoices ${expected.shellOpen}`,
    );
    await shootRegion(page, 'shell-breadcrumbs-light', expandedChrome?.crumbBand, 26);

    // Deeper routes grow the trail rather than replacing it.
    await page.goto(`${APP_ORIGIN}/#/invoices/${tabFixtures[0].id}/edit`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: tabFixtures[0].number }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const editorCrumbs = await breadcrumbBand(page);
    check(
      'the editor route grows the trail to four steps',
      editorCrumbs?.steps.map((step) => step.label).join(' / '),
      `Billing / Invoices / ${tabFixtures[0].number} / Edit`,
    );
    check('Invoices is a link once it is an ancestor', editorCrumbs?.steps[1]?.href, '#/invoices');
    check('the invoice step links to its own route', editorCrumbs?.steps[2]?.href, `#/invoices/${tabFixtures[0].id}`);
    check('only the last step is current', editorCrumbs?.steps.filter((step) => step.isCurrent).length, 1);
    await shootRegion(page, 'shell-breadcrumbs-editor', (await shellChrome(page))?.crumbBand, 26);

    // Settings has no group above it, so the trail is one step long — and the
    // status line is the same pair whatever route is showing.
    await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Settings', exact: true }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(600);
    const settingsCrumbs = await breadcrumbBand(page);
    check(
      'a section with no group gets a one-step trail',
      settingsCrumbs?.steps.map((step) => step.label).join(' / '),
      'Settings',
    );
    check('the status line follows the route', settingsCrumbs?.status, expected.shellStatusLine);

    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await awaitCockpit(page);

    // --- Collapsed: the unified title bar ---------------------------------
    const collapseToggle = page.getByRole('button', { name: 'Toggle sidebar' });
    await collapseToggle.first().click();
    await page.waitForTimeout(700);
    const collapsedChrome = await shellChrome(page);
    checkTrue(
      'collapsing raises a full-width unified title bar',
      collapsedChrome?.unified != null &&
        Math.round(collapsedChrome.unified.height) === BAND_HEIGHT &&
        Math.round(collapsedChrome.unified.left) === 0 &&
        Math.abs(collapsedChrome.unified.width - 1440) <= 1,
      collapsedChrome?.unified === null
        ? 'no .app-unified-title-bar in the document'
        : `${collapsedChrome?.unified?.left} to ${collapsedChrome?.unified?.right}, height ${collapsedChrome?.unified?.height}`,
    );
    check('the title bar takes the three lights with it', collapsedChrome?.unified?.dotCount, 3);
    check('none of the lights is left in the panel', collapsedChrome?.dots.filter((dot) => dot.inSideNav).length, 0);
    check('the panel keeps no drag band of its own', collapsedChrome?.navBandCount, 0);
    check('the title bar holds the expand toggle', (collapsedChrome?.unified?.buttons ?? []).join('|'), 'Toggle sidebar');
    check(
      'the expand toggle states that the panel is shut',
      await page.getByRole('button', { name: 'Toggle sidebar' }).first().getAttribute('aria-expanded'),
      'false',
    );
    checkTrue(
      'the title bar names the app and the page it is showing',
      (collapsedChrome?.unified?.title ?? '').includes('InvoiceApp — Invoices'),
      `title bar text: ${JSON.stringify(collapsedChrome?.unified?.title)}`,
    );
    checkTrue(
      'the unified title bar is window-drag surface',
      collapsedChrome?.unified?.appRegion === 'drag',
      `-webkit-app-region: ${collapsedChrome?.unified?.appRegion}`,
    );
    // ...and the rail starts underneath it, 56px wide.
    check('the collapsed rail is 56px wide', Math.round(collapsedChrome?.rail.width ?? -1), COLLAPSED_RAIL_WIDTH);
    check('the panel knows it is collapsed', collapsedChrome?.rail.isCollapsed, true);
    checkTrue(
      'the rail starts below the unified title bar',
      collapsedChrome?.unified != null && collapsedChrome.rail.top >= collapsedChrome.unified.bottom - 1,
      `title bar bottom: ${collapsedChrome?.unified?.bottom}, rail top: ${collapsedChrome?.rail.top}`,
    );
    checkTrue(
      'no rail control overlaps the placeholder cluster',
      (collapsedChrome?.dots ?? []).length === 3 &&
        (collapsedChrome?.controls ?? []).every((control) =>
          collapsedChrome.dots.every(
            (dot) =>
              !(control.left < dot.right && dot.left < control.right && control.top < dot.bottom && dot.top < control.bottom),
          ),
        ),
      `dots y: ${(collapsedChrome?.dots ?? []).map((dot) => `${dot.top}-${dot.bottom}`).join(',')}`,
    );
    // The utility glyphs travel with the footer, not with the lights.
    checkTrue(
      'the collapsed rail keeps the whole footer row',
      (collapsedChrome?.footer ?? []).length === 3 &&
        collapsedChrome.footer[0].name === 'Settings' &&
        collapsedChrome.footer.some((entry) => /update/i.test(entry.name)) &&
        collapsedChrome.footer.some((entry) => /^Switch to (dark|light) theme$/.test(entry.name)),
      JSON.stringify((collapsedChrome?.footer ?? []).map((entry) => entry.name)),
    );
    // The two content bands are unchanged by the collapse.
    check('the tab-strip band survives the collapse at 40px', Math.round(collapsedChrome?.stripBand?.height ?? -1), BAND_HEIGHT);
    check('the breadcrumb band survives the collapse at 36px', Math.round(collapsedChrome?.crumbBand?.height ?? -1), CRUMB_HEIGHT);
    check(
      'contentBand() still finds the strip band, not the unified bar',
      Math.round((await contentBand(page))?.height ?? -1),
      BAND_HEIGHT,
    );
    checkTrue(
      'collapsed rail has no horizontal scroll range',
      collapsedChrome?.rail.scrollWidth === collapsedChrome?.rail.clientWidth,
      `scrollWidth: ${collapsedChrome?.rail.scrollWidth}, clientWidth: ${collapsedChrome?.rail.clientWidth}`,
    );
    checkTrue(
      'expanded rail has no horizontal scroll range either',
      expandedChrome?.rail.scrollWidth === expandedChrome?.rail.clientWidth,
      `scrollWidth: ${expandedChrome?.rail.scrollWidth}, clientWidth: ${expandedChrome?.rail.clientWidth}`,
    );
    await shoot(page, 'sidebar-chrome-collapsed-light');
    await shootRegion(page, 'shell-unified-title-bar-light', collapsedChrome?.unified, 20);
    await collapseToggle.first().click();
    await page.waitForTimeout(700);
    check(
      'expanding puts the title bar away again',
      await page.locator('.app-unified-title-bar').count(),
      0,
    );
    await shoot(page, 'sidebar-chrome-expanded-light');

    // Both modes, both states — the dots, the glyphs and the trail have to read
    // on the panel's head in dark mode too.
    await setAppearance(page, 'Dark');
    await awaitCockpit(page);
    const darkChrome = await shellChrome(page);
    checkTrue(
      'placeholders keep the macOS palette in dark mode',
      (darkChrome?.dots ?? []).map((dot) => dot.color).join(' ') ===
        'rgb(255, 95, 87) rgb(254, 188, 46) rgb(40, 200, 64)',
      (darkChrome?.dots ?? []).map((dot) => dot.color).join(' '),
    );
    check('the bands keep their heights in dark mode', [
      Math.round(darkChrome?.lightsBand?.height ?? -1),
      Math.round(darkChrome?.brandBand?.height ?? -1),
      Math.round(darkChrome?.stripBand?.height ?? -1),
      Math.round(darkChrome?.crumbBand?.height ?? -1),
    ].join(','), `${BAND_HEIGHT},${BAND_HEIGHT},${BAND_HEIGHT},${CRUMB_HEIGHT}`);
    const darkCrumbs = await breadcrumbBand(page);
    check('the trail still reads the route in dark mode', darkCrumbs?.steps.map((step) => step.label).join(' / '), 'Billing / Invoices');
    await shoot(page, 'sidebar-chrome-expanded-dark');
    await shootRegion(page, 'shell-breadcrumbs-dark', darkChrome?.crumbBand, 26);
    await shootRegion(page, 'sidebar-footer-dark', footBox, 16);
    await collapseToggle.first().click();
    await page.waitForTimeout(700);
    const darkCollapsed = await shellChrome(page);
    checkTrue(
      'the collapsed dark rail is still 56px and does not scroll sideways',
      Math.round(darkCollapsed?.rail.width ?? -1) === COLLAPSED_RAIL_WIDTH &&
        darkCollapsed?.rail.scrollWidth === darkCollapsed?.rail.clientWidth,
      `rail width: ${darkCollapsed?.rail.width}, scrollWidth: ${darkCollapsed?.rail.scrollWidth}, clientWidth: ${darkCollapsed?.rail.clientWidth}`,
    );
    check('the dark title bar names the page too', (darkCollapsed?.unified?.title ?? '').includes('InvoiceApp — Invoices'), true);
    await shoot(page, 'sidebar-chrome-collapsed-dark');
    await shootRegion(page, 'shell-unified-title-bar-dark', darkCollapsed?.unified, 20);
    await collapseToggle.first().click();
    await page.waitForTimeout(700);
    await setAppearance(page, 'Light');
    await awaitCockpit(page);

    // --- The update control: permanent, and blue only when one is waiting.
    const resting = await updateControl(page);
    checkTrue(
      'update control is always rendered, resting',
      resting !== null && resting.name === 'Update status unavailable',
      `name: ${resting?.name ?? 'no control found'}`,
    );
    // `error` is this preview's normal phase — every `updates:*` channel answers
    // 501 — so the resting reading is taken from exactly the state that must not
    // light up.
    checkTrue(
      'resting update control is not blue',
      resting !== null && !isBlue(resting.color) && !isBlue(resting.glyphColor ?? resting.color),
      `color: ${resting?.color}, glyph: ${resting?.glyphColor}, token: ${resting?.pendingToken}`,
    );

    /*
      The pending state cannot be reached through the preview server: it answers
      `updates:getState` with 501, which is what makes `error` the resting phase
      above. So it is driven at the seam the renderer actually reads — a wrapper
      installed on `window.api` before the app boots, answering that one channel
      with an `available` snapshot and delegating everything else to the real
      shim. Nothing in `src/**` is stubbed: the phase comes from main in the real
      app, and this is the same value arriving on the same channel.
    */
    const pendingPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    pendingPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await pendingPage.addInitScript((snapshot) => {
      // `preview/web-shim.ts` installs the object with a `value` descriptor, so
      // an accessor planted here would simply be replaced. The definition itself
      // is therefore what gets intercepted — once, for `window.api` only.
      const defineProperty = Object.defineProperty;
      Object.defineProperty = function patched(target, property, descriptor) {
        if (target === window && property === 'api' && descriptor && 'value' in descriptor) {
          const real = descriptor.value;
          return defineProperty(target, property, {
            ...descriptor,
            value: {
              ...real,
              invoke: (channel, payload) =>
                channel === 'updates:getState'
                  ? Promise.resolve(snapshot)
                  : real.invoke(channel, payload),
              on: (channel, listener) => real.on(channel, listener),
            },
          });
        }
        return defineProperty(target, property, descriptor);
      };
    }, {
      phase: 'available',
      currentVersion: '0.1.7',
      availableVersion: '0.1.8',
      progressPercent: null,
      transferredBytes: null,
      totalBytes: null,
      message: null,
    });
    await pendingPage.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await pendingPage.getByRole('button', { name: 'Update available' }).first().waitFor({ timeout: 15_000 });
    const pending = await updateControl(pendingPage);
    checkTrue(
      'a waiting update relabels the control',
      pending !== null && pending.name === 'Update available',
      `name: ${pending?.name}`,
    );
    checkTrue(
      'a waiting update paints the control blue',
      pending !== null && isBlue(pending.color) && isBlue(pending.glyphColor ?? pending.color),
      `color: ${pending?.color}, glyph: ${pending?.glyphColor}, token: ${pending?.pendingToken}`,
    );
    checkTrue(
      'the blue is a different colour from the resting ink',
      pending !== null && resting !== null && pending.color !== resting.color,
      `pending: ${pending?.color}, resting: ${resting?.color}`,
    );
    // Both states go to the same place: the real update UI on Settings.
    await pendingPage.getByRole('button', { name: 'Update available' }).first().click();
    await pendingPage.waitForTimeout(700);
    checkTrue(
      'the update control navigates to Settings',
      new URL(pendingPage.url()).hash.startsWith('#/settings'),
      `hash: ${new URL(pendingPage.url()).hash}`,
    );
    await shoot(pendingPage, 'sidebar-chrome-update-pending');
    await pendingPage.close();
  } catch (error) {
    fail('sidebar top-row chrome section did not complete', String(error));
  }

  // --- Invoice tabs --------------------------------------------------------
  /*
    The strip in the content column's band: one pill per open invoice, the active
    one filled, a trailing `+`. Behaviour first, appearance second, and the
    behaviour is asserted on role/name locators — `role="toolbar"` named
    "Open invoices", the pills' own accessible names, `aria-current="page"` for
    the active one — never on the pill class, which is only used for the two
    things a locator cannot read: computed `-webkit-app-region` and colour.

    Tab state is in memory (see `useInvoiceTabs`), so a `reload()` is the reset.
  */
  console.log('\nInvoice tabs');
  try {
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(`${APP_ORIGIN}/#/settings`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: 'Settings', exact: true }).first().waitFor({ timeout: 15_000 });

    const settingsBand = await contentBand(page);
    checkTrue(
      'with no tabs open the band is empty reserved space',
      settingsBand !== null && !settingsBand.hasStrip && settingsBand.ariaHidden === 'true',
      `strip: ${settingsBand?.hasStrip}, aria-hidden: ${settingsBand?.ariaHidden}, height: ${settingsBand?.height}`,
    );
    check('Settings grows no stray +', await page.getByRole('button', { name: NEW_TAB_BUTTON }).count(), 0);
    checkTrue(
      'the empty band is still window-drag surface',
      settingsBand !== null && settingsBand.bandRegion === 'drag' && settingsBand.emptyRegion === 'drag',
      `band: ${settingsBand?.bandRegion}, empty point: ${settingsBand?.emptyRegion}`,
    );

    // --- one invoice, one tab ---------------------------------------------
    const firstNumber = tabFixtures[0].number;
    const firstHash = await openInvoiceFromList(page, 0);
    check('opening an invoice opens exactly one tab', (await tabNames(page)).join('|'), firstNumber);
    check('the tab is named after the invoice, not its id', await activeTabName(page), firstNumber);

    // --- the editor is the same document, not a second tab ----------------
    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.waitForTimeout(900);
    const editorHash = new URL(page.url()).hash;
    checkTrue('Edit navigates to the editor route', editorHash.endsWith('/edit'), `hash: ${editorHash}`);
    check('the editor keeps the invoice on one tab', (await tabNames(page)).join('|'), firstNumber);
    check('the editor tab is still the active one', await activeTabName(page), firstNumber);

    // --- a second invoice -------------------------------------------------
    const secondNumber = tabFixtures[1].number;
    const secondHash = await openInvoiceFromList(page, 1);
    check('a second invoice appends a second tab', (await tabNames(page)).join('|'), `${firstNumber}|${secondNumber}`);
    check('the newly opened invoice is the active tab', await activeTabName(page), secondNumber);

    // --- clicking a tab moves the route ------------------------------------
    await tabStrip(page).getByRole('button', { name: firstNumber, exact: true }).first().click();
    await page.waitForTimeout(800);
    check('clicking a tab navigates to its invoice', new URL(page.url()).hash, firstHash);
    check('clicking a tab moves the active state with it', await activeTabName(page), firstNumber);

    // --- closing the active tab hands over to its right neighbour ----------
    await tabStrip(page).getByRole('button', { name: `Close invoice ${firstNumber}` }).click();
    await page.waitForTimeout(800);
    check('closing the active tab navigates to the surviving tab', new URL(page.url()).hash, secondHash);
    check('the surviving tab is the only one left', (await tabNames(page)).join('|'), secondNumber);
    check('the surviving tab is active', await activeTabName(page), secondNumber);

    // --- closing the last tab lands on the list ---------------------------
    await tabStrip(page).getByRole('button', { name: `Close invoice ${secondNumber}` }).click();
    await page.waitForTimeout(800);
    check('closing the last tab falls back to the invoices list', new URL(page.url()).hash, '#/invoices');
    const closedBand = await contentBand(page);
    checkTrue(
      'the band is the empty reserved surface again',
      closedBand !== null && !closedBand.hasStrip && closedBand.ariaHidden === 'true',
      `strip: ${closedBand?.hasStrip}, aria-hidden: ${closedBand?.ariaHidden}`,
    );

    // --- the trailing + ---------------------------------------------------
    // The `+` is part of the strip, so it only exists once a tab does.
    await openInvoiceFromList(page, 0);
    await tabStrip(page).getByRole('button', { name: NEW_TAB_BUTTON }).click();
    await page.waitForTimeout(800);
    check('+ opens the draft route', new URL(page.url()).hash, '#/invoices/new');
    check('+ adds a New invoice tab', (await tabNames(page)).join('|'), `${firstNumber}|${DRAFT_TAB}`);
    check('the draft tab is active', await activeTabName(page), DRAFT_TAB);
    await tabStrip(page).getByRole('button', { name: NEW_TAB_BUTTON }).click();
    await page.waitForTimeout(700);
    check(
      'pressing + twice activates the one draft rather than adding a second',
      (await tabNames(page)).filter((name) => name === DRAFT_TAB).length,
      1,
    );
    await tabStrip(page).getByRole('button', { name: 'Close new invoice' }).click();
    await page.waitForTimeout(700);
    check('closing the draft leaves the invoice tab', (await tabNames(page)).join('|'), firstNumber);

    // --- appearance: only the active pill is filled ------------------------
    await openInvoiceFromList(page, 1);
    const twoTabs = await contentBand(page);
    // "Flat pills, only the active one filled": the inactive pill's background
    // must be genuinely unpainted (alpha 0 or the `transparent` keyword), not
    // merely a different colour from the active one.
    const unpainted = (color) =>
      color === 'transparent' || color === 'rgba(0, 0, 0, 0)' || /[\s/]0\)$/.test(color ?? '');
    checkTrue(
      'only the active pill is filled — the inactive ones are flat',
      twoTabs !== null && !unpainted(twoTabs.activeBackground) && unpainted(twoTabs.inactiveBackground),
      `active: ${twoTabs?.activeBackground}, inactive: ${twoTabs?.inactiveBackground}`,
    );
    checkTrue(
      'the active pill carries brighter ink than the inactive ones',
      twoTabs !== null && twoTabs.activeInk !== twoTabs.inactiveInk,
      `active ink: ${twoTabs?.activeInk}, inactive ink: ${twoTabs?.inactiveInk}`,
    );
    /*
      The pills used to be asserted level with the page heading below them.
      That target is gone: option 3a gives the strip its own 10px inset, the
      breadcrumb band a 16px one, and the page below is a capped column that
      centres itself — so there is no single left edge for the three of them to
      share, and pinning the pill to the h1 would now be asserting a
      coincidence. What is still a real invariant is that the pill sits inside
      the band it belongs to; the three left edges are printed beside it so the
      staircase they make is visible rather than merely absent.
    */
    const bandEdges = await page.evaluate(() => ({
      pill: document.querySelector('.app-invoice-tab')?.getBoundingClientRect().left ?? null,
      trail: document.querySelector('nav[aria-label="Page location"]')?.getBoundingClientRect().left ?? null,
      heading: document.querySelector('h1')?.getBoundingClientRect().left ?? null,
    }));
    checkTrue(
      'the pills sit inside the band that holds them',
      twoTabs !== null &&
        twoTabs.pillLeft !== null &&
        twoTabs.pillLeft >= twoTabs.left - 1 &&
        twoTabs.pillLeft <= twoTabs.right,
      `pill left: ${twoTabs?.pillLeft}, band: ${twoTabs?.left} to ${twoTabs?.right}`,
    );
    console.log(
      `  info  left edges down the window — pill ${bandEdges.pill}, breadcrumb trail ${bandEdges.trail}, page h1 ${bandEdges.heading}`,
    );

    // --- drag region -------------------------------------------------------
    checkTrue(
      'the pill and its close control opt out of the drag region',
      twoTabs !== null && twoTabs.pillRegion === 'no-drag' && twoTabs.closeRegion === 'no-drag',
      `pill: ${twoTabs?.pillRegion}, close: ${twoTabs?.closeRegion}`,
    );
    checkTrue(
      'the band beyond the strip keeps dragging the window',
      twoTabs !== null && twoTabs.bandRegion === 'drag' && twoTabs.emptyRegion === 'drag',
      `band: ${twoTabs?.bandRegion}, empty point: ${twoTabs?.emptyRegion}`,
    );

    // --- keyboard ----------------------------------------------------------
    const reached = await tabIntoStrip(page);
    checkTrue(
      'Tab reaches the strip',
      reached !== null,
      reached === null ? 'never focused anything inside the strip' : `after ${reached.presses} presses: ${reached.name}`,
    );
    const walk = await arrowWalk(page, 5);
    checkTrue(
      'arrow keys walk the pills and their close controls',
      walk.some((name) => name?.startsWith('Close ')) && walk.some((name) => name === secondNumber || name === firstNumber),
      `focus order: ${JSON.stringify(walk)}`,
    );

    // --- closing a tab must not drop focus on the floor -------------------
    // The close control *is* the focused element when it is pressed, so closing
    // destroys it. Without a deliberate handoff the browser falls back to
    // `<body>` and a keyboard user loses the toolbar on every close. These read
    // `document.activeElement` after the close, which is the only proof.
    for (let index = 2; index < 4; index++) await openInvoiceFromList(page, index);
    const fourNames = await tabNames(page);
    check('four invoices, four tabs', fourNames.length, 4);
    const activeOfFour = await activeTabName(page);

    await tabStrip(page).getByRole('button', { name: `Close invoice ${fourNames[0]}` }).focus();
    check('the close control holds focus before the close', (await focusTarget(page)).name, `Close invoice ${fourNames[0]}`);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(800);
    const afterInactiveClose = await focusTarget(page);
    checkTrue(
      'closing an inactive tab hands focus to the surviving right neighbour',
      afterInactiveClose.tag !== 'BODY' &&
        afterInactiveClose.inStrip &&
        afterInactiveClose.name === fourNames[1],
      JSON.stringify(afterInactiveClose),
    );
    check('closing an inactive tab still leaves the route alone', await activeTabName(page), activeOfFour);

    // --- two closes in one browser task both stick ------------------------
    // Both clicks dispatched inside one `evaluate`, so neither has re-rendered
    // when the other runs: an absolute state write loses the first one.
    const beforeDouble = await tabNames(page);
    check('three tabs before the double close', beforeDouble.length, 3);
    await page.evaluate((names) => {
      const buttons = [
        ...document.querySelectorAll('[role="toolbar"][aria-label="Open invoices"] button'),
      ];
      for (const name of names) {
        const button = buttons.find(
          (candidate) => candidate.getAttribute('aria-label') === `Close invoice ${name}`,
        );
        if (!button) throw new Error(`no close control for ${name}`);
        button.click();
      }
    }, [beforeDouble[0], beforeDouble[1]]);
    await page.waitForTimeout(900);
    check(
      'two inactive tabs closed in one task both stay closed',
      (await tabNames(page)).join('|'),
      beforeDouble[2],
    );
    check('the double close leaves the route on the tab that was active', await activeTabName(page), activeOfFour);


    // --- the last close: the strip is gone, focus must still land ----------
    await tabStrip(page).getByRole('button', { name: `Close invoice ${beforeDouble[2]}` }).click();
    await page.waitForTimeout(900);
    check('the last close falls back to the invoices list', new URL(page.url()).hash, '#/invoices');
    // A second read, well after the landing page has finished loading: focusing
    // the incoming page's h1 passed at 0ms and was back on <body> at 30ms, which
    // is why the target is the shell's main region instead.
    const afterLastClose = await focusTarget(page);
    await page.waitForTimeout(700);
    const settledAfterLastClose = await focusTarget(page);
    checkTrue(
      'closing the last tab moves focus onto the page it lands on, not <body>',
      afterLastClose.tag !== 'BODY' &&
        settledAfterLastClose.tag !== 'BODY' &&
        settledAfterLastClose.id === 'astryx-app-shell-main',
      `${JSON.stringify(afterLastClose)} then ${JSON.stringify(settledAfterLastClose)}`,
    );

    // --- N chained *active* closes in one task ----------------------------
    /*
      The harder shape of the same window, and a different bug. Closing the active
      tab navigates, so three of them queue three departures — and the first
      render after the batch carries the final tab list together with the pathname
      the task *started* on (measured: `useLocation` catches up over the renders
      that follow). Suppressing one "route being left" left the earlier ones
      unguarded, and the route sync re-appended the first closed invoice: pills
      `[last, first]` with the address bar and the active pill both on `last`.
    */
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const chainHashes = [];
    for (let index = 0; index < 4; index++) chainHashes.push(await openInvoiceFromList(page, index));
    const chainNames = await tabNames(page);
    check('four tabs before the chained closes', chainNames.length, 4);
    await tabStrip(page).getByRole('button', { name: chainNames[0], exact: true }).first().click();
    await page.waitForTimeout(800);
    check('the first tab is the active one before the chained closes', await activeTabName(page), chainNames[0]);
    await stripClicksInOneTask(page, [
      { kind: 'close', name: chainNames[0] },
      { kind: 'close', name: chainNames[1] },
      { kind: 'close', name: chainNames[2] },
    ]);
    check(
      'three chained active closes in one task leave exactly the last tab',
      (await tabNames(page)).join('|'),
      chainNames[3],
    );
    check('the chained closes leave the route on the surviving tab', new URL(page.url()).hash, chainHashes[3]);
    check('the surviving tab is the active one after the chained closes', await activeTabName(page), chainNames[3]);

    // --- a close in the same task as a pill click -------------------------
    /*
      Clicking a pill starts a navigation the router has not reported yet. A close
      dispatched before it commits used to read the stale rendered route, decide
      the tab the user had just selected was *inactive*, remove it without a
      replacement navigation — and then the selected route committed and the sync
      put the tab straight back. All four pills survived, on the invoice the user
      had asked to close.
    */
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await page.reload({ waitUntil: 'networkidle' });
    const raceHashes = [];
    for (let index = 0; index < 4; index++) raceHashes.push(await openInvoiceFromList(page, index));
    const raceNames = await tabNames(page);
    await tabStrip(page).getByRole('button', { name: raceNames[0], exact: true }).first().click();
    await page.waitForTimeout(800);
    await stripClicksInOneTask(page, [
      { kind: 'activate', name: raceNames[3] },
      { kind: 'close', name: raceNames[3] },
    ]);
    check(
      'a close in the same task as a pill click still closes that tab',
      (await tabNames(page)).join('|'),
      raceNames.slice(0, 3).join('|'),
    );
    checkTrue(
      'the route does not settle on the tab that close removed',
      new URL(page.url()).hash !== raceHashes[3],
      `hash: ${new URL(page.url()).hash}, closed: ${raceHashes[3]}`,
    );
    check(
      'the route falls to the closed tab’s neighbour, which still has a pill',
      new URL(page.url()).hash,
      raceHashes[2],
    );
    check('the active pill agrees with that route', await activeTabName(page), raceNames[2]);

    // --- a late label must not move the user's viewport --------------------
    /*
      The pills scroll, so the active one is scrolled into view when it *becomes*
      active. It used to be scrolled into view again on every re-render that
      changed the pill's label too, because `label` was a dependency of the same
      effect: with the strip overflowing, a number arriving 2s after the user had
      scrolled back to the oldest tabs threw the viewport to the far end. The
      active tab never changed, so nothing about the user's scroll was stale.

      The slow `invoices:get` is driven at the same seam the update-phase gate
      above uses — a wrapper on `window.api` installed before the app boots,
      delaying only that one channel and only while the flag is set, so the eight
      tabs opened first still get their numbers immediately.
    */
    const labelPage = await browser.newPage({ viewport: { width: 800, height: 960 } });
    labelPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await labelPage.addInitScript(() => {
      const defineProperty = Object.defineProperty;
      Object.defineProperty = function patched(target, property, descriptor) {
        if (target === window && property === 'api' && descriptor && 'value' in descriptor) {
          const real = descriptor.value;
          return defineProperty(target, property, {
            ...descriptor,
            value: {
              ...real,
              invoke: async (channel, payload) => {
                if (channel === 'invoices:get' && window.__delayInvoiceLabels === true) {
                  await new Promise((resolve) => {
                    setTimeout(resolve, 2000);
                  });
                }
                return real.invoke(channel, payload);
              },
              on: (channel, listener) => real.on(channel, listener),
            },
          });
        }
        return defineProperty(target, property, descriptor);
      };
    });
    await labelPage.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    for (let index = 0; index < 8; index++) await openInvoiceFromList(labelPage, index);
    await labelPage.evaluate(() => {
      window.__delayInvoiceLabels = true;
    });
    await openInvoiceFromList(labelPage, 8);
    const lateNumber = tabFixtures[8].number;
    const lateActive = await activeTabName(labelPage);
    const beforeManualScroll = await stripScroll(labelPage);
    await scrollStripToStart(labelPage);
    const manualScroll = await stripScroll(labelPage);
    checkTrue(
      'nine tabs at 800px overflow, and the strip can be scrolled back by hand',
      beforeManualScroll !== null &&
        beforeManualScroll.overflows &&
        beforeManualScroll.scrollLeft > 0 &&
        manualScroll.scrollLeft === 0,
      `before: ${JSON.stringify(beforeManualScroll)}, manual: ${JSON.stringify(manualScroll)}`,
    );
    checkTrue(
      'the newest tab is active and still waiting for its number',
      lateActive !== lateNumber,
      `active tab label: ${JSON.stringify(lateActive)}, number still to arrive: ${lateNumber}`,
    );
    await labelPage.waitForTimeout(2600);
    const afterLabel = await stripScroll(labelPage);
    check('the delayed number does arrive on the active tab', await activeTabName(labelPage), lateNumber);
    check('a label arriving late does not undo the user’s manual scroll', afterLabel?.scrollLeft, 0);

    /*
      The third ordering, and the one the ownership rule first got wrong: the
      *strip* moves the scroll between the pill parking and its number arriving.

      A resize is not the user scrolling. The observer used to call
      `scrollIntoView` without re-parking, so the pill then read a `scrollLeft` it
      did not recognise, assumed the user had taken over, and refused the
      correction — leaving the active pill 11.94px past the scroller's edge and its
      close control 3.94px past, with the number already painted.
    */
    await labelPage.evaluate(() => {
      window.__delayInvoiceLabels = true;
    });
    await openInvoiceFromList(labelPage, 9);
    const resizeNumber = tabFixtures[9].number;
    checkTrue(
      'a tenth tab is active and still holding the placeholder',
      (await activeTabName(labelPage)) !== resizeNumber,
      `active: ${JSON.stringify(await activeTabName(labelPage))}, awaited number: ${resizeNumber}`,
    );
    /*
      The strip scrolls itself — not the user — after the pill has parked. 1000px
      and not 1600: the clipping only exists while the pill is *flush* with the
      scroller's edge, and at 1600px ten pills stop overflowing altogether, so the
      pill gains slack and the 12px it is about to grow by costs nothing. The
      resize has to leave the strip still overflowing to reproduce anything.
    */
    await labelPage.setViewportSize({ width: 1000, height: 960 });
    await labelPage.waitForTimeout(400);
    await labelPage.waitForTimeout(2600);
    const afterResizeLabel = await plusReach(labelPage);
    check(
      'the number arrives on the tab opened before the resize',
      await activeTabName(labelPage),
      resizeNumber,
    );
    checkTrue(
      'a resize between parking and the label still leaves the active pill in view',
      afterResizeLabel !== null && afterResizeLabel.activePillVisible === true,
      JSON.stringify(afterResizeLabel),
    );
    await labelPage.close();

    /*
      A close must not reach across the app for focus it never had.

      The handoff exists because closing destroys the button that had focus and
      the browser drops the user on `<body>`. Dispatched while the user is typing
      in the invoices search box it destroys nothing they hold, so taking focus
      there pulls the caret out of a text field mid-word. The late `rAF` branch
      always guarded this; the immediate one did not.
    */
    const focusPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    focusPage.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });
    await focusPage.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    for (let index = 0; index < 3; index++) await openInvoiceFromList(focusPage, index);
    await focusPage.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    const search = focusPage.getByRole('textbox', { name: 'Search invoices' }).first();
    await search.waitFor({ timeout: 15_000 });
    await search.click();
    await search.type('typing survives close');
    const closeFirst = (await tabNames(focusPage))[0];
    await focusPage
      .getByRole('button', { name: `Close invoice ${closeFirst}`, exact: true })
      .first()
      .dispatchEvent('click');
    await focusPage.waitForTimeout(120);
    const focusEarly = await focusPage.evaluate(() => document.activeElement?.tagName ?? null);
    await focusPage.waitForTimeout(700);
    const focusLate = await focusPage.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      value: document.activeElement instanceof HTMLInputElement ? document.activeElement.value : null,
      inStrip: document.activeElement?.closest('.app-invoice-tabs') !== null,
    }));
    checkTrue(
      'a close while the user is typing leaves focus in the search box',
      focusEarly === 'INPUT' && focusLate.tag === 'INPUT' && focusLate.inStrip === false,
      `at 120ms: ${focusEarly}, at 820ms: ${JSON.stringify(focusLate)}`,
    );
    check('the caret keeps what the user had typed', focusLate.value, 'typing survives close');
    checkTrue(
      'and the tab really did close',
      !(await tabNames(focusPage)).includes(closeFirst),
      `closed: ${closeFirst}, tabs: ${JSON.stringify(await tabNames(focusPage))}`,
    );
    /*
      The other half of the same rule: when the strip *did* own the focus, closing
      with the keyboard must still hand it to the neighbour rather than `<body>`.
      Guarding the handoff must not disable it.
    */
    const keyboardTarget = (await tabNames(focusPage))[0];
    await focusPage
      .getByRole('button', { name: `Close invoice ${keyboardTarget}`, exact: true })
      .first()
      .focus();
    await focusPage.keyboard.press('Enter');
    await focusPage.waitForTimeout(700);
    const handoff = await focusPage.evaluate(() => ({
      tag: document.activeElement?.tagName ?? null,
      name: document.activeElement?.textContent?.trim() ?? null,
      inStrip: document.activeElement?.closest('.app-invoice-tabs') !== null,
    }));
    checkTrue(
      'closing from the strip still hands focus to the surviving neighbour',
      handoff.inStrip === true && handoff.tag === 'BUTTON',
      JSON.stringify(handoff),
    );
    await focusPage.close();

    // --- ten tabs, two widths: the + stays reachable -----------------------
    // The old version of this gate asserted only `scrollWidth === clientWidth`
    // and `stripRight <= bandRight`. Both held while the `+` sat 400px outside a
    // 1000px window, because the band clipped instead of the scroller scrolling.
    for (let index = 0; index < 10; index++) await openInvoiceFromList(page, index);
    check('ten invoices, ten tabs', (await tabNames(page)).length, 10);
    for (const width of [1000, 1600]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(400);
      const overflow = await shellOverflow(page);
      const band = await contentBand(page);
      const plus = await plusReach(page);
      checkTrue(
        `ten tabs do not widen the shell at ${width}px (light)`,
        overflow.scrollWidth === overflow.clientWidth,
        `scrollWidth: ${overflow.scrollWidth}, clientWidth: ${overflow.clientWidth}`,
      );
      checkTrue(
        `the strip stays inside the band at ${width}px`,
        band !== null && band.stripRight !== null && band.stripRight <= band.right + 1,
        `strip right: ${band?.stripRight}, band right: ${band?.right}`,
      );
      checkTrue(
        `the + is visible and clickable with ten tabs at ${width}px`,
        plus !== null && plus.insideViewport && plus.insideToolbar && plus.hittable,
        JSON.stringify(plus),
      );
      checkTrue(
        `the pills, not the band, absorb the overflow at ${width}px`,
        plus !== null && plus.scrollerRight <= band.right + 1,
        `scroller right: ${plus?.scrollerRight}, band right: ${band?.right}, scroller ${plus?.scrollerClientWidth}/${plus?.scrollerScrollWidth}`,
      );
    }
    await page.setViewportSize({ width: 1000, height: 960 });
    await page.waitForTimeout(400);
    const narrow = await plusReach(page);
    checkTrue(
      'ten tabs overflow *inside* the scroller, so the pills can be scrolled to',
      narrow !== null &&
        narrow.scrollerScrollWidth > narrow.scrollerClientWidth &&
        narrow.activePillVisible === true,
      JSON.stringify(narrow),
    );
    await shoot(page, 'invoice-tabs-ten-1000');

    // --- the gaps between pills are not dead pixels ------------------------
    // `no-drag` on the whole scroller covered the `gap` strips between pills,
    // which hold nothing clickable: those pixels dragged nothing and clicked
    // nothing. Scoped to the pills and the `+`, the gaps drag the window again.
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(400);
    const gap = await pillGapPoint(page);
    const gapRegion = gap === null ? null : await regionAtPoint(page, gap.x, gap.y);
    checkTrue(
      'the gap between two pills still drags the window',
      gapRegion !== null && gapRegion.region === 'drag',
      `gap point: ${JSON.stringify(gap)}, region: ${JSON.stringify(gapRegion)}`,
    );

    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(400);
    await shoot(page, 'invoice-tabs-light');

    // The band's left edge is only visible with the sidebar out of the way.
    await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();
    await page.waitForTimeout(600);
    await shoot(page, 'invoice-tabs-collapsed');
    await page.getByRole('button', { name: 'Toggle sidebar' }).first().click();
    await page.waitForTimeout(600);

    // --- dark mode ---------------------------------------------------------
    // setAppearance reloads, which is also the tab state's reset — so the tabs
    // are reopened after the switch rather than expected to survive it.
    const darkOk = await setAppearance(page, 'Dark');
    for (let index = 0; index < 3; index++) await openInvoiceFromList(page, index);
    check('three tabs open in dark mode', (await tabNames(page)).length, 3);
    const darkBand = await contentBand(page);
    checkTrue(
      'dark mode fills only the active pill, with its own ink',
      darkOk &&
        darkBand !== null &&
        darkBand.activeBackground !== darkBand.inactiveBackground &&
        darkBand.activeInk !== darkBand.inactiveInk,
      `active: ${darkBand?.activeBackground} / ${darkBand?.activeInk}, inactive: ${darkBand?.inactiveBackground} / ${darkBand?.inactiveInk}`,
    );
    for (const width of [1000, 1600]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(400);
      const overflow = await shellOverflow(page);
      checkTrue(
        `three tabs do not widen the shell at ${width}px (dark)`,
        overflow.scrollWidth === overflow.clientWidth,
        `scrollWidth: ${overflow.scrollWidth}, clientWidth: ${overflow.clientWidth}`,
      );
    }
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.waitForTimeout(400);
    if (darkOk) await shoot(page, 'invoice-tabs-dark');
    else console.log('  screenshot skipped: invoice-tabs-dark (page was not dark)');

    await setAppearance(page, 'Light');
  } catch (error) {
    fail('invoice tabs section did not complete', String(error));
  }

  // --- Search ---------------------------------------------------------------
  /*
    Pagination is gone: the list holds the whole matching set and scrolls, so
    there is no range label, no page buttons and no page-size combobox left to
    assert. What narrows the list now is the search box, the segments, and the
    filter tokens behind the `Filters` toggle — so those are what is asserted.
  */
  console.log('\nCockpit search');
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await awaitCockpit(page);
  const searchTerm = FILTER_CLIENT;
  const searchExpected = cockpitFor(
    expected.invoiceRows.filter((invoice) => invoice.clientName === searchTerm),
    expected.asOf,
  );
  await page.getByRole('textbox', { name: 'Search invoices' }).fill(searchTerm);
  await page.waitForTimeout(1200);
  check(
    'searching a client name narrows the list to that client’s invoices',
    (await rowNumbers(page)).join(','),
    searchExpected.numbers.join(','),
  );
  check(
    'the groups follow the search',
    (await groupCaptionParts(page)).map(captionLine).join(' | '),
    searchExpected.groups.map((group) => group.caption).join(' | '),
  );
  check(
    'the segment counts are recomputed over what the search matched',
    (await segmentNames(page))[0],
    `All ${searchExpected.numbers.length}`,
  );
  await page.getByRole('textbox', { name: 'Search invoices' }).fill('');
  await page.waitForTimeout(1200);
  check('clearing the search restores the whole set', await rowNumbers(page).then((r) => r.length), expected.listTotal);

  // A search that matches nothing gets the empty state, not a blank column.
  await page.getByRole('textbox', { name: 'Search invoices' }).fill('zzzz-no-such-invoice');
  await page.waitForTimeout(1200);
  check('a search that matches nothing renders no rows', await listRows(page).count(), 0);
  check(
    'and says so, with the wording that admits a filter is on',
    await page.getByText('Nothing here', { exact: true }).count(),
    1,
  );
  await page.getByRole('textbox', { name: 'Search invoices' }).fill('');
  await page.waitForTimeout(1200);

  // --- The Filters toggle and its token bar ---------------------------------
  console.log('\nFilters token bar');
  check(
    'the token bar is not mounted until it is asked for',
    await page.getByRole('combobox', { name: 'Filter invoices' }).count(),
    0,
  );
  await openFilterBar(page);
  check(
    'the Filters toggle reveals the PowerSearch bar',
    await page.getByRole('combobox', { name: 'Filter invoices' }).count(),
    1,
  );
  check('the revealed bar states the result count', await resultCount(page), expected.listTotal);
  await shoot(page, 'invoices-filters-open');
  // Shutting it again is the other half of a toggle.
  await page.getByRole('button', { name: /^Filters/ }).first().click();
  await page.waitForTimeout(400);
  check(
    'pressing Filters again puts the bar away',
    await page.getByRole('combobox', { name: 'Filter invoices' }).count(),
    0,
  );
  // --- Filter tokens --------------------------------------------------------
  console.log('\nFilter tokens');
  // Every token test needs the bar the toggle above just shut.
  await openFilterBar(page);
  const voidCount = expected.byStatus.get('void') ?? 0;
  checkTrue(
    'seed provides a status narrow enough to shrink the list',
    voidCount > 0 && voidCount < expected.listTotal,
    `void invoices in SQLite: ${voidCount}`,
  );
  const voidExpected = cockpitFor(
    expected.invoiceRows.filter((invoice) => invoice.status === 'void'),
    expected.asOf,
  );

  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Void' },
  });
  check('filtered result count matches SQLite', await resultCount(page), voidCount);
  check('filtered row count drops to the SQLite count', await listRows(page).count(), voidCount);
  check(
    'the tokens leave exactly the Void group, with its own sum',
    (await groupCaptionParts(page)).map(captionLine).join(' | '),
    voidExpected.groups.map((group) => group.caption).join(' | '),
  );
  check(
    'every remaining row is one SQLite says is void',
    (await rowNumbers(page)).join(','),
    voidExpected.numbers.join(','),
  );

  await removeFilterToken(page, 'Status: is');
  check('removing the token restores the full result count', await resultCount(page), expected.listTotal);
  check('removing the token restores every row', await listRows(page).count(), expected.listTotal);

  // Two tokens at once — the shot that has to look like the reference.
  const paidForClientExpected = cockpitFor(
    expected.invoiceRows.filter(
      (invoice) => invoice.status === 'paid' && invoice.clientName === FILTER_CLIENT,
    ),
    expected.asOf,
  );
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
  const twoTokenNumbers = await rowNumbers(page);
  const twoTokenRows = check(
    'every row matches both tokens',
    twoTokenNumbers.join(','),
    paidForClientExpected.numbers.join(','),
  );
  check(
    'the Filters toggle counts the tokens it is hiding',
    (await page.getByRole('button', { name: /^Filters/ }).first().innerText()).trim(),
    'Filters 2',
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
  check('clear all restores every row', await listRows(page).count(), expected.listTotal);
  check('clear all removes every token', await page.getByRole('button', { name: /^Remove / }).count(), 0);
  check(
    'and the toggle drops its token count',
    (await page.getByRole('button', { name: /^Filters/ }).first().innerText()).trim(),
    'Filters',
  );

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
  /*
    There is no multi-select any more, so the old contract — "changing the
    filters clears the row selection; changing page or page size does not" —
    has nothing left to describe: there is no row checkbox, no banner, and no
    page. What replaced it is a single derived selection, and its contract is
    stated in `InvoiceList.tsx`: *keep the chosen row while it is still in the
    list, fall to the top of the list when it is not.* Both halves below.
  */
  console.log('\nSelection contract');
  await forceEmptyFilterBar(page);
  await page.waitForTimeout(400);

  // (a) A row the narrowing keeps stays chosen.
  const survivorIndex = expected.cockpit.numbers.indexOf(voidExpected.numbers[0]);
  checkTrue(
    'the seed offers a row that a status filter would keep',
    survivorIndex >= 0,
    `void row ${voidExpected.numbers[0]} at cockpit index ${survivorIndex}`,
  );
  await selectRow(page, survivorIndex);
  check('contract baseline: that row is the selected one', (await selectedRow(page))?.number, voidExpected.numbers[0]);
  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Void' },
  });
  check(
    'a row the filter keeps stays the selected row',
    (await selectedRow(page))?.number,
    voidExpected.numbers[0],
  );

  // (b) A row the narrowing removes hands the selection to the top of what is
  // left, rather than leaving an invisible selection behind to reappear later.
  await removeFilterToken(page, 'Status: is');
  await page.waitForTimeout(600);
  const paidIndex = expected.cockpit.numbers.indexOf(paidForClientExpected.numbers[0]);
  await selectRow(page, paidIndex);
  check('contract baseline: a paid row is selected', (await selectedRow(page))?.number, paidForClientExpected.numbers[0]);
  await addFilterToken(page, {
    field: 'Status',
    value: { kind: 'option', label: 'Void' },
  });
  check(
    'a row the filter removes hands the selection to the top of the list',
    (await selectedRow(page))?.number,
    voidExpected.numbers[0],
  );
  check('and there is still exactly one selected row', (await selectedRow(page))?.count, 1);
  await removeFilterToken(page, 'Status: is');
  await page.waitForTimeout(600);
  await forceEmptyFilterBar(page);

  // --- The invoice editor ---------------------------------------------------
  /*
    Option 2a's three claims, in the order a reader meets them:

      1. the line table is quiet — cells are borderless and unfilled at rest, so
         ten rows read as a table rather than as thirty inputs, and only the
         cell that has focus draws itself as a control;
      2. the Add-item button is gone, replaced by a permanent trailing ghost row
         that Enter commits and Backspace-on-empty removes;
      3. the preview is a sheet of A4 in a fixed-width rail, and a pager and a
         thumbnail strip appear *only* when the document runs onto a second page
         — controls that cannot do anything being worse than no controls.

    Nothing here writes to the database: the existing invoice is only focused,
    never edited, and every keystroke goes into the unsaved `new` draft.
  */
  console.log('\nInvoice editor');
  try {
    // First, the gesture that replaced the per-row `Open` button: the row is
    // the link, and taking an invoice onto its own route is an item in the
    // pane's overflow menu.
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await awaitCockpit(page);
    // Hash navigation only remounts the route, so the selection the sections
    // above left behind is still the live one. Choose the row this section is
    // about rather than inheriting whatever the last test looked at.
    const openTarget = expected.cockpit.flat[0];
    await selectRow(page, 0);
    check('the editor section starts on the top row', (await selectedRow(page))?.number, openTarget.number);
    await page.getByRole('button', { name: 'More invoice actions' }).first().click();
    await page.waitForTimeout(500);
    // The menu's items are role-named by the design system; fall back to the
    // text so a role rename is a readable failure rather than a 30s timeout.
    const openItem = page.getByRole('menuitem', { name: 'Open in its own tab' });
    if ((await openItem.count()) > 0) await openItem.first().click();
    else await page.getByText('Open in its own tab', { exact: true }).first().click();
    await page.waitForTimeout(900);
    check(
      'the pane can take the selected invoice onto its own route',
      new URL(page.url()).hash,
      `#/invoices/${openTarget.id}`,
    );
    check('and that opens a tab for it', (await tabNames(page)).join('|'), openTarget.number);

    await page.getByRole('button', { name: 'Edit', exact: true }).first().click();
    await page.waitForTimeout(1200);
    checkTrue('Edit reaches the editor', new URL(page.url()).hash.endsWith('/edit'), `hash: ${new URL(page.url()).hash}`);

    // --- 1. The quiet table -------------------------------------------------
    const restingCells = await lineCells(page);
    checkTrue(
      'the editor renders a line table with more than one row',
      restingCells.length >= 6,
      `cells found: ${restingCells.length}`,
    );
    checkTrue(
      'every cell is borderless and unfilled at rest',
      restingCells.length > 0 && restingCells.every((cell) => !cell.isPainted && !cell.hasBorderInk),
      restingCells
        .filter((cell) => cell.isPainted || cell.hasBorderInk)
        .map((cell) => `${cell.field} line ${cell.line}: bg ${cell.background}, border ${cell.borderColor}`)
        .join(' | ') || 'no cell paints anything',
    );
    check('the old Add item button is gone', await page.getByRole('button', { name: /^Add item/ }).count(), 0);
    await shoot(page, 'editor-lines-at-rest');

    // --- Only the focused cell draws itself as a control --------------------
    await page.getByRole('textbox', { name: 'Rate, line 1' }).focus();
    await page.waitForTimeout(400);
    const focusedCells = await lineCells(page);
    const focused = focusedCells.find((cell) => cell.field === 'Rate' && cell.line === 1);
    checkTrue(
      'the focused cell grows a border and a fill',
      focused !== undefined && focused.hasBorderInk && focused.isPainted,
      `focused cell: border ${focused?.borderColor}, background ${focused?.background}`,
    );
    checkTrue(
      'and nothing else in the table does',
      focusedCells
        .filter((cell) => !(cell.field === 'Rate' && cell.line === 1))
        .every((cell) => !cell.hasBorderInk && !cell.isPainted),
      focusedCells
        .filter((cell) => !(cell.field === 'Rate' && cell.line === 1))
        .filter((cell) => cell.hasBorderInk || cell.isPainted)
        .map((cell) => `${cell.field} line ${cell.line}`)
        .join(', ') || 'no other cell paints anything',
    );
    await shoot(page, 'editor-cell-focused');

    // --- Payment terms is the input; the due date is derived ----------------
    const dueValue = async () =>
      page.evaluate(() => {
        const dashed = [...document.querySelectorAll('div')].find((element) =>
          getComputedStyle(element).borderTopStyle === 'dashed',
        );
        return dashed === undefined
          ? null
          : {
              text: (dashed.textContent ?? '').trim(),
              isInput: dashed.querySelector('input') !== null,
              borderStyle: getComputedStyle(dashed).borderTopStyle,
            };
      });
    const beforeTerms = await dueValue();
    checkTrue(
      'the due date is a derived, dashed, read-only value',
      beforeTerms !== null && beforeTerms.borderStyle === 'dashed' && !beforeTerms.isInput,
      JSON.stringify(beforeTerms),
    );
    const termsBox = page.getByRole('combobox', { name: 'Payment terms' });
    check('payment terms is the control the user drives', await termsBox.count(), 1);
    const currentTerm = (await termsBox.first().innerText()).trim();
    const nextTerm = currentTerm === 'Net 60' ? 'Net 7' : 'Net 60';
    await termsBox.first().click();
    await page.waitForTimeout(500);
    await page.getByRole('option', { name: nextTerm, exact: true }).first().click();
    await page.waitForTimeout(800);
    const afterTerms = await dueValue();
    checkTrue(
      'choosing a term recomputes the due date',
      afterTerms !== null && beforeTerms !== null && afterTerms.text !== beforeTerms.text,
      `before: ${beforeTerms?.text}, after: ${afterTerms?.text}`,
    );

    // --- The preview rail on a one-page document ----------------------------
    const singlePage = await previewRail(page);
    check('the preview rail is 470px wide', singlePage?.railWidth, 470);
    check('the sheet is locked to A4', singlePage?.aspectRatio, '210 / 297');
    checkTrue(
      'the frame really is A4-shaped and clips rather than growing',
      singlePage !== null &&
        Math.abs((singlePage.ratio ?? 0) - 210 / 297) < 0.01 &&
        singlePage.overflow === 'hidden',
      `ratio: ${singlePage?.ratio?.toFixed(4)} (A4 is ${(210 / 297).toFixed(4)}), overflow: ${singlePage?.overflow}`,
    );
    check('a one-page document offers no pager', singlePage?.hasPager, false);
    check('and no thumbnail strip', singlePage?.thumbnails, 0);
    check('and no PAGES caption', singlePage?.pagesCaption, null);
    await shoot(page, 'editor-preview-single-page');

    // --- 2. The ghost row, driven on the unsaved draft ----------------------
    await page.goto(`${APP_ORIGIN}/#/invoices/new`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { level: 1, name: 'New invoice' }).first().waitFor({ timeout: 15_000 });
    await page.waitForTimeout(700);
    const emptyGhost = await ghostRow(page);
    check('a blank editor still has one row waiting', emptyGhost?.lineCount, 1);
    check('the ghost row states what it is for', emptyGhost?.placeholder, 'Add another item…');
    check('the ghost row has no grip', emptyGhost?.hasMoveButton, false);
    check('the ghost row has no overflow menu', emptyGhost?.hasActionsButton, false);
    checkTrue(
      'the ghost row shows an em dash rather than a zero amount',
      emptyGhost?.showsEmDash === true,
      `ghost row shows an em dash: ${emptyGhost?.showsEmDash}`,
    );
    await shoot(page, 'editor-ghost-row');

    // Enter commits the row and opens the next one.
    await page.getByRole('textbox', { name: 'Description, line 1' }).fill('Brand identity system');
    await page.getByRole('textbox', { name: 'Description, line 1' }).press('Enter');
    await page.waitForTimeout(500);
    const afterEnter = await ghostRow(page);
    check('Enter commits the row and opens a fresh ghost below it', afterEnter?.lineCount, 2);
    check('the new last row is the ghost', afterEnter?.placeholder, 'Add another item…');
    check('the committed row above it keeps its grip', afterEnter?.previousHasMove, true);

    // Backspace on an empty row takes it away again.
    await page.getByRole('textbox', { name: 'Description, line 2' }).fill('Motion guidelines');
    await page.getByRole('textbox', { name: 'Description, line 2' }).press('Enter');
    await page.waitForTimeout(500);
    check('a second committed row leaves three in all', (await ghostRow(page))?.lineCount, 3);
    await page.getByRole('textbox', { name: 'Description, line 2' }).fill('');
    await page.getByRole('textbox', { name: 'Description, line 2' }).press('Backspace');
    await page.waitForTimeout(500);
    check('Backspace on an emptied row removes it', (await ghostRow(page))?.lineCount, 2);
    check('and the ghost row survives the removal', (await ghostRow(page))?.placeholder, 'Add another item…');

    // --- 3. A document that runs onto a second page -------------------------
    // No seeded invoice can do this: every one of the 66 carries two or three
    // line items (`preview/seed.ts` generates `2 + floor(random() * 2)`), and
    // the fold is measured off the sheet's own layout height rather than a row
    // budget. So the rows are typed in, on the draft that is never saved.
    const typed = await fillUntilTwoPages(page);
    checkTrue(
      'typing rows into the ghost row eventually spills onto a second page',
      typed !== null,
      typed === null ? 'no pager after 40 committed rows' : `pager appeared after ${typed} committed rows`,
    );
    const multiPage = await previewRail(page);
    check('the pager reads page one of two', multiPage?.pageLabel, '1 / 2');
    check('the thumbnail strip has one thumbnail per page', multiPage?.thumbnails, 2);
    check('the strip captions the page count', multiPage?.pagesCaption, 'PAGES · 2');
    check('Previous is disabled on the first page', multiPage?.previousDisabled, true);
    check('Next is available on the first page', multiPage?.nextDisabled, false);
    check('the sheet is still exactly one A4 frame', multiPage?.aspectRatio, '210 / 297');
    check('and the rail has not grown to fit the extra page', multiPage?.railWidth, 470);
    await shoot(page, 'editor-multipage-pager');

    await page.getByRole('button', { name: 'Next page' }).click();
    await page.waitForTimeout(500);
    const secondPage = await previewRail(page);
    check('Next turns the sheet to page two', secondPage?.pageLabel, '2 / 2');
    check('Next is disabled on the last page', secondPage?.nextDisabled, true);
    check('Previous is available on the last page', secondPage?.previousDisabled, false);
    await shoot(page, 'editor-multipage-second');
    // A thumbnail's activation control is `ClickableCard`'s visually-hidden
    // button — real to the keyboard and to assistive tech, zero-sized to a
    // mouse — so it is activated rather than clicked at a coordinate.
    await page.getByRole('button', { name: 'Show page 1' }).dispatchEvent('click');
    await page.waitForTimeout(600);
    check('a thumbnail turns the sheet back', (await previewRail(page))?.pageLabel, '1 / 2');

    // The draft is never saved: leaving it is the whole cleanup.
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await awaitCockpit(page);
    check(
      'nothing typed into the draft reached the database',
      await listRows(page).count(),
      expected.listTotal,
    );

    // --- The editor in dark mode -------------------------------------------
    const editorDark = await setAppearance(page, 'Dark', `#/invoices/${tabFixtures[0].id}/edit`);
    await page.getByRole('textbox', { name: 'Description, line 1' }).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(800);
    const darkCells = await lineCells(page);
    checkTrue(
      'the table stays quiet in dark mode',
      editorDark && darkCells.length > 0 && darkCells.every((cell) => !cell.isPainted && !cell.hasBorderInk),
      darkCells
        .filter((cell) => cell.isPainted || cell.hasBorderInk)
        .map((cell) => `${cell.field} line ${cell.line}`)
        .join(', ') || 'no cell paints anything',
    );
    // The sheet is the one thing that must *not* follow the theme: it is paper.
    const paperInk = await page.evaluate(() => {
      const frame = [...document.querySelectorAll('*')].find(
        (element) => getComputedStyle(element).aspectRatio === '210 / 297',
      );
      if (frame === undefined) return null;
      const sheet = frame.firstElementChild?.firstElementChild ?? frame.firstElementChild;
      const styles = getComputedStyle(sheet);
      const parts = (styles.backgroundColor.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
      return {
        background: styles.backgroundColor,
        colorScheme: styles.colorScheme,
        isLight: parts.length === 3 && (parts[0] + parts[1] + parts[2]) / 3 > 200,
      };
    });
    checkTrue(
      'the preview stays light paper in dark mode',
      paperInk !== null && paperInk.isLight,
      `sheet background: ${paperInk?.background}, color-scheme: ${paperInk?.colorScheme}`,
    );
    if (editorDark) await shoot(page, 'editor-dark');
    else console.log('  screenshot skipped: editor-dark (page was not dark)');
    await setAppearance(page, 'Light');
    await awaitCockpit(page);
  } catch (error) {
    fail('invoice editor section did not complete', String(error));
  }

  // --- Navigation ----------------------------------------------------------
  console.log('\nNavigation');
  // The Invoices row carries the open count as end content, and that count is
  // part of the link's accessible name ("Invoices 20"), so it is the one target
  // matched by prefix rather than exactly.
  const navTargets = [
    { label: 'Clients', name: 'Clients', route: '/clients', heading: 'Clients' },
    { label: 'Reports', name: 'Reports', route: '/reports', heading: 'Reports' },
    { label: 'Models', name: 'Models', route: '/models', heading: 'Models' },
    { label: 'Assistant', name: 'Assistant', route: '/assistant', heading: 'Assistant' },
    { label: 'Settings', name: 'Settings', route: '/settings', heading: 'Settings' },
    { label: 'Invoices', name: /^Invoices/, route: '/invoices', heading: 'Invoices' },
  ];
  for (const target of navTargets) {
    await page
      .getByRole('navigation', { name: 'Side navigation' })
      .getByRole('link', typeof target.name === 'string' ? { name: target.name, exact: true } : { name: target.name })
      .click();
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
  await awaitCockpit(page);
  // The theme mode is persisted in the database, so a previous run may have
  // left it dark. Start from a known light baseline. Set from Settings, which
  // is the only place the three-way control lives now, and land back here.
  const lightSettled = await setAppearance(page, 'Light');
  await awaitCockpit(page);
  const lightColors = await paintedColors(page);
  checkTrue(
    'light baseline paints body and app surface light',
    lightSettled,
    `body: ${lightColors.body}, surface: ${lightColors.surface}`,
  );

  const darkSettled = await setAppearance(page, 'Dark');
  await awaitCockpit(page);
  const darkColors = await paintedColors(page);
  const repaintOk = checkTrue(
    'dark mode repaints body and app surface, not just body',
    darkSettled && darkColors.body !== lightColors.body && darkColors.surface !== lightColors.surface,
    `light: body ${lightColors.body} / surface ${lightColors.surface}\n        dark:  body ${darkColors.body} / surface ${darkColors.surface}`,
  );
  const rowsOk = check('dark mode keeps the whole list rendered', await listRows(page).count(), expected.listTotal);
  check(
    'dark mode keeps the group captions and their sums',
    (await groupCaptionParts(page)).map(captionLine).join(' | '),
    expected.cockpit.groups.map((group) => group.caption).join(' | '),
  );
  check('dark mode keeps a row selected', (await selectedRow(page))?.count, 1);
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

  await setAppearance(page, 'Light');

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
