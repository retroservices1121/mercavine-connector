/**
 * Digital file delivery. Files live privately next to the SQLite database
 * (dirname(MERCAVINE_DB_PATH)/digital-assets), never under public/.
 * After payment, each paid digital order gets one download link per file:
 * a random token (only its sha256 is stored), 72h expiry, 5 downloads max.
 */
import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, statSync, writeFileSync, unlinkSync, existsSync } from "node:fs";
import { dirname, extname, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { newId, sha256 } from "./ids";
import { sendMail } from "./mailer";
import { many, one, run } from "./sql";
import { nowIso, now } from "./clock";
export { ensureDigitalTables } from "./digital-schema";

export const DOWNLOAD_TTL_HOURS = 72;
export const MAX_DOWNLOADS = 5;
export const MAX_ASSET_BYTES = Number(process.env.DIGITAL_MAX_BYTES) > 0 ? Number(process.env.DIGITAL_MAX_BYTES) : 100 * 1024 * 1024;

/** Allowed upload types by extension. Executables and HTML/SVG (scriptable) are refused. */
const ALLOWED: Record<string, string> = {
  ".pdf": "application/pdf",
  ".epub": "application/epub+zip",
  ".zip": "application/zip",
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export const BLOCKED_PAYMENT_STATUSES = ["refunded", "partially_refunded", "disputed"];

export function assetsDir(): string {
  return join(dirname(config().dbPath), "digital-assets");
}

export function assetPath(storageName: string): string {
  if (!/^[a-z0-9_]+$/i.test(storageName)) throw new Error("bad storage name");
  return join(assetsDir(), storageName);
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "download";
  const cleaned = base.replace(/[^\w.\- ]+/g, "_").replace(/^\.+/, "").slice(0, 120).trim();
  return cleaned || "download";
}

export type AssetSummary = { filename: string; size_bytes: number; sha256: string; content_type: string };

export function assetForProduct(productId: string, db: DatabaseSync = getDb()): AssetSummary | null {
  return one<AssetSummary>(db, `SELECT filename, size_bytes, sha256, content_type FROM digital_assets WHERE product_id = ?`, productId) ?? null;
}

/** Store (or replace) the one file for a seller's digital product. */
export function saveDigitalAsset(input: { sellerId: string; productId: string; filename: string; bytes: Uint8Array }): AssetSummary {
  const filename = safeFilename(input.filename);
  const ext = extname(filename).toLowerCase();
  const contentType = ALLOWED[ext];
  if (!contentType) throw new ApiError(422, "invalid_file", `That file type isn't allowed. Use one of: ${Object.keys(ALLOWED).join(", ")}.`);
  if (input.bytes.byteLength === 0) throw new ApiError(422, "invalid_file", "The file is empty.");
  if (input.bytes.byteLength > MAX_ASSET_BYTES) throw new ApiError(413, "file_too_large", `Files can be up to ${Math.round(MAX_ASSET_BYTES / 1024 / 1024)} MB.`);
  const db = getDb();
  const product = one<{ id: string; fulfillment_type: string }>(
    db,
    `SELECT p.id, o.fulfillment_type FROM products p JOIN offers o ON o.product_id = p.id WHERE p.id = ? AND p.seller_id = ?`,
    input.productId,
    input.sellerId,
  );
  if (!product) throw new ApiError(404, "not_found", "Product not found.");
  if (product.fulfillment_type !== "digital") throw new ApiError(422, "not_digital", "Set this listing to Digital download before uploading a file.");
  const digest = createHash("sha256").update(input.bytes).digest("hex");
  const storageName = newId("dga").replace(/[^a-z0-9_]/gi, "_");
  mkdirSync(assetsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(assetPath(storageName), input.bytes, { mode: 0o600 });
  const previous = one<{ storage_name: string }>(db, `SELECT storage_name FROM digital_assets WHERE product_id = ?`, input.productId);
  transaction((tx) => {
    run(tx, `DELETE FROM digital_assets WHERE product_id = ?`, input.productId);
    run(
      tx,
      `INSERT INTO digital_assets (id, product_id, seller_id, filename, content_type, size_bytes, sha256, storage_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      newId("dga"), input.productId, input.sellerId, filename, contentType, input.bytes.byteLength, digest, storageName, nowIso(),
    );
  });
  // Links reference the asset row, which was just replaced, so the old file is unreachable. Remove it.
  if (previous && previous.storage_name !== storageName) {
    try { unlinkSync(assetPath(previous.storage_name)); } catch { /* already gone */ }
  }
  return { filename, size_bytes: input.bytes.byteLength, sha256: digest, content_type: contentType };
}

type Pending = { order_id: string; user_id: string; asset_id: string; filename: string; title: string };

/**
 * Mint links for every paid digital order on a cart and email them. Idempotent:
 * a link row exists at most once per (order, file), and email goes out only for rows not yet emailed.
 */
export async function deliverDigitalForCart(cartId: string): Promise<{ minted: number; emailed: number }> {
  const db = getDb();
  const fresh: { raw: string; row: Pending }[] = [];
  transaction((tx) => {
    const pending = many<Pending>(
      tx,
      `SELECT o.id AS order_id, o.user_id, a.id AS asset_id, a.filename, ol.title
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       JOIN cart_lines cl ON cl.id = ol.cart_line_id
       JOIN offers f ON f.id = cl.offer_id
       JOIN digital_assets a ON a.product_id = f.product_id
       WHERE o.cart_id = ? AND o.fulfillment_type = 'digital' AND o.payment_status = 'paid'
         AND NOT EXISTS (SELECT 1 FROM digital_downloads d WHERE d.order_id = o.id AND d.asset_id = a.id)`,
      cartId,
    );
    for (const row of pending) {
      const raw = `dl_${randomBytes(32).toString("base64url")}`;
      const expires = new Date(now().getTime() + DOWNLOAD_TTL_HOURS * 3600_000).toISOString();
      run(
        tx,
        `INSERT INTO digital_downloads (id, order_id, asset_id, user_id, token_hash, expires_at, max_downloads, download_count, emailed_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)`,
        newId("dld"), row.order_id, row.asset_id, row.user_id, sha256(raw), expires, MAX_DOWNLOADS, nowIso(),
      );
      fresh.push({ raw, row });
    }
  });
  let emailed = 0;
  const byUser = new Map<string, { raw: string; row: Pending }[]>();
  for (const item of fresh) byUser.set(item.row.user_id, [...(byUser.get(item.row.user_id) ?? []), item]);
  for (const [userId, items] of byUser) {
    const user = one<{ email: string }>(db, `SELECT email FROM users WHERE id = ?`, userId);
    if (!user) continue;
    const base = config().publicBaseUrl;
    const list = items.map((item) => `${item.row.title} (${item.row.filename}):\n${base}/dl/${item.raw}`).join("\n\n");
    const result = await sendMail({
      to: user.email,
      subject: "Your Mercavine download is ready",
      tag: "digital_delivery",
      text:
        `Thanks for your order. Your download${items.length > 1 ? "s are" : " is"} below.\n\n${list}\n\n` +
        `Each link works ${MAX_DOWNLOADS} times and expires in ${DOWNLOAD_TTL_HOURS} hours. Don't share it.\n` +
        `Digital items can't be returned once downloaded.`,
    });
    if (result.delivered) {
      emailed += items.length;
      transaction((tx) => {
        for (const item of items) run(tx, `UPDATE digital_downloads SET emailed_at = ? WHERE token_hash = ?`, nowIso(), sha256(item.raw));
      });
    }
  }
  return { minted: fresh.length, emailed };
}

/** Never let delivery failures break payment settlement. */
export async function deliverDigitalSafely(cartId: string) {
  try {
    await deliverDigitalForCart(cartId);
  } catch (error) {
    console.warn(`[digital] delivery failed for ${cartId}: ${error instanceof Error ? error.message : "unknown"}`);
  }
}

export type DownloadGrant = { path: string; filename: string; contentType: string; size: number };

/**
 * Check a raw download token and consume one download. Throws ApiError with a reason when blocked.
 * The order is marked 'fulfilled' on the first successful download.
 */
export function consumeDownload(rawToken: string): DownloadGrant {
  if (!/^dl_[A-Za-z0-9_-]{20,}$/.test(rawToken)) throw new ApiError(404, "not_found", "This download link isn't valid.");
  // Blocked attempts are logged too, so the transaction returns the error instead of throwing (which would roll back the log).
  const result = transaction((db): DownloadGrant | ApiError => {
    const row = one<{
      id: string; order_id: string; expires_at: string; max_downloads: number; download_count: number;
      storage_name: string; filename: string; content_type: string;
      payment_status: string; status: string; user_id: string; bot_client_id: string; cart_id: string;
    }>(
      db,
      `SELECT d.id, d.order_id, d.expires_at, d.max_downloads, d.download_count,
              a.storage_name, a.filename, a.content_type,
              o.payment_status, o.status, o.user_id, o.bot_client_id, o.cart_id
       FROM digital_downloads d JOIN digital_assets a ON a.id = d.asset_id JOIN orders o ON o.id = d.order_id
       WHERE d.token_hash = ?`,
      sha256(rawToken),
    );
    if (!row) return new ApiError(404, "not_found", "This download link isn't valid.");
    const log = (outcome: string) =>
      run(db, `INSERT INTO digital_download_log (id, download_id, order_id, at, outcome) VALUES (?, ?, ?, ?, ?)`, newId("dll"), row.id, row.order_id, nowIso(), outcome);
    if (BLOCKED_PAYMENT_STATUSES.includes(row.payment_status) || ["cancelled", "refunded"].includes(row.status)) {
      log("blocked_payment");
      return new ApiError(403, "download_blocked", "This order was refunded or disputed, so the download is no longer available.");
    }
    if (row.expires_at <= nowIso()) {
      log("expired");
      return new ApiError(410, "download_expired", "This download link has expired. Contact the seller for a new one.");
    }
    if (row.download_count >= row.max_downloads) {
      log("limit");
      return new ApiError(410, "download_limit", "This link has reached its download limit.");
    }
    const path = assetPath(row.storage_name);
    if (!existsSync(path)) {
      log("missing_file");
      return new ApiError(404, "file_missing", "The seller's file is unavailable. Contact the seller.");
    }
    run(db, `UPDATE digital_downloads SET download_count = download_count + 1 WHERE id = ?`, row.id);
    log("ok");
    if (row.status === "created") {
      run(db, `UPDATE orders SET status = 'fulfilled', updated_at = ? WHERE id = ?`, nowIso(), row.order_id);
    }
    return { path, filename: row.filename, contentType: row.content_type, size: statSync(path).size };
  });
  if (result instanceof ApiError) throw result;
  return result;
}
