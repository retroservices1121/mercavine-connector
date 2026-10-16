import type { DatabaseSync } from "node:sqlite";

/** Tables for digital delivery. Idempotent; called from db.ts migrate(). No app imports (avoids a cycle with db.ts). */
export function ensureDigitalTables(db: DatabaseSync) {
  db.exec(`CREATE TABLE IF NOT EXISTS digital_assets (
    id TEXT PRIMARY KEY,
    product_id TEXT NOT NULL,
    seller_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    storage_name TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_assets_product ON digital_assets(product_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS digital_downloads (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL,
    asset_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TEXT NOT NULL,
    max_downloads INTEGER NOT NULL,
    download_count INTEGER NOT NULL DEFAULT 0,
    emailed_at TEXT,
    created_at TEXT NOT NULL
  )`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_digital_downloads_order_asset ON digital_downloads(order_id, asset_id)`);
  db.exec(`CREATE TABLE IF NOT EXISTS digital_download_log (
    id TEXT PRIMARY KEY,
    download_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    at TEXT NOT NULL,
    outcome TEXT NOT NULL
  )`);
}
