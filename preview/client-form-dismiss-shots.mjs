/**
 * Drives the mid-save dismissal repro for the Piece C fix and screenshots it.
 * Run after `PREVIEW_PORT=4466 npm run preview:serve`:
 *
 *   PREVIEW_ORIGIN=http://127.0.0.1:4466 node preview/client-form-dismiss-shots.mjs
 *
 * The `clients:create` invoke is delayed via route interception so there is a
 * real in-flight window. Asserts (a) Escape during the in-flight save does NOT
 * dismiss the dialog, (b) the save then settles normally and the new client
 * appears (onSaved timing on the happy path unchanged), (c) Escape still
 * dismisses the dialog when no save is in flight. Screenshots land in
 * preview/.artifacts/.
 */

import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACTS = path.resolve(HERE, '.artifacts');
const ORIGIN = process.env.PREVIEW_ORIGIN ?? 'http://127.0.0.1:4466';
const APP_ORIGIN = `${ORIGIN}/app`;
const CREATE_DELAY_MS = 2500;

const failures = [];
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
  if (!ok) failures.push(label);
}

async function openNewClientDialog(page) {
  await page.getByRole('button', { name: /New client/ }).click();
  await page.getByRole('heading', { name: 'New client' }).waitFor({ timeout: 5_000 });
  await page.waitForTimeout(300);
}

async function dialogOpen(page) {
  return (await page.getByRole('heading', { name: 'New client' }).count()) > 0;
}

async function main() {
  mkdirSync(ARTIFACTS, { recursive: true });
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  // Delay only the clients:create invoke so the save has an in-flight window.
  await page.route('**/api/invoke', async (route) => {
    const body = route.request().postData() ?? '';
    if (body.includes('clients:create')) {
      await new Promise((r) => setTimeout(r, CREATE_DELAY_MS));
    }
    await route.fallback();
  });

  await page.goto(`${APP_ORIGIN}/#/clients`, { waitUntil: 'networkidle' });
  await page.getByRole('heading', { name: 'Clients', exact: true }).first().waitFor({ timeout: 15_000 });

  // --- Escape while the create is in flight --------------------------------
  await openNewClientDialog(page);
  const name = `Mid-save Dismissal Co ${Date.now()}`;
  await page.getByLabel(/Name/).fill(name);
  await page.getByRole('button', { name: 'Create client' }).click();
  await page.waitForTimeout(400); // inside the delayed in-flight window
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape during in-flight save does not dismiss the dialog', await dialogOpen(page));
  await page.screenshot({ path: path.join(ARTIFACTS, 'client-form-dismiss-blocked.png') });

  // --- The save settles and completes normally -----------------------------
  await page
    .getByRole('heading', { name: 'New client' })
    .waitFor({ state: 'detached', timeout: CREATE_DELAY_MS + 5_000 });
  await page.waitForTimeout(400);
  const created = (await page.getByText(name).count()) > 0;
  check('save settles: dialog closes and the created client appears', created,
    created ? undefined : `client "${name}" not found in list`);
  await page.screenshot({ path: path.join(ARTIFACTS, 'client-form-save-settled.png') });

  // --- Escape still works when idle ----------------------------------------
  await openNewClientDialog(page);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(400);
  check('Escape with no save in flight still dismisses the dialog', !(await dialogOpen(page)));
  await page.screenshot({ path: path.join(ARTIFACTS, 'client-form-idle-escape.png') });

  await browser.close();
  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) FAILED: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll dismiss-guard checks passed.');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
