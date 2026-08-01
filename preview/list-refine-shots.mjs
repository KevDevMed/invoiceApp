/**
 * Drives the refined invoice list in a real browser: tiles, the currency pager,
 * every column menu, an ellipsis filter end to end, chip add/dedupe/remove/
 * clear, and keyboard operation of a menu.
 *
 *   PREVIEW_PORT=4321 PREVIEW_ORIGIN=http://127.0.0.1:4321 npm run preview:serve
 *   PREVIEW_ORIGIN=http://127.0.0.1:4321 node preview/list-refine-shots.mjs
 *
 * Screenshots land in `preview/.artifacts/list-refine/`. The app is at `/app`;
 * `/` is the marketing landing page.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(HERE, '.artifacts/list-refine');
const ORIGIN = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:4300';

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${JSON.stringify(actual)}${ok ? '' : ` != ${JSON.stringify(expected)}`}`);
}
function assert(name, condition, detail = '') {
  if (!condition) failures += 1;
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${name}${detail === '' ? '' : ` — ${detail}`}`);
}

const shot = async (page, name) => {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: false });
};

mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.on('pageerror', (error) => {
  failures += 1;
  console.log(`FAIL pageerror: ${error.message}`);
});

await page.goto(`${ORIGIN}/app#/invoices`, { waitUntil: 'networkidle' });
await page.getByRole('heading', { name: 'Invoices', level: 1 }).waitFor({ timeout: 20_000 });
await page.getByRole('group', { name: 'Invoice columns' }).waitFor({ timeout: 20_000 });
await shot(page, '01-list');

// The header strip no longer claims to be a table it is not the body of.
check('no synthetic table anywhere in the list', await page.getByRole('table').count(), 0);
check('and no orphaned aria-sort', await page.locator('[aria-sort]').count(), 0);

// --- subtitle -------------------------------------------------------------
const subtitle = (await page.locator('h1:has-text("Invoices") + *').first().innerText()).trim();
console.log(`subtitle: ${subtitle}`);
assert('subtitle leads with the chasing count', /^\d+ invoices? needs? chasing today/.test(subtitle), subtitle);
assert('subtitle never claims USD equivalence', !subtitle.includes('equiv'), subtitle);

// --- tiles ----------------------------------------------------------------
/** The card a tile's filter button sits inside. The button is not the card. */
const tileCard = (label) =>
  page.getByRole('button', { name: `Filter by ${label}` }).locator('xpath=..');

const tileTemplate = await tileCard('Outstanding').evaluate(
  (el) => getComputedStyle(el.parentElement).gridTemplateColumns,
);
console.log(`tile grid: ${tileTemplate}`);
assert('tile grid has four unequal tracks', tileTemplate.split(' ').length === 4, tileTemplate);
const [t1, t2, t3, t4] = tileTemplate.split(' ').map(parseFloat);
assert('Outstanding is the widest track', t1 > t2 && t2 > t3, tileTemplate);
assert('the last two tracks are equal', Math.abs(t3 - t4) < 1.5, tileTemplate);

const chase = page.getByRole('button', { name: /^Chase all \d+$/ });
assert('Overdue tile carries Chase all N', (await chase.count()) === 1);
console.log(`chase button: ${await chase.innerText()}`);

// No interactive control is nested inside another one. `Chase all N` and the
// currency pager are siblings of the tile's filter button, not descendants of
// it, and no tile is a `role="button"` container any more.
const nestedControls = await page.evaluate(() => {
  const isControl = (el) =>
    el.tagName === 'BUTTON' ||
    el.tagName === 'A' ||
    el.tagName === 'INPUT' ||
    ['button', 'link', 'checkbox', 'menuitem', 'menuitemradio'].includes(
      el.getAttribute('role') ?? '',
    );
  return [...document.querySelectorAll('*')]
    .filter(isControl)
    .filter((el) => el.parentElement?.closest('button, [role="button"]') != null)
    .map((el) => `${el.tagName}[${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? ''}]`)
    .slice(0, 8);
});
check('no interactive control nested inside another', nestedControls, []);
check(
  'Chase all N is a sibling of the filter button, not a child',
  await chase.evaluate((el) => el.parentElement.closest('button') === null),
  true,
);

// --- the whole card is the hit area, and the controls on it still win ------
// Dropping `role="button"` from the card fixed the nested-control defect and
// left the header count, the sub-line and the proportion bar inert — a card
// that looks like one target and answers on a third of itself. The card now
// carries one stretched hit area belonging to its filter button; the Chase
// button and the pager sit above it. `elementFromPoint` is the direct test of
// that z-order, and a real click is the test of what it does.

/** Which button, if any, would actually receive a click at this element's centre. */
const topmostButtonAt = async (locator) => {
  const box = await locator.boundingBox();
  if (box === null) return 'no box';
  return page.evaluate(
    ({ x, y }) => {
      const el = document.elementFromPoint(x, y);
      if (el === null) return 'nothing';
      const owner = el.closest('button');
      if (owner === null) return `${el.tagName} (no button)`;
      return owner.getAttribute('aria-label') ?? owner.textContent?.trim() ?? '';
    },
    { x: box.x + box.width / 2, y: box.y + box.height / 2 },
  );
};

/**
 * A direct child of a tile card, by position. The card's children are, in
 * order: the filter button (which carries the overlay), the top-right slot,
 * then the sub-line — or, on Outstanding, the currency bar in the sub-line's
 * place.
 */
const cardRegion = (label, index) => tileCard(label).locator('> *').nth(index);

const clearAllIfPresent = async () => {
  const clearAll = page.getByRole('button', { name: 'Clear all' });
  if ((await clearAll.count()) > 0) await clearAll.click();
};

// The regions that were inert. Each must hand its click to the tile's filter.
const INERT_REGIONS = [
  ['Drafts header count', 'Drafts', 1, 'Filter by Drafts', 'STATUS: Drafts'],
  ['Drafts sub-line', 'Drafts', 2, 'Filter by Drafts', 'STATUS: Drafts'],
  ['Due in 7 days sub-line', 'Due in 7 days', 2, 'Filter by Due in 7 days', 'STATUS: Due in 7 days'],
];
for (const [name, label, index, owner, chipText] of INERT_REGIONS) {
  await clearAllIfPresent();
  const region = cardRegion(label, index);
  console.log(`${name}: "${(await region.innerText()).replace(/\s+/g, ' ').trim()}"`);
  check(`${name} is covered by the tile's filter button`, await topmostButtonAt(region), owner);
  const box = await region.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('group', { name: 'Active column filters' }).waitFor({ timeout: 5000 });
  check(
    `clicking ${name} applies the tile's filter`,
    (await page.getByRole('group', { name: 'Active column filters' }).innerText()).includes(chipText),
    true,
  );
  await clearAllIfPresent();
}

// The Outstanding tile's proportion bar sits *inside* the currency bar block,
// above the pager. It is decoration and must pass its click through too.
const proportionBar = cardRegion('Outstanding', 2).locator('> *').nth(0);
check(
  'the proportion bar is covered by the Outstanding filter button',
  await topmostButtonAt(proportionBar),
  'Filter by Outstanding',
);
{
  const box = await proportionBar.boundingBox();
  console.log(`proportion bar box: ${JSON.stringify(box)}`);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.getByRole('group', { name: 'Active column filters' }).waitFor({ timeout: 5000 });
  check(
    'clicking the proportion bar applies the Outstanding filter',
    (await page.getByRole('group', { name: 'Active column filters' }).innerText()).includes('STATUS: Open · unpaid'),
    true,
  );
  await clearAllIfPresent();
}
await shot(page, '16-whole-card-hit-area');

// And the three real controls on those cards are NOT covered: they are above
// the overlay and receive their own clicks first.
check('Chase all N receives its own clicks', await topmostButtonAt(chase), await chase.innerText());
check(
  'the back arrow receives its own clicks',
  await topmostButtonAt(page.getByRole('button', { name: 'Previous currencies' })),
  'Previous currencies',
);
check(
  'the forward arrow receives its own clicks',
  await topmostButtonAt(page.getByRole('button', { name: 'More currencies' })),
  'More currencies',
);

const overdueTile = tileCard('Overdue');
const overdueLines = (await overdueTile.innerText()).split('\n').map((line) => line.trim());
console.log(`overdue tile:\n${overdueLines.map((line) => `    ${line}`).join('\n')}`);
const overdueSubline = overdueLines.find((line) => /invoices? · /.test(line)) ?? '';
console.log(`overdue subline: ${overdueSubline}`);
assert('overdue subline carries three facts', overdueSubline.split(' · ').length === 3, overdueSubline);
assert('overdue subline claims no reminders', !/reminder/i.test(overdueSubline), overdueSubline);

for (const label of ['Due in 7 days', 'Drafts']) {
  const text = (await tileCard(label).innerText()).trim();
  console.log(`${label} tile:\n${text.split('\n').map((line) => `    ${line}`).join('\n')}`);
}

// --- currency pager -------------------------------------------------------
const pager = page.getByRole('group', { name: 'Outstanding by currency' });
assert('Outstanding carries the currency pager', (await pager.count()) === 1);
const codes = async () => (await pager.innerText()).trim().split(/\s+/).filter((part) => /^[A-Z]{3}$/.test(part));
const prev = pager.getByRole('button', { name: 'Previous currencies' });
const next = pager.getByRole('button', { name: 'More currencies' });

check('pager shows three codes', (await codes()).length, 3);
const page1 = await codes();
console.log(`pager page 1: ${page1.join(' ')}`);
check('prev is disabled at the left edge', await prev.isDisabled(), true);
await next.click();
const page2 = await codes();
console.log(`pager page 2: ${page2.join(' ')}`);
// The seed carries four currencies, so a whole-page step of 3 from index 0
// clamps to index 1 — the window stays full rather than showing one entry.
assert('next moves the window', page2.join(' ') !== page1.join(' '), `${page1} -> ${page2}`);
check('the window stays full after stepping', page2.length, 3);
check('prev is live once moved', await prev.isDisabled(), false);
// Walk to the end and confirm it clamps.
for (let i = 0; i < 8; i += 1) if (!(await next.isDisabled())) await next.click();
const last = await codes();
console.log(`pager last page: ${last.join(' ')}`);
check('next is disabled at the right edge', await next.isDisabled(), true);
check('the window stays full at the end', last.length, 3);
await shot(page, '02-pager-end');
// A pager click must not have applied the tile's own filter.
check('paging did not apply the tile filter', await page.getByRole('group', { name: 'Active column filters' }).count(), 0);
for (let i = 0; i < 8; i += 1) if (!(await prev.isDisabled())) await prev.click();
check('prev clamps at zero', await prev.isDisabled(), true);
check('and the first window is back', (await codes()).join(' '), page1.join(' '));

// --- every column menu ----------------------------------------------------
const HEADERS = ['CLIENT', 'INVOICE', 'STATUS & DUE', 'ISSUED', 'TOTAL'];
// The sort state rides in each header button's accessible name now that the
// synthetic table (and its `aria-sort`) is gone, so the locator matches either
// half of it.
const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const header = (label) =>
  page.getByRole('button', { name: new RegExp(`^${escapeRe(label)}, (sorted .+|not sorted)$`) });
/** A header's announced sort state: `sorted Largest first` / `not sorted`. */
const headerState = async (label) => {
  const name = await header(label).evaluate(
    (el) => el.getAttribute('aria-label') ?? el.textContent?.trim() ?? '',
  );
  return name.startsWith(`${label}, `) ? name.slice(label.length + 2) : name;
};

for (const label of HEADERS) {
  await header(label).click();
  const menu = page.getByRole('menu', { name: `${label} sort and filter` });
  await menu.waitFor({ timeout: 5000 });
  const options = (await menu.innerText()).trim().split('\n').map((line) => line.trim()).filter(Boolean);
  console.log(`menu ${label}: ${options.join(' | ')}`);
  assert(`${label} menu has SORT and FILTER sections`, options.includes('SORT') && options.includes('FILTER'), label);
  check(`${label} header reports expanded`, await header(label).getAttribute('aria-expanded'), 'true');
  // Opening one closes any other.
  check(`only one menu is open with ${label}`, await page.getByRole('menu').count(), 1);
  await page.keyboard.press('Escape');
  await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
  check(`${label} returns focus to its header`, await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''), (await header(label).innerText()).trim());
}

// Menu edge alignment: a right-aligned column anchors right.
for (const [label, expected] of [['CLIENT', 'start'], ['TOTAL', 'end']]) {
  await header(label).click();
  const menu = page.getByRole('menu', { name: `${label} sort and filter` });
  const box = await menu.boundingBox();
  const cell = await header(label).evaluateHandle((el) => el.parentElement);
  const cellBox = await cell.asElement().boundingBox();
  const anchoredLeft = Math.abs(box.x - cellBox.x) < 2;
  const anchoredRight = Math.abs(box.x + box.width - (cellBox.x + cellBox.width)) < 2;
  assert(`${label} menu anchors ${expected}`, expected === 'start' ? anchoredLeft : anchoredRight,
    `menu ${box.x}..${box.x + box.width} vs cell ${cellBox.x}..${cellBox.x + cellBox.width}`);
  if (label === 'TOTAL') await shot(page, '03-menu-total-right-anchored');
  await page.keyboard.press('Escape');
}

// A document click closes the open menu.
await header('CLIENT').click();
check('menu is open before the document click', await page.getByRole('menu').count(), 1);
await page.getByRole('heading', { name: 'Invoices', level: 1 }).click();
check('a document click closes it', await page.getByRole('menu').count(), 0);

// --- sorting from a header ------------------------------------------------
const pillBox = page.getByRole('status').filter({ hasText: 'Sorted:' });
const pill = async () => (await pillBox.innerText()).replace(/\s+/g, ' ').trim();
check('exactly one sort read-out on the page', await pillBox.count(), 1);
console.log(`pill at rest: ${await pill()}`);
check('pill starts on the default order', await pill(), 'Sorted: Due date');
check('STATUS & DUE announces its order', await headerState('STATUS & DUE'), 'sorted Most overdue first');
check('an inactive header says so', await headerState('TOTAL'), 'not sorted');

await header('TOTAL').click();
await page.getByRole('menuitemradio', { name: 'Largest first' }).click();
check('pill follows the header sort', await pill(), 'Sorted: Total');
check('TOTAL announces the order it set', await headerState('TOTAL'), 'sorted Largest first');
check('and STATUS & DUE stops claiming one', await headerState('STATUS & DUE'), 'not sorted');
const sortedHeaders = [];
for (const label of HEADERS) if ((await headerState(label)).startsWith('sorted ')) sortedHeaders.push(label);
check('exactly one header is announced as sorted', sortedHeaders, ['TOTAL']);
const footer = (await page.getByText(/^Showing .* sorted by /).first().innerText()).trim();
console.log(`footer: ${footer}`);
check('the caption names the real order', footer.includes('sorted by total, largest first'), true);
// The arrow agrees with the label: largest first means the top row is the biggest.
const amounts = await page.locator('[role="link"]').evaluateAll((rows) =>
  rows.slice(0, 3).map((row) => Number((row.getAttribute('aria-label') ?? '').split(', ').at(-1).replace(/[^\d.]/g, ''))),
);
console.log(`top three totals: ${amounts.join(', ')}`);
assert('Largest first really puts the largest first', amounts[0] >= amounts[1] && amounts[1] >= amounts[2], amounts.join(' '));
await shot(page, '04-sorted-total-desc');

await header('STATUS & DUE').click();
await page.getByRole('menuitemradio', { name: 'Most overdue first' }).click();
check('back to the due-date order', await pill(), 'Sorted: Due date');

// --- "Most overdue first" really leads with the most overdue invoice --------
// The Tier 2 defect: a draft sorted above a 319-day-late invoice because drafts
// counted as unsettled and then ordered by their raw placeholder due date. The
// assertion is the *identity* of the top row, not that the list sorted at all.
const statusCells = async (n) =>
  page.locator('[role="link"]').evaluateAll(
    (rows, count) =>
      rows
        .slice(0, count)
        .map((row) => ((row.getAttribute('aria-label') ?? '').split(', ')[2] ?? '')),
    n,
  );
const topFive = await statusCells(5);
console.log(`Most overdue first top five status cells:\n    ${topFive.join(' | ')}`);
const lateness = (cell) => {
  const m = /^Overdue (\d+) days?$/.exec(cell);
  return m === null ? null : Number(m[1]);
};
assert('the top row is an overdue invoice, not a draft', lateness(topFive[0]) !== null, topFive[0]);
assert('no draft appears above an overdue row', !topFive.slice(0, topFive.filter((c) => lateness(c) !== null).length).some((c) => /Draft/.test(c)), topFive.join(' | '));
const allStatuses = await statusCells(200);
const overdueDays = allStatuses.map(lateness).filter((days) => days !== null);
const maxLate = Math.max(...overdueDays);
console.log(`most overdue in the set: ${maxLate} days; top row: ${topFive[0]}`);
check('the first row IS the most overdue invoice in the list', lateness(topFive[0]), maxLate);
assert(
  'lateness reads down the page, never up',
  overdueDays.every((days, i) => i === 0 || overdueDays[i - 1] >= days),
  overdueDays.slice(0, 8).join(' '),
);
const firstDraft = allStatuses.findIndex((cell) => /Draft/.test(cell));
if (firstDraft !== -1) {
  assert(
    'every draft sits below every overdue row',
    allStatuses.slice(firstDraft).every((cell) => lateness(cell) === null),
    `first draft at ${firstDraft}`,
  );
}
// The caption has to describe the order that just happened.
const overdueFooter = (await page.getByText(/^Showing .* sorted by /).first().innerText()).trim();
console.log(`footer: ${overdueFooter}`);
assert('the caption names the order it actually produced', overdueFooter.includes('most overdue first') && overdueFooter.includes('drafts and settled last'), overdueFooter);
await shot(page, '11-most-overdue-first');

// --- keyboard operation of a menu ----------------------------------------
await header('ISSUED').focus();
await page.keyboard.press('Enter');
await page.getByRole('menu', { name: 'ISSUED sort and filter' }).waitFor({ timeout: 5000 });
const focused = async () => page.evaluate(() => document.activeElement?.textContent?.trim() ?? '');
console.log(`focus on open: ${await focused()}`);
assert('focus lands inside the menu on open', (await focused()).includes('Newest first'), await focused());
await page.keyboard.press('ArrowDown');
console.log(`after ArrowDown: ${await focused()}`);
assert('ArrowDown walks the menu', (await focused()).includes('Oldest first'), await focused());
await page.keyboard.press('ArrowUp');
assert('ArrowUp walks back', (await focused()).includes('Newest first'), await focused());
await shot(page, '05-menu-keyboard');
await page.keyboard.press('ArrowDown');
await page.keyboard.press('Enter');
check('a keyboard sort lands', await pill(), 'Sorted: Issued');
check('and the name says which order', await headerState('ISSUED'), 'sorted Oldest first');

// --- an open menu owns the keyboard --------------------------------------
// `J`/`K` used to move row focus behind an open menu and `/` used to jump to
// the search box while the menu stayed on screen.
await header('CLIENT').click();
await page.getByRole('menu', { name: 'CLIENT sort and filter' }).waitFor({ timeout: 5000 });
const insideMenu = () => page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null);
check('focus starts inside the menu', await insideMenu(), true);
for (const key of ['j', 'J', 'k', 'K']) {
  await page.keyboard.press(key);
  check(`${key} does not move row focus out of the menu`, await insideMenu(), true);
  check(`and the menu is still open after ${key}`, await page.getByRole('menu').count(), 1);
}
await page.keyboard.press('/');
check('/ does not jump to the search box', await insideMenu(), true);
check('and the menu survives /', await page.getByRole('menu').count(), 1);
check(
  'the search box did not take focus',
  await page.evaluate(() => document.activeElement?.getAttribute('placeholder') ?? ''),
  '',
);
await shot(page, '12-menu-owns-keyboard');
await page.keyboard.press('Escape');
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
// And the shortcuts come straight back once it is closed.
await page.locator('[role="link"]').first().focus();
await page.keyboard.press('j');
check('J works again with no menu open', await page.evaluate(() => document.activeElement?.getAttribute('role') ?? ''), 'link');
await page.keyboard.press('/');
check(
  '/ focuses the search box again',
  await page.evaluate(() => document.activeElement?.getAttribute('placeholder') ?? ''),
  'Client, number, amount',
);
await page.keyboard.press('Escape');
await page.getByRole('heading', { name: 'Invoices', level: 1 }).click();

// --- a plain filter -> one chip ------------------------------------------
const chipBar = page.getByRole('group', { name: 'Active column filters' });
check('no chip bar before a filter', await chipBar.count(), 0);

await header('STATUS & DUE').click();
await page.getByRole('menuitem', { name: 'Overdue only' }).click();
await chipBar.waitFor({ timeout: 5000 });
check('one chip, tagged the design way', (await chipBar.innerText()).replace(/\s+/g, ' ').trim(), 'FILTERS STATUS: Overdue only Clear all');
const rowCountAfter = await page.locator('[role="link"]').count();
console.log(`rows after the overdue chip: ${rowCountAfter}`);
await shot(page, '06-chip-overdue');

// Re-applying the same filter does not duplicate the chip.
await header('STATUS & DUE').click();
await page.getByRole('menuitem', { name: 'Overdue only' }).click();
check('re-applying does not duplicate', (await chipBar.getByRole('button', { name: /^Remove/ }).count()), 1);

// --- an ellipsis option, end to end --------------------------------------
await header('TOTAL').click();
await page.getByRole('menuitem', { name: 'Between…' }).click();
const from = page.getByRole('textbox', { name: 'From' });
await from.waitFor({ timeout: 5000 });

// The value step focuses its first *field*. It used to query the surface for
// `button`; the fields render above the footer and are not buttons, so Cancel
// took the focus and everything typed on that step went nowhere.
const activeOnValueStep = async () =>
  page.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName ?? 'none',
      name: el?.getAttribute('aria-label') ?? el?.getAttribute('placeholder') ?? el?.textContent?.trim() ?? '',
    };
  });
console.log(`focus on the Between… step: ${JSON.stringify(await activeOnValueStep())}`);
check('the value step focuses an input, not a button', (await activeOnValueStep()).tag, 'INPUT');
check('and it is inside the menu', await page.evaluate(() => document.activeElement?.closest('[role="menu"]') !== null), true);
// Typing straight away has to land in the field, which is the whole point.
await page.keyboard.type('4321');
check('typing goes into the first field', await from.inputValue(), '4321');
// Up/Down belong to the caret here, not to the menu's row-walking.
await page.keyboard.press('ArrowUp');
check('ArrowUp does not jump the focus to a button', (await activeOnValueStep()).tag, 'INPUT');
await from.fill('');
// Escape still closes the menu and hands focus back to the header that owns it.
await page.keyboard.press('Escape');
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
check(
  'Escape from the value step returns focus to the header',
  await page.evaluate(() => document.activeElement?.textContent?.trim() ?? ''),
  (await header('TOTAL').innerText()).trim(),
);

await header('TOTAL').click();
await page.getByRole('menuitem', { name: 'Between…' }).click();
await from.waitFor({ timeout: 5000 });
check('Apply is refused until the range is valid', await page.getByRole('button', { name: 'Apply' }).isDisabled(), true);
await from.fill('5000');
await page.getByRole('textbox', { name: 'To' }).fill('1000');
await shot(page, '07-input-step');
check('Apply goes live once both fields parse', await page.getByRole('button', { name: 'Apply' }).isDisabled(), false);
await page.getByRole('button', { name: 'Apply' }).click();
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
const chipText = (await chipBar.innerText()).replace(/\s+/g, ' ').trim();
console.log(`chips: ${chipText}`);
assert('the reversed range was corrected and committed', chipText.includes('TOTAL: Between 1000 – 5000'), chipText);
check('two chips now', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 2);
await shot(page, '08-two-chips');

// Every remaining row really is inside the range and overdue.
const rowLabels = await page.locator('[role="link"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''));
console.log(`rows after both chips: ${rowLabels.length}`);
const inRange = rowLabels.every((label) => {
  const total = Number(label.split(', ').at(-1).replace(/[^\d.]/g, ''));
  return total >= 1000 && total <= 5000;
});
assert('every row honours the money range', inRange, rowLabels.slice(0, 3).join(' | '));
assert('every row is overdue', rowLabels.every((label) => /Overdue|Marked overdue/.test(label)), rowLabels.slice(0, 3).join(' | '));

// --- remove and clear -----------------------------------------------------
await chipBar.getByRole('button', { name: /^Remove/ }).first().click();
check('one chip left after a remove', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 1);
await chipBar.getByRole('button', { name: /^Remove/ }).first().click();
check('removing the last chip hides the bar', await chipBar.count(), 0);

// Clear all.
await header('CLIENT').click();
await page.getByRole('menuitem', { name: 'Has open balance' }).click();
await header('STATUS & DUE').click();
await page.getByRole('menuitem', { name: 'Paid', exact: true }).click();
check('two chips before Clear all', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 2);
await page.getByRole('button', { name: 'Clear all' }).click();
check('Clear all empties the bar', await chipBar.count(), 0);

// --- an impossible date is refused ---------------------------------------
// `2026-02-31` used to pass a shape-only check, commit, and then be compared
// lexically against the issue date.
await header('ISSUED').click();
await page.getByRole('menuitem', { name: 'Custom range…' }).click();
const dateFrom = page.getByRole('textbox', { name: 'From' });
await dateFrom.waitFor({ timeout: 5000 });
await dateFrom.fill('2026-02-31');
await page.getByRole('textbox', { name: 'To' }).fill('2026-03-31');
check('Apply stays refused on a day that does not exist', await page.getByRole('button', { name: 'Apply' }).isDisabled(), true);
const dateError = (await page.getByRole('menu').innerText()).includes('real dates');
assert('and the field says why', dateError, (await page.getByRole('menu').innerText()).replace(/\s+/g, ' '));
await shot(page, '13-impossible-date-refused');
await dateFrom.fill('2026-02-28');
check('Apply goes live on a real date', await page.getByRole('button', { name: 'Apply' }).isDisabled(), false);
await page.getByRole('button', { name: 'Cancel' }).click();
await page.keyboard.press('Escape');
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });

// --- "Is any of…" rejects an empty token list and dedupes on the set -------
await header('CLIENT').click();
await page.getByRole('menuitem', { name: 'Is any of…' }).click();
const anyOf = page.getByRole('textbox', { name: 'Values, comma separated' });
await anyOf.waitFor({ timeout: 5000 });
// The single-field value step focuses its field too, not Cancel.
check('Is any of… focuses its field', await page.evaluate(() => document.activeElement?.tagName ?? 'none'), 'INPUT');
await page.keyboard.type('Halcyon');
check('and typing lands in it', await anyOf.inputValue(), 'Halcyon');
await anyOf.fill(', ');
check('", " is refused rather than matching everything', await page.getByRole('button', { name: 'Apply' }).isDisabled(), true);
await anyOf.fill('Halcyon, Northwind');
check('a real token list is accepted', await page.getByRole('button', { name: 'Apply' }).isDisabled(), false);
await page.getByRole('button', { name: 'Apply' }).click();
await chipBar.waitFor({ timeout: 5000 });
check('one chip after the first token list', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 1);
console.log(`any-of chip: ${(await chipBar.innerText()).replace(/\s+/g, ' ').trim()}`);
// The same set, typed in a different order and case: one predicate, one chip.
await header('CLIENT').click();
await page.getByRole('menuitem', { name: 'Is any of…' }).click();
await page.getByRole('textbox', { name: 'Values, comma separated' }).fill('northwind,Halcyon');
await page.getByRole('button', { name: 'Apply' }).click();
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
check('an equivalent token list does not add a second chip', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 1);
// A genuinely different set is a second chip.
await header('CLIENT').click();
await page.getByRole('menuitem', { name: 'Is any of…' }).click();
await page.getByRole('textbox', { name: 'Values, comma separated' }).fill('Halcyon');
await page.getByRole('button', { name: 'Apply' }).click();
await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
check('a different token set is a second chip', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 2);
await shot(page, '14-any-of-dedupe');
await page.getByRole('button', { name: 'Clear all' }).click();
check('cleared', await chipBar.count(), 0);

// A repeated token is the same set. `normaliseTokenList` sorted and lowercased
// but kept duplicates, so `Halcyon` keyed `client-any-of::halcyon` and
// `Halcyon, Halcyon` keyed `client-any-of::halcyon,halcyon` — two chips, while
// `matchesChip` narrows on the token set and treated them as one predicate.
// Removing either left the other still filtering.
const applyAnyOf = async (value) => {
  await header('CLIENT').click();
  await page.getByRole('menuitem', { name: 'Is any of…' }).click();
  await page.getByRole('textbox', { name: 'Values, comma separated' }).waitFor({ timeout: 5000 });
  await page.getByRole('textbox', { name: 'Values, comma separated' }).fill(value);
  await page.getByRole('button', { name: 'Apply' }).click();
  await page.getByRole('menu').first().waitFor({ state: 'detached', timeout: 5000 });
};
// `Northwind`, not `Halcyon`: the checks above only need a name to key a chip
// on, but this one has to count rows, and `client-any-of` is a substring match
// against a real client name.
await applyAnyOf('Northwind');
await chipBar.waitFor({ timeout: 5000 });
const rowsForOneToken = await page.locator('[role="link"]').count();
console.log(`rows for the Northwind token list: ${rowsForOneToken}`);
assert('the single-token list really narrows', rowsForOneToken > 0, String(rowsForOneToken));
await applyAnyOf('Northwind, Northwind');
console.log(`chips after the repeated token: ${(await chipBar.innerText()).replace(/\s+/g, ' ').trim()}`);
check('a repeated token adds no second chip', await chipBar.getByRole('button', { name: /^Remove/ }).count(), 1);
check('and it narrows to the same rows', await page.locator('[role="link"]').count(), rowsForOneToken);
await shot(page, '17-repeated-token-dedupe');
// One remove really removes the filter, rather than leaving a twin behind.
await chipBar.getByRole('button', { name: /^Remove/ }).first().click();
check('one remove empties the bar', await chipBar.count(), 0);
const rowsUnfiltered = await page.locator('[role="link"]').count();
console.log(`rows once the chip is gone: ${rowsUnfiltered}`);
assert('and the filter is really gone', rowsUnfiltered > rowsForOneToken, `${rowsForOneToken} -> ${rowsUnfiltered}`);

// --- a menu does not outlive its header ----------------------------------
const searchBox = page.getByRole('textbox', { name: 'Search invoices' });
await header('TOTAL').click();
check('menu open before the rows vanish', await page.getByRole('menu').count(), 1);
await searchBox.fill('zzzz-no-such-invoice-zzzz');
await page.getByRole('heading', { name: 'Nothing here' }).waitFor({ timeout: 10_000 });
check('the header strip is gone with the rows', await page.getByRole('group', { name: 'Invoice columns' }).count(), 0);
check('and the menu went with it', await page.getByRole('menu').count(), 0);
await searchBox.fill('');
await page.getByRole('group', { name: 'Invoice columns' }).waitFor({ timeout: 10_000 });
await page.waitForTimeout(300);
check('restoring the rows does not re-open it', await page.getByRole('menu').count(), 0);
check('no header claims to be expanded', await page.locator('[aria-expanded="true"][aria-haspopup="menu"]').count(), 0);

// The same rule at a narrower tier: ISSUED drops out below 880px.
await header('ISSUED').click();
check('ISSUED menu open at 1440px', await page.getByRole('menu').count(), 1);
await page.setViewportSize({ width: 800, height: 1000 });
await page.waitForTimeout(300);
check('the responsive tier dropped ISSUED', await header('ISSUED').count(), 0);
check('so its menu closed too', await page.getByRole('menu').count(), 0);
await page.setViewportSize({ width: 1440, height: 1000 });
await page.waitForTimeout(300);
check('ISSUED is back', await header('ISSUED').count(), 1);
check('and its menu did not come back with it', await page.getByRole('menu').count(), 0);
await shot(page, '15-menu-not-resurrected');

// --- tiles as filter shortcuts -------------------------------------------
await page.getByRole('button', { name: 'Filter by Drafts' }).click();
await chipBar.waitFor({ timeout: 5000 });
check('a tile click produces a menu-reachable chip', (await chipBar.innerText()).replace(/\s+/g, ' ').trim(), 'FILTERS STATUS: Drafts Clear all');
await page.getByRole('button', { name: 'Clear all' }).click();

// Chase all N: applies the overdue filter and selects those rows — from any
// segment. It used to keep the current tab, so on Sent, Drafts or Paid the row
// set went empty, `retainVisible` dropped every selected id, and the button
// silently did nothing.
const tab = (name) => page.getByRole('button', { name: new RegExp(`^${name} \\d+$`) });
// `All` is in the list on purpose: it shows overdue rows already, so the first
// repair left it alone and Chase from `All` kept `All` pressed with `Overdue`
// still at `aria-pressed="false"` — the same button behaving two ways.
for (const segment of ['Paid', 'Drafts', 'Sent', 'All']) {
  await tab(segment).click();
  await page.waitForTimeout(200);
  check(`on ${segment} before Chase`, await tab(segment).getAttribute('aria-pressed'), 'true');
  await chase.click();
  await chipBar.waitFor({ timeout: 5000 });
  check(`Chase from ${segment} applies the overdue chip`, (await chipBar.innerText()).includes('STATUS: Overdue only'), true);
  // And lands on the tab the action is ABOUT. `LIST_SEGMENTS.find(matches)`
  // reached the universal `All` first, so the rows and the chip were right
  // while `Overdue` still reported `aria-pressed="false"`.
  check(`Chase from ${segment} lands on Overdue`, await tab('Overdue').getAttribute('aria-pressed'), 'true');
  check(`and ${segment} is no longer pressed`, await tab(segment).getAttribute('aria-pressed'), 'false');
  const pressed = await page
    .getByRole('group', { name: 'Invoice status' })
    .locator('[aria-pressed="true"]')
    .evaluateAll((els) => els.map((el) => el.textContent?.trim().split(/\s+/)[0] ?? ''));
  check(`exactly one tab is pressed after Chase from ${segment}`, pressed, ['Overdue']);
  const rowsNow = await page.locator('[role="link"]').count();
  const labelsNow = await page.locator('[role="link"]').evaluateAll((rows) => rows.map((row) => row.getAttribute('aria-label') ?? ''));
  console.log(`Chase from ${segment}: ${rowsNow} rows visible`);
  assert(`Chase from ${segment} leaves rows on screen`, rowsNow > 0, String(rowsNow));
  assert(`and every one of them is overdue`, labelsNow.every((label) => /Overdue|Marked overdue/.test(label)), labelsNow.slice(0, 2).join(' | '));
  const selectedNow = await page.locator('input[type="checkbox"]:checked').count();
  console.log(`Chase from ${segment}: ${selectedNow} selected`);
  assert(`Chase from ${segment} really selects them`, selectedNow > 0, String(selectedNow));
  check(`and the bulk bar is up after Chase from ${segment}`, await page.getByRole('region', { name: 'Bulk actions' }).count(), 1);
  check(`All is not pressed after Chase from ${segment}`, await tab('All').getAttribute('aria-pressed'), 'false');
  if (segment === 'Sent') await shot(page, '09-chase-all-from-sent');
  if (segment === 'All') await shot(page, '09-chase-all');
  await page.getByRole('button', { name: 'Clear all' }).click();
  await page.getByRole('button', { name: /^Clear$/ }).click();
}

await shot(page, '10-final');
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
