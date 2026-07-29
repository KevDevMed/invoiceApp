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
 * The sidebar's top-row chrome, measured off the real DOM.
 *
 * Everything here is geometry and identity, so it is read in one pass:
 *
 *   dots       one entry per `.app-window-control-dot`, in DOM order, with the
 *              painted colour, the box, whether it is inside the sidebar's
 *              drag-region band, and whether it could take focus or a tooltip
 *   band       the title band's own box, drag region and aria-hidden state
 *   bandButtons  the buttons *inside* the band, in DOM order, by accessible
 *              name, with the computed `-webkit-app-region` each one resolves to
 *   controls   every one of the three chrome controls wherever it is, so the
 *              collapsed layout can be checked against the light band
 *   footer     the interactive elements in the panel's foot — the nearest
 *              ancestor of the Settings link that is a direct child of the panel
 *   rail       the panel's box and its scroll overflow
 *
 * `.app-side-nav` and `.app-window-control-dot` are app-owned class names (the
 * shell sets them); everything else is found by role, name or structure.
 */
async function sideNavChrome(page) {
  return page.evaluate(() => {
    const nav = document.querySelector('.app-side-nav');
    if (!nav) return null;
    const box = (element) => {
      const rect = element.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
    };
    const band = nav.querySelector('.app-drag-region');
    const cluster = nav.querySelector('.app-window-controls');

    const dots = [...nav.querySelectorAll('.app-window-control-dot')].map((dot) => ({
      color: getComputedStyle(dot).backgroundColor,
      appRegion: getComputedStyle(dot).webkitAppRegion,
      inBand: band !== null && band.contains(dot),
      focusable: dot.matches('a, button, input, select, textarea, [tabindex], [role="button"], [role="link"]'),
      hasTitle: dot.hasAttribute('title'),
      ...box(dot),
    }));

    const buttonName = (element) => element.getAttribute('aria-label') ?? element.textContent?.trim() ?? '';
    const bandButtons =
      band === null
        ? []
        : [...band.querySelectorAll('button')].map((button) => ({
            name: buttonName(button),
            appRegion: getComputedStyle(button).webkitAppRegion,
            ...box(button),
          }));

    const controls = [...nav.querySelectorAll('button')].map((button) => ({
      name: buttonName(button),
      inBand: band !== null && band.contains(button),
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
      band:
        band === null
          ? null
          : { appRegion: getComputedStyle(band).webkitAppRegion, ariaHidden: band.getAttribute('aria-hidden'), ...box(band) },
      bandButtons,
      controls,
      footer,
      rail: { ...box(nav), scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth },
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

/** Opens the nth invoice on the first page of the list. Returns its hash. */
async function openInvoiceFromList(page, index) {
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByRole('button', { name: 'Open', exact: true }).nth(index).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Open', exact: true }).nth(index).click();
  await page.waitForTimeout(700);
  return new URL(page.url()).hash;
}

/** The shell's own inline overflow: many tabs must not widen the window. */
async function shellOverflow(page) {
  return page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
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
  //
  // Measured at 1600, not at the run's default 1440. The sidebar is an inset
  // panel (see AppShell's `sideNavPanel`), so the shell consumes its own width
  // plus margins and at 1440 the invoices content region lands on exactly the
  // 1120 cap — gutters of zero, which says nothing either way about centring.
  // 1600 puts the region clear of the cap again, so "the cap bites" is a real
  // assertion rather than a boundary coincidence.
  console.log('\nContent column centring');
  const CENTRE_TOLERANCE = 2;
  await page.setViewportSize({ width: 1600, height: 960 });
  const wide = await contentColumnGutters(page);
  const wideCentred = checkTrue(
    'invoices column is centred at 1600 wide',
    wide !== null && Math.abs(wide.left - wide.right) <= CENTRE_TOLERANCE,
    gutterDetail(wide),
  );
  checkTrue(
    'invoices column cap actually bites at 1600 wide',
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
    'settings column (cap 860) is centred at 1600 wide',
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
  // The scroll region owns `overflow: auto`, so it can scroll sideways while the
  // document's width never changes. That is the regression this guards, so it is
  // measured on the region; the document is asserted separately below.
  checkTrue(
    'scroll region does not overflow sideways at 900 wide',
    narrow !== null && narrow.regionScrollWidth <= narrow.regionClientWidth + CENTRE_TOLERANCE,
    narrow === null
      ? 'not measured'
      : `region scrollWidth: ${narrow.regionScrollWidth.toFixed(1)}, clientWidth: ${narrow.regionClientWidth.toFixed(1)}`,
  );
  checkTrue(
    'document does not overflow the viewport at 900 wide',
    narrow !== null && narrow.documentScrollWidth <= narrow.viewportWidth + CENTRE_TOLERANCE,
    narrow === null
      ? 'not measured'
      : `document scrollWidth: ${narrow.documentScrollWidth.toFixed(1)}, viewport: ${narrow.viewportWidth.toFixed(1)}`,
  );

  // Back to the viewport and the page the rest of the run expects.
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

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
      const toggleBox = await toggle.first().boundingBox();
      const brandBox = await page.getByText('InvoiceApp', { exact: true }).first().boundingBox();
      checkTrue(
        'toggle sits above the InvoiceApp brand row',
        toggleBox !== null && brandBox !== null && toggleBox.y + toggleBox.height <= brandBox.y,
        `toggle bottom: ${toggleBox === null ? 'not measured' : (toggleBox.y + toggleBox.height).toFixed(1)}, ` +
          `brand top: ${brandBox === null ? 'not measured' : brandBox.y.toFixed(1)}`,
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
      await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
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
      await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
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
    await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
  } catch (error) {
    fail('sidebar pill panel section did not complete', String(error));
  }

  // --- Sidebar top-row chrome ----------------------------------------------
  // The band at the head of the panel: three traffic-light placeholders at its
  // start (web only — macOS paints real ones and this build must mirror their
  // geometry, not draw over them), and the update / appearance / panel-toggle
  // glyphs at its end. Collapsed, the same three controls move *below* the
  // reserved light band, because an 88px rail has no room beside the lights.
  console.log('\nSidebar top-row chrome');
  try {
    await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
    await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

    const expandedChrome = await sideNavChrome(page);
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
      dots.length === 3 && dots.every((dot) => dot.inBand),
      `in band: ${dots.map((dot) => dot.inBand).join(',')}`,
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
      expandedChrome?.band?.appRegion === 'drag' && dots.every((dot) => dot.appRegion === 'none'),
      `band: ${expandedChrome?.band?.appRegion}, dots: ${dots.map((dot) => dot.appRegion).join(',')}`,
    );

    // Expanded: all three controls in the band, in this DOM order, and every one
    // of them opted out of the drag region or it would stop receiving clicks.
    const bandNames = (expandedChrome?.bandButtons ?? []).map((button) => button.name);
    checkTrue(
      'expanded band holds update, appearance and panel toggle in that order',
      bandNames.length === 3 &&
        /update/i.test(bandNames[0]) &&
        /^Switch to (dark|light) theme$/.test(bandNames[1]) &&
        bandNames[2] === 'Toggle sidebar',
      `band buttons: ${JSON.stringify(bandNames)}`,
    );
    checkTrue(
      'every band control opts out of the drag region',
      (expandedChrome?.bandButtons ?? []).length === 3 &&
        expandedChrome.bandButtons.every((button) => button.appRegion === 'no-drag'),
      (expandedChrome?.bandButtons ?? []).map((button) => `${button.name}: ${button.appRegion}`).join(', '),
    );
    // ...and the panel's foot is back to one nav link and nothing else.
    checkTrue(
      'panel foot holds the Settings link and nothing else interactive',
      expandedChrome?.footer?.length === 1 &&
        expandedChrome.footer[0].name === 'Settings' &&
        expandedChrome.footer[0].tag === 'a',
      JSON.stringify(expandedChrome?.footer),
    );

    // Collapsed: 88px rail, lights own x 13-70 of it, so the controls go under
    // the band. All three still present, none of them overlapping a dot.
    const collapseToggle = page.getByRole('button', { name: 'Toggle sidebar' });
    await collapseToggle.first().click();
    await page.waitForTimeout(600);
    const collapsedChrome = await sideNavChrome(page);
    const collapsedControls = collapsedChrome?.controls ?? [];
    const named = (pattern) => collapsedControls.filter((control) => pattern.test(control.name));
    checkTrue(
      'collapsed rail keeps all three controls',
      named(/update/i).length === 1 &&
        named(/^Switch to (dark|light) theme$/).length === 1 &&
        named(/^Toggle sidebar$/).length === 1,
      collapsedControls.map((control) => control.name).join(', ') || 'no controls found',
    );
    const bandBottom = collapsedChrome?.band?.bottom ?? Number.NaN;
    checkTrue(
      'collapsed controls sit below the reserved light band',
      collapsedControls.length > 0 && collapsedControls.every((control) => control.top > bandBottom),
      `band bottom: ${bandBottom}, control tops: ${collapsedControls.map((control) => control.top.toFixed(1)).join(',')}`,
    );
    const collapsedDots = collapsedChrome?.dots ?? [];
    const overlaps = (a, b) =>
      a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
    checkTrue(
      'no collapsed control overlaps the placeholder cluster',
      collapsedDots.length === 3 &&
        collapsedControls.every((control) => collapsedDots.every((dot) => !overlaps(control, dot))),
      `dots y: ${collapsedDots.map((dot) => `${dot.top}-${dot.bottom}`).join(',')}, controls y: ${collapsedControls
        .map((control) => `${control.top}-${control.bottom}`)
        .join(',')}`,
    );
    // The rail may not widen past 88px + the panel's 8px inset, and it may not
    // grow a horizontal scroll range doing it.
    checkTrue(
      'collapsed rail ends within 96px of the window edge',
      (collapsedChrome?.rail.right ?? Number.NaN) <= 96,
      `rail: ${collapsedChrome?.rail.left.toFixed(1)} to ${collapsedChrome?.rail.right.toFixed(1)}`,
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
    await collapseToggle.first().click();
    await page.waitForTimeout(600);
    await shoot(page, 'sidebar-chrome-expanded-light');

    // Both modes, both states — the dots and the glyphs have to read on the
    // panel's head in dark mode too.
    await setAppearance(page, 'Dark');
    await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
    const darkChrome = await sideNavChrome(page);
    checkTrue(
      'placeholders keep the macOS palette in dark mode',
      (darkChrome?.dots ?? []).map((dot) => dot.color).join(' ') ===
        'rgb(255, 95, 87) rgb(254, 188, 46) rgb(40, 200, 64)',
      (darkChrome?.dots ?? []).map((dot) => dot.color).join(' '),
    );
    await shoot(page, 'sidebar-chrome-expanded-dark');
    await collapseToggle.first().click();
    await page.waitForTimeout(600);
    const darkCollapsed = await sideNavChrome(page);
    checkTrue(
      'collapsed dark rail still ends within 96px and does not scroll sideways',
      (darkCollapsed?.rail.right ?? Number.NaN) <= 96 &&
        darkCollapsed?.rail.scrollWidth === darkCollapsed?.rail.clientWidth,
      `rail right: ${darkCollapsed?.rail.right}, scrollWidth: ${darkCollapsed?.rail.scrollWidth}, clientWidth: ${darkCollapsed?.rail.clientWidth}`,
    );
    await shoot(page, 'sidebar-chrome-collapsed-dark');
    await collapseToggle.first().click();
    await page.waitForTimeout(600);
    await setAppearance(page, 'Light');
    await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });

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
    const firstNumber = expected.numbersInOrder[0];
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
    const secondNumber = expected.numbersInOrder[1];
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
    checkTrue(
      'the pills are inside the band and start level with the page below',
      twoTabs !== null &&
        twoTabs.pillLeft !== null &&
        twoTabs.pageHeadingLeft !== null &&
        Math.abs(twoTabs.pillLeft - twoTabs.pageHeadingLeft) <= 2,
      `pill left: ${twoTabs?.pillLeft}, h1 left: ${twoTabs?.pageHeadingLeft}`,
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

    // --- six tabs, two widths, no horizontal scrollbar --------------------
    for (let index = 2; index < 6; index++) await openInvoiceFromList(page, index);
    check('six invoices, six tabs', (await tabNames(page)).length, 6);
    for (const width of [1000, 1600]) {
      await page.setViewportSize({ width, height: 960 });
      await page.waitForTimeout(400);
      const overflow = await shellOverflow(page);
      const band = await contentBand(page);
      checkTrue(
        `six tabs do not widen the shell at ${width}px (light)`,
        overflow.scrollWidth === overflow.clientWidth,
        `scrollWidth: ${overflow.scrollWidth}, clientWidth: ${overflow.clientWidth}`,
      );
      checkTrue(
        `the strip stays inside the band at ${width}px`,
        band !== null && band.stripRight !== null && band.stripRight <= band.right + 1,
        `strip right: ${band?.stripRight}, band right: ${band?.right}`,
      );
    }

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

  // --- Pagination ----------------------------------------------------------
  console.log('\nPagination');
  await page.goto(`${APP_ORIGIN}/#/invoices`, { waitUntil: 'networkidle' });
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
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
  // left it dark. Start from a known light baseline. Set from Settings, which
  // is the only place the three-way control lives now, and land back here.
  const lightSettled = await setAppearance(page, 'Light');
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
  const lightColors = await paintedColors(page);
  checkTrue(
    'light baseline paints body and app surface light',
    lightSettled,
    `body: ${lightColors.body}, surface: ${lightColors.surface}`,
  );

  const darkSettled = await setAppearance(page, 'Dark');
  await page.getByText(expected.numbersInOrder[0], { exact: true }).first().waitFor({ timeout: 15_000 });
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
