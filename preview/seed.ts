/**
 * Demo data for the browser preview.
 *
 * An empty app shows nothing worth reviewing: no charts, no overdue badge, no
 * sense of what a real invoice list looks like. This fills a fresh preview
 * database with a plausible eight months of trading.
 *
 * Every total is computed by `createInvoice` in `src/domain/invoices/repository.ts`,
 * which runs the same integer-cent arithmetic the desktop app runs. Nothing here
 * writes a subtotal, tax amount or total by hand — if the preview's numbers ever
 * disagree with the desktop app's, that is a real bug and not a seeding artefact.
 *
 * Seeding is idempotent: it runs only when the database has no clients and no
 * invoices. `PREVIEW_RESET=1` wipes the demo tables first and reseeds.
 */

import type { Db } from '../src/db/client';
import { createClient } from '../src/domain/clients/repository';
import { createInvoice } from '../src/domain/invoices/repository';
import { SETTINGS_KEYS, type ClientInput, type InvoiceStatus } from '../src/shared/types';

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

const MS_PER_DAY = 86_400_000;

function isoDay(reference: Date, daysAgo: number): string {
  return new Date(reference.getTime() - daysAgo * MS_PER_DAY).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const CLIENTS: readonly ClientInput[] = [
  {
    name: 'Northwind Analytics',
    email: 'ap@northwind-analytics.com',
    phone: '+1 415 555 0142',
    addressLine1: '2100 Bryant Street',
    addressLine2: 'Suite 300',
    city: 'San Francisco',
    region: 'CA',
    postalCode: '94110',
    country: 'United States',
    taxId: 'US-84-2211930',
    notes: 'Net 30. Invoices go to accounts payable, not to the project contact.',
  },
  {
    name: 'Kestrel Freight BV',
    email: 'facturen@kestrelfreight.nl',
    phone: '+31 20 555 8841',
    addressLine1: 'Keizersgracht 412',
    addressLine2: null,
    city: 'Amsterdam',
    region: 'Noord-Holland',
    postalCode: '1016 GC',
    country: 'Netherlands',
    taxId: 'NL812345678B01',
    notes: 'Reverse-charge VAT — invoices are raised at 0%.',
  },
  {
    name: 'Halloway & Finch LLP',
    email: 'billing@hallowayfinch.co.uk',
    phone: '+44 20 7946 0221',
    addressLine1: '18 Bedford Row',
    addressLine2: null,
    city: 'London',
    region: null,
    postalCode: 'WC1R 4EH',
    country: 'United Kingdom',
    taxId: 'GB 412 8871 03',
    notes: 'Slow payer. Chase at day 45.',
  },
  {
    name: 'Corvus Robotics GmbH',
    email: 'rechnungen@corvus-robotics.de',
    phone: '+49 30 5557 2210',
    addressLine1: 'Chausseestraße 111',
    addressLine2: 'Aufgang B',
    city: 'Berlin',
    region: null,
    postalCode: '10115',
    country: 'Germany',
    taxId: 'DE298114772',
    notes: null,
  },
  {
    name: 'Marisol Ferreira Studio',
    email: 'marisol@ferreira.studio',
    phone: '+351 21 555 3390',
    addressLine1: 'Rua da Bica 47',
    addressLine2: null,
    city: 'Lisboa',
    region: null,
    postalCode: '1200-089',
    country: 'Portugal',
    taxId: null,
    notes: 'Prefers a single consolidated invoice at the end of each engagement.',
  },
  {
    name: 'Ridgeline Outfitters',
    email: 'accounts@ridgelineoutfitters.ca',
    phone: '+1 604 555 7712',
    addressLine1: '990 Marine Drive',
    addressLine2: null,
    city: 'North Vancouver',
    region: 'BC',
    postalCode: 'V7P 1S3',
    country: 'Canada',
    taxId: 'CA-889012334-RT0001',
    notes: null,
  },
];

// ---------------------------------------------------------------------------
// Invoices
// ---------------------------------------------------------------------------

interface SeedItem {
  readonly description: string;
  /** Milli-units: 1500 === 1.5. Fractional on purpose. */
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

interface SeedInvoice {
  /** Index into CLIENTS. */
  readonly client: number;
  readonly status: InvoiceStatus;
  readonly issuedDaysAgo: number;
  /** Days after the issue date. Negative net terms would be nonsense, so this is always positive. */
  readonly netDays: number;
  readonly taxRateBps?: number;
  readonly notes?: string;
  readonly items: readonly SeedItem[];
}

/**
 * Twelve invoices over roughly eight months, so the revenue chart has a shape
 * rather than a single bar. Two are `sent` with a due date that has already
 * passed — those are the genuinely overdue ones the reports page must surface.
 * The 8.25% rate and the 19.99 unit prices exist to make rounding visible.
 */
const INVOICES: readonly SeedInvoice[] = [
  {
    client: 0,
    status: 'paid',
    issuedDaysAgo: 238,
    netDays: 30,
    notes: 'Q1 discovery engagement.',
    items: [
      { description: 'Discovery workshop (facilitation)', quantityMilli: 2000, unitPriceCents: 145000 },
      { description: 'Stakeholder interviews', quantityMilli: 6500, unitPriceCents: 22500 },
      { description: 'Findings report', quantityMilli: 1000, unitPriceCents: 89000 },
    ],
  },
  {
    client: 2,
    status: 'paid',
    issuedDaysAgo: 221,
    netDays: 45,
    items: [
      { description: 'Retainer — senior engineering, February', quantityMilli: 72500, unitPriceCents: 18500 },
      { description: 'Out-of-hours release support', quantityMilli: 3250, unitPriceCents: 27750 },
    ],
  },
  {
    client: 1,
    status: 'paid',
    issuedDaysAgo: 196,
    netDays: 30,
    taxRateBps: 0,
    notes: 'VAT reverse-charged to the customer under EU intra-community supply rules.',
    items: [
      { description: 'Route-planning integration, phase 1', quantityMilli: 40000, unitPriceCents: 16500 },
      { description: 'Carrier API adapters (per adapter)', quantityMilli: 4000, unitPriceCents: 74500 },
      { description: 'Handover documentation', quantityMilli: 1500, unitPriceCents: 64000 },
    ],
  },
  {
    client: 3,
    status: 'paid',
    issuedDaysAgo: 168,
    netDays: 30,
    items: [
      { description: 'Firmware telemetry review', quantityMilli: 18750, unitPriceCents: 21000 },
      { description: 'Bench test rig hire (days)', quantityMilli: 3500, unitPriceCents: 42500 },
      { description: 'Replacement encoder cables', quantityMilli: 12000, unitPriceCents: 1999 },
    ],
  },
  {
    client: 5,
    status: 'paid',
    issuedDaysAgo: 142,
    netDays: 21,
    items: [
      { description: 'Seasonal catalogue photography (half days)', quantityMilli: 5500, unitPriceCents: 68000 },
      { description: 'Retouching (per image)', quantityMilli: 84000, unitPriceCents: 1999 },
    ],
  },
  {
    client: 0,
    status: 'paid',
    issuedDaysAgo: 117,
    netDays: 30,
    items: [
      { description: 'Warehouse dashboard build', quantityMilli: 61250, unitPriceCents: 18500 },
      { description: 'Data warehouse migration', quantityMilli: 22500, unitPriceCents: 21500 },
      { description: 'Training session', quantityMilli: 1500, unitPriceCents: 95000 },
    ],
  },
  {
    client: 4,
    status: 'paid',
    issuedDaysAgo: 96,
    netDays: 30,
    notes: 'Consolidated invoice for the spring engagement, as agreed.',
    items: [
      { description: 'Brand system consultation (days)', quantityMilli: 4250, unitPriceCents: 78000 },
      { description: 'Component library audit', quantityMilli: 12750, unitPriceCents: 19500 },
      { description: 'Licensed icon set', quantityMilli: 1000, unitPriceCents: 1999 },
    ],
  },
  {
    client: 2,
    status: 'paid',
    issuedDaysAgo: 74,
    netDays: 45,
    notes: 'Paid at day 58, after the second reminder.',
    items: [
      { description: 'Retainer — senior engineering, May', quantityMilli: 68000, unitPriceCents: 18500 },
      { description: 'Matter-management data extract', quantityMilli: 9250, unitPriceCents: 24000 },
    ],
  },
  {
    client: 3,
    status: 'sent',
    issuedDaysAgo: 52,
    // Net 60 on commissioning work, so this one is still current rather than
    // quietly becoming a third overdue invoice.
    netDays: 60,
    items: [
      { description: 'Gripper calibration study', quantityMilli: 26500, unitPriceCents: 21000 },
      { description: 'Spare servo controllers', quantityMilli: 6000, unitPriceCents: 1999 },
      { description: 'On-site commissioning (days)', quantityMilli: 2500, unitPriceCents: 110000 },
    ],
  },
  {
    client: 1,
    status: 'sent',
    issuedDaysAgo: 28,
    netDays: 30,
    taxRateBps: 0,
    items: [
      { description: 'Route-planning integration, phase 2', quantityMilli: 35500, unitPriceCents: 16500 },
      { description: 'Load-testing environment (weeks)', quantityMilli: 2000, unitPriceCents: 58000 },
    ],
  },
  {
    client: 5,
    status: 'draft',
    issuedDaysAgo: 11,
    netDays: 21,
    notes: 'Awaiting confirmation of the final shoot day before sending.',
    items: [
      { description: 'Autumn campaign photography (half days)', quantityMilli: 3500, unitPriceCents: 68000 },
      { description: 'Retouching (per image)', quantityMilli: 46000, unitPriceCents: 1999 },
      { description: 'Location permit recharge', quantityMilli: 1000, unitPriceCents: 32500 },
    ],
  },
  {
    client: 4,
    status: 'draft',
    issuedDaysAgo: 4,
    netDays: 30,
    items: [
      { description: 'Design system rollout, sprint 1', quantityMilli: 31250, unitPriceCents: 19500 },
      { description: 'Accessibility review', quantityMilli: 8500, unitPriceCents: 22500 },
    ],
  },
];

/**
 * The two overdue invoices. Kept separate from the list above because their
 * defining property is the relationship between status and due date — `sent`
 * with a due date in the past — and burying that in a `netDays` arithmetic
 * puzzle would make it easy to break by accident.
 */
const OVERDUE: readonly SeedInvoice[] = [
  {
    client: 2,
    status: 'sent',
    issuedDaysAgo: 132,
    netDays: 45, // due ~87 days ago
    notes: 'Past due. Third reminder sent.',
    items: [
      { description: 'Retainer — senior engineering, March', quantityMilli: 70000, unitPriceCents: 18500 },
      { description: 'Emergency incident response (hours)', quantityMilli: 5750, unitPriceCents: 32500 },
      { description: 'Archived matter export', quantityMilli: 1000, unitPriceCents: 47500 },
    ],
  },
  {
    client: 4,
    status: 'sent',
    issuedDaysAgo: 63,
    netDays: 21, // due ~42 days ago
    notes: 'Past due. Client says the PO number changed; awaiting the new one.',
    items: [
      { description: 'Motion study for launch page', quantityMilli: 2750, unitPriceCents: 84000 },
      { description: 'Illustration set (per asset)', quantityMilli: 15000, unitPriceCents: 1999 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Seeding
// ---------------------------------------------------------------------------

const SETTINGS: ReadonlyArray<readonly [string, string]> = [
  [SETTINGS_KEYS.businessName, 'Harbourline Studio Ltd'],
  [
    SETTINGS_KEYS.businessAddress,
    '4 Quayside Walk\nUnit 2B\nBristol BS1 4RN\nUnited Kingdom\nVAT GB 388 2211 07',
  ],
  [SETTINGS_KEYS.defaultCurrency, 'USD'],
  // 8.25% — an awkward rate on purpose, so rounding is visible in every total.
  [SETTINGS_KEYS.defaultTaxRateBps, '825'],
  [SETTINGS_KEYS.invoiceNumberPrefix, 'INV-'],
];

/** True when the preview database has no demo data yet. */
export function isEmpty(db: Db): boolean {
  const clients = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM clients').get();
  const invoices = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM invoices').get();
  return (clients?.n ?? 0) === 0 && (invoices?.n ?? 0) === 0;
}

/**
 * Delete every row the seeder creates. Schema and migration history are left
 * alone — this is a data reset, not a rebuild.
 */
export function reset(db: Db): void {
  const wipe = db.transaction(() => {
    db.exec('DELETE FROM invoice_items');
    db.exec('DELETE FROM invoices');
    db.exec('DELETE FROM clients');
    db.exec('DELETE FROM settings');
  });
  wipe();
}

export interface SeedResult {
  readonly seeded: boolean;
  readonly clients: number;
  readonly invoices: number;
}

/**
 * Seed the preview database if it is empty. Safe to call on every boot.
 *
 * @param reference "Today" for the generated dates. Injectable so tests do not
 *   depend on the wall clock.
 */
export function seed(db: Db, reference: Date = new Date()): SeedResult {
  if (!isEmpty(db)) {
    const clients = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM clients').get();
    const invoices = db.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM invoices').get();
    return { seeded: false, clients: clients?.n ?? 0, invoices: invoices?.n ?? 0 };
  }

  for (const [key, value] of SETTINGS) {
    db.prepare<[string, string]>(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    ).run(key, value);
  }

  const clientIds = CLIENTS.map((input) => createClient(db, input).id);

  // Oldest first, so the allocated invoice numbers run in chronological order.
  const all = [...INVOICES, ...OVERDUE].sort((a, b) => b.issuedDaysAgo - a.issuedDaysAgo);

  for (const spec of all) {
    const clientId = clientIds[spec.client];
    if (clientId === undefined) throw new Error(`seed: no client at index ${spec.client}`);

    createInvoice(db, {
      clientId,
      status: spec.status,
      issueDate: isoDay(reference, spec.issuedDaysAgo),
      dueDate: isoDay(reference, spec.issuedDaysAgo - spec.netDays),
      ...(spec.taxRateBps === undefined ? {} : { taxRateBps: spec.taxRateBps }),
      notes: spec.notes ?? null,
      // Totals are computed inside createInvoice by the real domain code.
      items: spec.items.map((item, position) => ({ ...item, position })),
    });
  }

  return { seeded: true, clients: CLIENTS.length, invoices: all.length };
}

/** `seed()`, preceded by a wipe when `PREVIEW_RESET=1`. */
export function seedOnBoot(db: Db, resetRequested: boolean, reference: Date = new Date()): SeedResult {
  if (resetRequested) reset(db);
  return seed(db, reference);
}
