/**
 * Demo data for the browser preview.
 *
 * An empty app shows nothing worth reviewing: no charts, no overdue badge, no
 * sense of what a real invoice list looks like — and fourteen rows prove
 * nothing about a list that paginates, filters inline and pages by ten. This
 * fills a fresh preview database with a plausible year of trading: ten clients
 * and sixty-six invoices spanning several pages, every status, four
 * currencies and a wide amount range, so every filter field has both matching
 * and non-matching rows.
 *
 * Nothing here is random. The generated invoices come from fixed cycles and a
 * seeded LCG, so two runs against the same reference date produce byte-identical
 * data — the screenshot harness cross-checks the rendered totals against a
 * direct read of the SQLite file and would flag any drift.
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
  {
    name: 'Aurora Health Systems',
    email: 'invoices@aurorahealth.org',
    phone: '+1 312 555 4408',
    addressLine1: '77 West Wacker Drive',
    addressLine2: 'Floor 12',
    city: 'Chicago',
    region: 'IL',
    postalCode: '60601',
    country: 'United States',
    taxId: 'US-36-4471209',
    notes: 'Purchase order number must appear on every invoice.',
  },
  {
    name: 'Blackwater Marine Ltd',
    email: 'ap@blackwatermarine.co.uk',
    phone: '+44 141 555 9012',
    addressLine1: '3 Clyde Quay',
    addressLine2: null,
    city: 'Glasgow',
    region: null,
    postalCode: 'G3 8HN',
    country: 'United Kingdom',
    taxId: 'GB 771 4420 88',
    notes: null,
  },
  {
    name: 'Solstice Media Group',
    email: 'finance@solsticemedia.com',
    phone: '+1 212 555 6633',
    addressLine1: '410 Lafayette Street',
    addressLine2: 'Studio 5',
    city: 'New York',
    region: 'NY',
    postalCode: '10003',
    country: 'United States',
    taxId: 'US-13-9902114',
    notes: 'Pays on the 15th of the month following invoice date.',
  },
  {
    name: 'Tamarind Foods NV',
    email: 'crediteuren@tamarindfoods.be',
    phone: '+32 3 555 2277',
    addressLine1: 'Scheldestraat 24',
    addressLine2: null,
    city: 'Antwerpen',
    region: null,
    postalCode: '2000',
    country: 'Belgium',
    taxId: 'BE0899123456',
    notes: 'Reverse-charge VAT — invoices are raised at 0%.',
  },
];

/**
 * Billing currency per client, positionally aligned with CLIENTS. The invoice
 * list shows a currency-aware total per row, so the spread has to be real data
 * rather than a display trick.
 */
const CLIENT_CURRENCY: readonly string[] = [
  'USD', // Northwind Analytics
  'EUR', // Kestrel Freight BV
  'GBP', // Halloway & Finch LLP
  'EUR', // Corvus Robotics GmbH
  'EUR', // Marisol Ferreira Studio
  'CAD', // Ridgeline Outfitters
  'USD', // Aurora Health Systems
  'GBP', // Blackwater Marine Ltd
  'USD', // Solstice Media Group
  'EUR', // Tamarind Foods NV
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
// Generated back-catalogue
// ---------------------------------------------------------------------------

/**
 * The fourteen hand-written invoices above carry the awkward arithmetic worth
 * looking at by hand. They are not enough to exercise a paginated, inline
 * filtered list, so the rest of the year is generated — deterministically.
 */
const GENERATED_COUNT = 52;

/**
 * Status is assigned by walking this cycle, not by chance: 52 invoices over a
 * 13-long cycle is exactly four laps, so the split is fixed and readable —
 * 24 paid, 12 sent, 8 draft, 4 overdue, 4 void.
 */
const STATUS_CYCLE: readonly InvoiceStatus[] = [
  'paid',
  'paid',
  'sent',
  'paid',
  'draft',
  'paid',
  'sent',
  'overdue',
  'paid',
  'draft',
  'sent',
  'void',
  'paid',
];

/** Client index per generated invoice. Length 11 against 52 — an uneven, and
 *  therefore realistic, spread across the roster; every client still appears. */
const CLIENT_CYCLE: readonly number[] = [0, 2, 6, 1, 8, 3, 0, 9, 5, 7, 4];

const NET_DAYS_CYCLE: readonly number[] = [14, 30, 45, 21, 30, 60, 30, 7];

interface CatalogueLine {
  readonly description: string;
  /** Milli-units. Multiplied by a per-invoice factor below. */
  readonly quantityMilli: number;
  readonly unitPriceCents: number;
}

/** Line items drawn from, in the order the generator asks for them. */
const CATALOGUE: readonly CatalogueLine[] = [
  { description: 'Platform engineering (hours)', quantityMilli: 12500, unitPriceCents: 18500 },
  { description: 'Integration build, milestone', quantityMilli: 1000, unitPriceCents: 245000 },
  { description: 'Support retainer (months)', quantityMilli: 1000, unitPriceCents: 320000 },
  { description: 'Data migration (hours)', quantityMilli: 22750, unitPriceCents: 16500 },
  { description: 'Consumable parts (units)', quantityMilli: 48000, unitPriceCents: 1999 },
  { description: 'Design review (half days)', quantityMilli: 3500, unitPriceCents: 68000 },
  { description: 'Incident response (hours)', quantityMilli: 5250, unitPriceCents: 32500 },
  { description: 'Reporting pack build', quantityMilli: 1000, unitPriceCents: 89000 },
  { description: 'Training session (attendees)', quantityMilli: 9000, unitPriceCents: 12500 },
  { description: 'Licence recharge (seats)', quantityMilli: 25000, unitPriceCents: 4900 },
  { description: 'Field survey (days)', quantityMilli: 2750, unitPriceCents: 110000 },
  { description: 'Copywriting (per page)', quantityMilli: 14000, unitPriceCents: 8500 },
];

/**
 * A 32-bit linear congruential generator (Numerical Recipes constants) with a
 * hard-coded seed. Used only to pick between fixed catalogue entries and to
 * scale quantities — so the output varies, but never between two runs.
 */
function lcg(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** The seeded, fixed-shape back-catalogue. Pure: same input, same output. */
export function generateInvoices(count: number = GENERATED_COUNT): SeedInvoice[] {
  const random = lcg(0x5eed_1234);
  const generated: SeedInvoice[] = [];

  for (let index = 0; index < count; index += 1) {
    const status = STATUS_CYCLE[index % STATUS_CYCLE.length] ?? 'draft';
    const client = CLIENT_CYCLE[index % CLIENT_CYCLE.length] ?? 0;
    const netDays = NET_DAYS_CYCLE[index % NET_DAYS_CYCLE.length] ?? 30;

    // Newest first in the loop, oldest last: ~7 days apart, spanning about a
    // year, so the revenue chart has a bar for every month.
    const issuedDaysAgo = 6 + index * 7;

    // Two or three lines, drawn from the catalogue and scaled. The scale
    // factors are wide on purpose: the smallest invoices land under $500 and
    // the largest over $20,000, so an "amount not more than" token always has
    // rows on both sides of it.
    const lineCount = 2 + Math.floor(random() * 2);
    const scale = 0.25 + Math.floor(random() * 12) * 0.55;
    const items: SeedItem[] = [];
    for (let line = 0; line < lineCount; line += 1) {
      const entry = CATALOGUE[Math.floor(random() * CATALOGUE.length)] ?? CATALOGUE[0]!;
      items.push({
        description: entry.description,
        quantityMilli: Math.max(250, Math.round((entry.quantityMilli * scale) / 250) * 250),
        unitPriceCents: entry.unitPriceCents,
      });
    }

    generated.push({
      client,
      status,
      issuedDaysAgo,
      netDays,
      // Belgian and Dutch customers are invoiced under the reverse charge.
      ...(client === 1 || client === 9 ? { taxRateBps: 0 } : {}),
      items,
    });
  }

  return generated;
}

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
  // Ties break on the client index, so the order never depends on sort stability.
  const all = [...INVOICES, ...OVERDUE, ...generateInvoices()].sort(
    (a, b) => b.issuedDaysAgo - a.issuedDaysAgo || a.client - b.client,
  );

  for (const spec of all) {
    const clientId = clientIds[spec.client];
    if (clientId === undefined) throw new Error(`seed: no client at index ${spec.client}`);
    const currency = CLIENT_CURRENCY[spec.client] ?? 'USD';

    createInvoice(db, {
      clientId,
      currency,
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
