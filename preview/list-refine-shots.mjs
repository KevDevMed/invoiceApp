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
await page.getByRole('table', { name: 'Invoice columns' }).waitFor({ timeout: 20_000 });
await shot(page, '01-list');

// --- subtitle -------------------------------------------------------------
const subtitle = (await page.locator('h1:has-text("Invoices") + *').first().innerText()).trim();
console.log(`subtitle: ${subtitle}`);
assert('subtitle leads with the chasing count', /^\d+ invoices? needs? chasing today/.test(subtitle), subtitle);
assert('subtitle never claims USD equivalence', !subtitle.includes('equiv'), subtitle);

// --- tiles ----------------------------------------------------------------
const tileTemplate = await page
  .getByRole('button', { name: 'Filter by Outstanding' })
  .evaluate((el) => getComputedStyle(el.parentElement).gridTemplateColumns);
console.log(`tile grid: ${tileTemplate}`);
assert('tile grid has four unequal tracks', tileTemplate.split(' ').length === 4, tileTemplate);
const [t1, t2, t3, t4] = tileTemplate.split(' ').map(parseFloat);
assert('Outstanding is the widest track', t1 > t2 && t2 > t3, tileTemplate);
assert('the last two tracks are equal', Math.abs(t3 - t4) < 1.5, tileTemplate);

const chase = page.getByRole('button', { name: /^Chase all \d+$/ });
assert('Overdue tile carries Chase all N', (await chase.count()) === 1);
console.log(`chase button: ${await chase.innerText()}`);

const overdueTile = page.getByRole('button', { name: 'Filter by Overdue' });
const overdueLines = (await overdueTile.innerText()).split('\n').map((line) => line.trim());
console.log(`overdue tile:\n${overdueLines.map((line) => `    ${line}`).join('\n')}`);
const overdueSubline = overdueLines.find((line) => /invoices? · /.test(line)) ?? '';
console.log(`overdue subline: ${overdueSubline}`);
assert('overdue subline carries three facts', overdueSubline.split(' · ').length === 3, overdueSubline);
assert('overdue subline claims no reminders', !/reminder/i.test(overdueSubline), overdueSubline);

for (const label of ['Due in 7 days', 'Drafts']) {
  const text = (await page.getByRole('button', { name: `Filter by ${label}` }).innerText()).trim();
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
const header = (label) => page.getByRole('button', { name: `${label}, sort and filter` });

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
check('STATUS & DUE reports aria-sort', await page.getByRole('columnheader').filter({ hasText: 'STATUS & DUE' }).getAttribute('aria-sort'), 'ascending');

await header('TOTAL').click();
await page.getByRole('menuitemradio', { name: 'Largest first' }).click();
check('pill follows the header sort', await pill(), 'Sorted: Total');
check('TOTAL reports aria-sort descending', await page.getByRole('columnheader').filter({ hasText: 'TOTAL' }).getAttribute('aria-sort'), 'descending');
check('only one column is sorted', await page.locator('[role="columnheader"][aria-sort="descending"], [role="columnheader"][aria-sort="ascending"]').count(), 1);
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
check('and the arrow says ascending', await page.getByRole('columnheader').filter({ hasText: 'ISSUED' }).getAttribute('aria-sort'), 'ascending');

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

// --- tiles as filter shortcuts -------------------------------------------
await page.getByRole('button', { name: 'Filter by Drafts' }).click();
await chipBar.waitFor({ timeout: 5000 });
check('a tile click produces a menu-reachable chip', (await chipBar.innerText()).replace(/\s+/g, ' ').trim(), 'FILTERS STATUS: Drafts Clear all');
await page.getByRole('button', { name: 'Clear all' }).click();

// Chase all N: applies the overdue filter and selects those rows.
await chase.click();
await chipBar.waitFor({ timeout: 5000 });
check('Chase all applies the overdue chip', (await chipBar.innerText()).includes('STATUS: Overdue only'), true);
const checked = await page.locator('input[type="checkbox"]:checked').count();
console.log(`rows selected by Chase all: ${checked}`);
assert('Chase all selects the overdue rows', checked > 0, String(checked));
assert('and a bulk bar appears rather than a sent claim', (await page.getByRole('region', { name: 'Bulk actions' }).count()) === 1);
await shot(page, '09-chase-all');
await page.getByRole('button', { name: 'Clear all' }).click();

await shot(page, '10-final');
console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
await browser.close();
process.exit(failures === 0 ? 0 : 1);
