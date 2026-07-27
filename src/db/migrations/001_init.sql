-- 001_init: the complete InvoiceApp schema.
--
-- Money is INTEGER cents, quantity is INTEGER milli-units (3 decimals), tax
-- rates are INTEGER basis points. There is deliberately no REAL column in this
-- file — see src/shared/money.ts for the arithmetic.
--
-- The migration runner wraps this file in a transaction, so it must not contain
-- BEGIN/COMMIT or any PRAGMA that cannot run inside one.

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS clients (
  id             TEXT PRIMARY KEY,
  name           TEXT NOT NULL,
  email          TEXT,
  phone          TEXT,
  address_line1  TEXT,
  address_line2  TEXT,
  city           TEXT,
  region         TEXT,
  postal_code    TEXT,
  country        TEXT,
  tax_id         TEXT,
  notes          TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoices (
  id             TEXT PRIMARY KEY,
  number         TEXT NOT NULL UNIQUE,
  client_id      TEXT NOT NULL REFERENCES clients(id),
  status         TEXT NOT NULL CHECK (status IN ('draft', 'sent', 'paid', 'overdue', 'void')),
  issue_date     TEXT NOT NULL,
  due_date       TEXT NOT NULL,
  currency       TEXT NOT NULL DEFAULT 'USD',
  tax_rate_bps   INTEGER NOT NULL DEFAULT 0,
  notes          TEXT,
  subtotal_cents INTEGER NOT NULL DEFAULT 0,
  tax_cents      INTEGER NOT NULL DEFAULT 0,
  total_cents    INTEGER NOT NULL DEFAULT 0,
  paid_at        TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS invoice_items (
  id               TEXT PRIMARY KEY,
  invoice_id       TEXT NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL,
  description      TEXT NOT NULL,
  quantity_milli   INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  amount_cents     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS models (
  id               TEXT PRIMARY KEY,
  repo             TEXT NOT NULL,
  filename         TEXT NOT NULL,
  quant            TEXT,
  size_bytes       INTEGER,
  sha256           TEXT,
  local_path       TEXT,
  status           TEXT NOT NULL CHECK (status IN ('available', 'downloading', 'ready', 'error')),
  downloaded_bytes INTEGER NOT NULL DEFAULT 0,
  error            TEXT,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_threads (
  id         TEXT PRIMARY KEY,
  title      TEXT,
  model_id   TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS chat_messages (
  id         TEXT PRIMARY KEY,
  thread_id  TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
  role       TEXT NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  content    TEXT NOT NULL,
  tool_calls TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_invoices_client_id ON invoices (client_id);
CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices (status);
CREATE INDEX IF NOT EXISTS idx_invoices_issue_date ON invoices (issue_date);
CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_position ON invoice_items (invoice_id, position);
CREATE INDEX IF NOT EXISTS idx_chat_messages_thread_created ON chat_messages (thread_id, created_at);
