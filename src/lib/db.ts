import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { config } from "./config";
import { purgeDemoIdentities, seedIfEmpty } from "./seed";

type Cache = { db: DatabaseSync; path: string };
const g = globalThis as unknown as { __mercavineDb?: Cache };

export type Sql = string | number | bigint | null | Uint8Array;

const SCHEMA = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS addresses (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  recipient TEXT NOT NULL,
  line1 TEXT NOT NULL,
  line2 TEXT,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  postal_code TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'US',
  is_default INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS bots (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  public_key_pem TEXT,
  scopes TEXT NOT NULL,
  per_order_limit_cents INTEGER NOT NULL,
  per_day_limit_cents INTEGER NOT NULL,
  per_month_limit_cents INTEGER NOT NULL,
  approval_threshold_cents INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sellers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  rating REAL NOT NULL,
  rating_count INTEGER NOT NULL,
  stripe_account_id TEXT NOT NULL,
  statement_descriptor TEXT NOT NULL,
  return_window_days INTEGER NOT NULL,
  restocking_fee_pct INTEGER NOT NULL DEFAULT 0,
  ships_from_city TEXT NOT NULL,
  ships_from_region TEXT NOT NULL,
  prime_enrolled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS products (
  id TEXT PRIMARY KEY,
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  category TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  product_id TEXT NOT NULL REFERENCES products(id),
  seller_id TEXT NOT NULL REFERENCES sellers(id),
  sku TEXT NOT NULL,
  variant_label TEXT,
  price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  stock INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  eta_min_days INTEGER NOT NULL,
  eta_max_days INTEGER NOT NULL,
  lock_ttl_minutes INTEGER NOT NULL DEFAULT 30,
  return_window_days INTEGER NOT NULL,
  restocking_fee_pct INTEGER NOT NULL DEFAULT 0,
  fba_backed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS carts (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  bot_client_id TEXT NOT NULL REFERENCES bots(id),
  status TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  lane TEXT NOT NULL DEFAULT 'native',
  shipping_address_id TEXT,
  note_for_human TEXT,
  client_reference TEXT,
  lock_expires_at TEXT,
  lock_extended INTEGER NOT NULL DEFAULT 0,
  status_reason TEXT,
  approval_requested_at TEXT,
  approval_viewed_at TEXT,
  decided_at TEXT,
  decided_by TEXT,
  approval_method TEXT,
  decline_reason TEXT,
  decline_note TEXT,
  share_decline_note INTEGER NOT NULL DEFAULT 0,
  notify_hint TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cart_lines (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL REFERENCES carts(id),
  offer_id TEXT REFERENCES offers(id),
  provider TEXT NOT NULL DEFAULT 'native',
  external_id TEXT,
  seller_id TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  title TEXT NOT NULL,
  variant_label TEXT,
  category TEXT,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'usd',
  shipping_cents INTEGER NOT NULL DEFAULT 0,
  eta_min_days INTEGER NOT NULL DEFAULT 3,
  eta_max_days INTEGER NOT NULL DEFAULT 7,
  return_window_days INTEGER NOT NULL DEFAULT 30,
  restocking_fee_pct INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'quoted',
  continue_url TEXT,
  placement_json TEXT
);

CREATE TABLE IF NOT EXISTS cart_events (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS inventory_reservations (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  line_id TEXT NOT NULL,
  offer_id TEXT NOT NULL,
  qty INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  status TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS approval_tokens (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  cart_version INTEGER NOT NULL,
  user_id TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  revoked_at TEXT,
  view_count INTEGER NOT NULL DEFAULT 0,
  view_window_started_at TEXT,
  last_view_at TEXT,
  failed_auth INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bot_client_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  seller_name TEXT NOT NULL,
  status TEXT NOT NULL,
  currency TEXT NOT NULL,
  subtotal_cents INTEGER NOT NULL,
  shipping_cents INTEGER NOT NULL,
  tax_cents INTEGER NOT NULL,
  total_cents INTEGER NOT NULL,
  application_fee_cents INTEGER NOT NULL,
  payment_status TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  stripe_account_id TEXT,
  tracking_carrier TEXT,
  tracking_number TEXT,
  ship_eta_start TEXT,
  ship_eta_end TEXT,
  payment_provider TEXT NOT NULL DEFAULT 'stripe',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES orders(id),
  cart_line_id TEXT,
  title TEXT NOT NULL,
  variant_label TEXT,
  quantity INTEGER NOT NULL,
  unit_price_cents INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  stripe_account_id TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_id TEXT,
  failure_code TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS payment_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  cart_id TEXT NOT NULL,
  seller_id TEXT NOT NULL,
  action TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  bot_client_id TEXT NOT NULL,
  key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER NOT NULL,
  response_body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (bot_client_id, key)
);

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  actor_id TEXT,
  action TEXT NOT NULL,
  resource_type TEXT,
  resource_id TEXT,
  detail TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bot_client_id TEXT,
  resource_id TEXT,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  bot_client_id TEXT NOT NULL,
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  disabled_at TEXT,
  failure_since TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id TEXT PRIMARY KEY,
  endpoint_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS auto_rules (
  id TEXT PRIMARY KEY,
  bot_client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 0,
  max_per_order_cents INTEGER NOT NULL,
  allowed_categories TEXT NOT NULL,
  seller_allowlist TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS spend_ledger (
  id TEXT PRIMARY KEY,
  bot_client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  cart_id TEXT,
  order_id TEXT,
  amount_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS returns (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  reason TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  credential_id TEXT NOT NULL UNIQUE,
  public_key TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  challenge TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_links (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  status TEXT NOT NULL,
  device_code TEXT,
  user_code TEXT,
  verification_uri TEXT,
  access_token TEXT,
  shop_email TEXT,
  shop_name TEXT,
  expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shop_pay_requests (
  id TEXT PRIMARY KEY,
  cart_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  status TEXT NOT NULL,
  merchant_name TEXT NOT NULL,
  merchant_url TEXT NOT NULL,
  checkout_url TEXT NOT NULL,
  currency TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  approval_limit_cents INTEGER NOT NULL,
  continue_url TEXT,
  shop_request_id TEXT,
  fee_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS amazon_seller_links (
  seller_id TEXT PRIMARY KEY REFERENCES sellers(id),
  status TEXT NOT NULL,
  selling_partner_id TEXT,
  refresh_token TEXT,
  marketplace_id TEXT,
  oauth_state TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS mcf_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL UNIQUE,
  seller_id TEXT NOT NULL,
  seller_fulfillment_order_id TEXT NOT NULL,
  status TEXT NOT NULL,
  shipping_speed TEXT NOT NULL,
  earliest_arrival TEXT,
  latest_arrival TEXT,
  carrier TEXT,
  tracking_number TEXT,
  detail TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_offers_product ON offers(product_id);
CREATE INDEX IF NOT EXISTS idx_carts_owner ON carts(user_id, bot_client_id, status);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_orders_user ON orders(user_id, created_at);

CREATE TABLE IF NOT EXISTS email_tokens (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  purpose TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_email_tokens_user ON email_tokens(user_id, purpose);

CREATE TABLE IF NOT EXISTS oauth_clients (
  client_id TEXT PRIMARY KEY,
  client_secret_hash TEXT,
  client_name TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_requests (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES oauth_clients(client_id),
  user_id TEXT NOT NULL REFERENCES users(id),
  redirect_uri TEXT NOT NULL,
  scopes TEXT NOT NULL,
  state TEXT,
  code_challenge TEXT NOT NULL,
  resource TEXT,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_codes (
  code_hash TEXT PRIMARY KEY,
  client_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  redirect_uri TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  scopes TEXT NOT NULL,
  resource TEXT,
  family TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

CREATE TABLE IF NOT EXISTS oauth_tokens (
  token_hash TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  client_id TEXT NOT NULL,
  bot_id TEXT NOT NULL REFERENCES bots(id),
  scopes TEXT NOT NULL,
  resource TEXT,
  family TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS oauth_tokens_family ON oauth_tokens(family);
CREATE INDEX IF NOT EXISTS oauth_tokens_bot ON oauth_tokens(bot_id);
`;

function migrate(db: DatabaseSync): void {
  // 1 = MCP-only connection (OAuth connectors such as Grok), never used on the signed REST path.
  addColumn(db, "bots", "mcp_only", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "orders", "payment_provider", "TEXT NOT NULL DEFAULT 'stripe'");
  // TODO(email-verification): send a verification link and set this to 1 on confirm. Not enforced yet.
  addColumn(db, "users", "email_verified", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "cart_lines", "placement_json", "TEXT");
  const offerCols = db.prepare(`PRAGMA table_info(offers)`).all() as { name: string }[];
  const hadFba = offerCols.some((col) => col.name === "fba_backed");
  addColumn(db, "sellers", "prime_enrolled", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "offers", "fba_backed", "INTEGER NOT NULL DEFAULT 0");
  if (!hadFba) db.exec(`UPDATE offers SET fba_backed = 1 WHERE id = 'ofr_brass_hinge'`);
  // Seller onboarding. Existing (catalog) sellers stay 'active'; self-serve sellers start at 'onboarding'.
  addColumn(db, "sellers", "user_id", "TEXT REFERENCES users(id)");
  addColumn(db, "sellers", "status", "TEXT NOT NULL DEFAULT 'active'");
  addColumn(db, "sellers", "contact_name", "TEXT");
  addColumn(db, "sellers", "contact_email", "TEXT");
  addColumn(db, "sellers", "phone", "TEXT");
  addColumn(db, "sellers", "website", "TEXT");
  addColumn(db, "sellers", "category", "TEXT");
  addColumn(db, "sellers", "description", "TEXT");
  addColumn(db, "sellers", "terms_accepted_at", "TEXT");
  addColumn(db, "sellers", "stripe_charges_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sellers", "stripe_payouts_enabled", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sellers", "stripe_details_submitted", "INTEGER NOT NULL DEFAULT 0");
  addColumn(db, "sellers", "created_at", "TEXT");
  addColumn(db, "products", "image_url", "TEXT");
  addColumn(db, "sellers", "pm_domains", "TEXT");
  addColumn(db, "payment_attempts", "client_secret", "TEXT");
  addColumn(db, "payment_attempts", "updated_at", "TEXT");
  db.exec(`CREATE TABLE IF NOT EXISTS stripe_events (id TEXT PRIMARY KEY, type TEXT NOT NULL, received_at TEXT NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sellers_user ON sellers(user_id)`);
  // First-party Mercavine Store + CJdropshipping supplier tables.
  addColumn(db, "sellers", "first_party", "INTEGER NOT NULL DEFAULT 0");
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_products (
    pid TEXT PRIMARY KEY, vid TEXT NOT NULL, supplier TEXT NOT NULL, name TEXT NOT NULL, category_id TEXT,
    cost_cents INTEGER NOT NULL, freight_cents INTEGER NOT NULL, logistic_name TEXT, us_stock INTEGER NOT NULL,
    price_cents INTEGER NOT NULL, status TEXT NOT NULL, last_synced_at TEXT NOT NULL, created_at TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_product_map (
    offer_id TEXT PRIMARY KEY REFERENCES offers(id), pid TEXT NOT NULL REFERENCES supplier_products(pid), vid TEXT NOT NULL)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_spm_pid ON supplier_product_map(pid)`);
  db.exec(`CREATE TABLE IF NOT EXISTS supplier_orders (
    id TEXT PRIMARY KEY, cart_id TEXT NOT NULL UNIQUE, order_id TEXT, supplier TEXT NOT NULL, status TEXT NOT NULL,
    dedupe_key TEXT NOT NULL UNIQUE, cj_order_id TEXT, cj_status TEXT, tracking_number TEXT, tracking_url TEXT,
    request_json TEXT, detail TEXT, approved_by TEXT, approved_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
  // Sales tax for first-party sales (see tax.ts). One row per cart+seller; basis = what it was computed on.
  db.exec(`CREATE TABLE IF NOT EXISTS tax_quotes (
    cart_id TEXT NOT NULL, seller_id TEXT NOT NULL, basis TEXT NOT NULL, provider TEXT NOT NULL, tax_cents INTEGER NOT NULL,
    approximate INTEGER NOT NULL DEFAULT 0, calculation_id TEXT, order_id TEXT, transaction_id TEXT, reversal_id TEXT,
    stripe_account TEXT, created_at TEXT NOT NULL, PRIMARY KEY (cart_id, seller_id))`);
}

function addColumn(db: DatabaseSync, table: string, column: string, ddl: string): void {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (!cols.some((col) => col.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function getDb(): DatabaseSync {
  const path = config().dbPath;
  if (g.__mercavineDb && g.__mercavineDb.path === path) return g.__mercavineDb.db;
  if (g.__mercavineDb) {
    try {
      g.__mercavineDb.db.close();
    } catch {
      /* already closed */
    }
  }
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  seedIfEmpty(db);
  purgeDemoIdentities(db);
  g.__mercavineDb = { db, path };
  return db;
}

export function closeDb(): void {
  if (!g.__mercavineDb) return;
  try {
    g.__mercavineDb.db.close();
  } catch {
    /* ignore */
  }
  g.__mercavineDb = undefined;
}

let txDepth = 0;
const webhookQueue: string[] = [];

export function enqueueDelivery(id: string): void {
  webhookQueue.push(id);
}

export function transaction<T>(fn: (db: DatabaseSync) => T): T {
  const db = getDb();
  if (txDepth > 0) return fn(db);
  const mark = webhookQueue.length;
  txDepth += 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn(db);
    db.exec("COMMIT");
    txDepth -= 1;
    const ids = webhookQueue.splice(mark);
    if (ids.length) void flushDeliveries(ids);
    return result;
  } catch (error) {
    webhookQueue.splice(mark);
    try {
      db.exec("ROLLBACK");
    } catch {
      /* already rolled back */
    }
    txDepth -= 1;
    throw error;
  }
}

async function flushDeliveries(ids: string[]): Promise<void> {
  const { attemptDelivery } = await import("./webhooks");
  for (const id of ids) {
    try {
      await attemptDelivery(id);
    } catch (error) {
      console.error("webhook delivery failed", error instanceof Error ? error.message : "error");
    }
  }
}
