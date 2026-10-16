/**
 * Mercavine Store supplied by CJdropshipping (US warehouses only).
 * sync -> refresh -> checkout re-check -> admin-approved capture -> createOrderV2 (dry-run by default) -> tracking.
 */
import type { DatabaseSync } from "node:sqlite";
import { cj, usStock, type CjListItem } from "./cj";
import { nowIso } from "./clock";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { ensureFirstPartySeller, FIRST_PARTY_SELLER_ID } from "./first-party";
import { newId } from "./ids";
import { many, one, run } from "./sql";

// ---------- Config ----------
export function storeConfig() {
  const num = (v: string | undefined, d: number) => (v !== undefined && v !== "" && Number.isFinite(Number(v)) ? Number(v) : d);
  return {
    marginBps: num(process.env.CJ_MARGIN_BPS, 2000), // 20%
    minPriceCents: num(process.env.CJ_MIN_PRICE_CENTS, 1500), // $15
    minUsStock: num(process.env.CJ_MIN_US_STOCK, 5),
    refZip: process.env.CJ_REFERENCE_ZIP || "27601",
    ordersLive: process.env.CJ_ORDERS_LIVE === "true",
    syncMaxPages: num(process.env.CJ_SYNC_MAX_PAGES, 2),
    categoryIds: (process.env.CJ_CATEGORY_IDS || DEFAULT_CATEGORY_IDS.join(",")).split(",").map((s) => s.trim()).filter(Boolean),
  };
}

/** Tools, Lighting and Tools Storage leaf ids from product/getCategory (2026-10-16). */
export const DEFAULT_CATEGORY_IDS = [
  "55795653-09E8-4EE6-B477-1E30E7A601B2", // Hand Tools
  "7B18EF9A-B48E-4917-84AF-624919C32CA6", // Tool Sets
  "924090C3-8179-437F-8219-37582113FB08", // Tools Storage
  "9FC79C6B-AE70-472C-B8F8-D62479F0D03E", // Power Tools
  "4D7853CE-9E1C-4103-A06F-46401827A535", // Measurement & Analysis
  "2601070550031612900", // Home Improvement Materials
  "F9749558-9C47-4612-9411-88FF301DB7AD", // Solar Lamps
  "7E431502-1275-4FF3-A236-B97C107C3AFA", // Flashlights & Torches
  "AC4A8F93-27FF-4531-8394-53E97F02159D", // Wall Lamps
  "D6A70719-5E93-40E6-AE8B-A060D667A17B", // Ceiling Lights
  "B62EE40F-7650-4715-A7A5-BA227540593C", // Bathroom Storage
];

// ---------- Pricing ----------
/** price = max(min, (cost + freight) * (1 + margin)), rounded up to the cent. */
export function priceFor(costCents: number, freightCents: number, cfg = storeConfig()): number {
  const base = costCents + freightCents;
  const marked = Math.ceil((base * (10_000 + cfg.marginBps)) / 10_000);
  return Math.max(cfg.minPriceCents, marked);
}

const toCents = (v: number | string) => Math.round(Number(v) * 100);

// ---------- Filters ----------
const AUTO = /\b(fit for|fits|compatible with)\b.*\b(19|20)\d{2}\b|\b(ford|chevy|chevrolet|gmc|toyota|honda|nissan|mitsubishi|dodge|jeep|ram|subaru|hyundai|kia|mazda|bmw|audi|volkswagen|vw|lexus|acura|tesla)\b|\b(radiator|blower motor|lift kit|leveling kit|brake pad|caliper|bumper|headlight assembly|tail light assembly|control arm|tie rod|alternator)\b/i;
const BRANDS = /\b(dewalt|milwaukee|makita|bosch|ryobi|black\s*(\+|&|and)?\s*decker|craftsman|stanley|ridgid|worx|ego|kobalt|hart|husky|dremel|festool|metabo|hitachi|porter[- ]cable|skil|greenworks|klein|irwin|snap[- ]on|ryobi|anker|apple|samsung)\b/i;

export type FilterResult = { ok: true } | { ok: false; reason: "auto_parts" | "brand_name" | "low_stock" | "keyword" };
export function filterProduct(name: string, stock: number | null, cfg = storeConfig()): FilterResult {
  if (AUTO.test(name)) return { ok: false, reason: "auto_parts" };
  if (BRANDS.test(name)) return { ok: false, reason: "brand_name" };
  const extra = process.env.CJ_EXCLUDE_KEYWORDS;
  if (extra && extra.split(",").some((k) => k.trim() && name.toLowerCase().includes(k.trim().toLowerCase()))) return { ok: false, reason: "keyword" };
  if (stock !== null && stock < cfg.minUsStock) return { ok: false, reason: "low_stock" };
  return { ok: true };
}

function categorySlug(name: string): string {
  return /light|lamp|torch|flashlight/i.test(name) ? "home-improvement" : /storage/i.test(name) ? "home-improvement" : "tools";
}

// ---------- Sync ----------
export type SyncReport = { scanned: number; listed: number; updated: number; skipped: Record<string, number> };

/**
 * Pull US-warehouse products per category, filter, quote freight to the reference zip, price, and upsert
 * products/offers owned by the Mercavine Store seller. Points: 50/page + ~30 per new product.
 */
export async function syncCatalog(opts: { maxNew?: number } = {}): Promise<SyncReport> {
  ensureFirstPartySeller();
  const cfg = storeConfig();
  const report: SyncReport = { scanned: 0, listed: 0, updated: 0, skipped: {} };
  const skip = (r: string) => (report.skipped[r] = (report.skipped[r] ?? 0) + 1);
  let budget = opts.maxNew ?? 50;
  for (const categoryId of cfg.categoryIds) {
    for (let page = 1; page <= cfg.syncMaxPages; page++) {
      const res = await cj.listProducts({ categoryId, pageNum: page, pageSize: 100 });
      for (const item of res.list ?? []) {
        report.scanned++;
        const pre = filterProduct(item.productNameEn, null, cfg);
        if (!pre.ok) { skip(pre.reason); continue; }
        const known = one<{ pid: string }>(getDb(), `SELECT pid FROM supplier_products WHERE pid = ?`, item.pid);
        if (known) { await refreshOne(item.pid); report.updated++; continue; }
        if (budget <= 0) { skip("budget"); continue; }
        budget--;
        const r = await importProduct(item);
        if (r === "listed") report.listed++; else skip(r);
      }
      if ((res.list ?? []).length < 100) break;
    }
  }
  return report;
}

async function importProduct(item: CjListItem): Promise<"listed" | "low_stock" | "no_variant" | "no_freight"> {
  const cfg = storeConfig();
  const detail = await cj.product(item.pid);
  const v = detail.variants?.[0];
  if (!v) return "no_variant";
  const stock = usStock(await cj.stock(v.vid));
  if (stock < cfg.minUsStock) return "low_stock";
  const freight = await cheapestFreight(v.vid, 1, cfg.refZip);
  if (!freight) return "no_freight";
  const cost = toCents(v.variantSellPrice);
  const price = priceFor(cost, freight.cents, cfg);
  transaction((db) => {
    const productId = newId("prd");
    const offerId = newId("ofr");
    const [etaMin, etaMax] = parseAging(freight.aging);
    run(db, `INSERT INTO products (id, seller_id, title, description, category, created_at, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      productId, FIRST_PARTY_SELLER_ID, item.productNameEn.slice(0, 200), stripHtml(detail.description ?? item.productNameEn).slice(0, 2000),
      categorySlug(item.categoryName ?? ""), nowIso(), item.productImage);
    run(db, `INSERT INTO offers (id, product_id, seller_id, sku, price_cents, stock, shipping_cents, eta_min_days, eta_max_days, return_window_days)
      VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, 30)`, offerId, productId, FIRST_PARTY_SELLER_ID, `CJ-${v.variantSku ?? v.vid}`.slice(0, 64), price, stock, etaMin, etaMax);
    run(db, `INSERT INTO supplier_products (pid, vid, supplier, name, category_id, cost_cents, freight_cents, logistic_name, us_stock, price_cents, status, last_synced_at, created_at)
      VALUES (?, ?, 'cj', ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
      item.pid, v.vid, item.productNameEn, item.categoryId, cost, freight.cents, freight.name, stock, price, nowIso(), nowIso());
    run(db, `INSERT INTO supplier_product_map (offer_id, pid, vid) VALUES (?, ?, ?)`, offerId, item.pid, v.vid);
  });
  return "listed";
}

function parseAging(a?: string): [number, number] {
  const m = /(\d+)\D+(\d+)/.exec(a ?? "");
  return m ? [Number(m[1]), Number(m[2])] : [3, 7];
}
function stripHtml(s: string) { return s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }

export async function cheapestFreight(vid: string, qty: number, zip: string): Promise<{ name: string; cents: number; aging?: string } | null> {
  const opts = await cj.freight(vid, qty, zip);
  if (!opts?.length) return null;
  const best = opts.reduce((a, b) => (Number(b.logisticPrice) < Number(a.logisticPrice) ? b : a));
  return { name: best.logisticName, cents: toCents(best.logisticPrice), aging: best.logisticAging };
}

// ---------- Refresh ----------
/** Re-read cost and US stock; reprice, or pause the offer when stock drops under the floor. */
export async function refreshOne(pid: string): Promise<"active" | "paused"> {
  const cfg = storeConfig();
  const sp = one<{ vid: string; freight_cents: number }>(getDb(), `SELECT vid, freight_cents FROM supplier_products WHERE pid = ?`, pid);
  if (!sp) throw new ApiError(404, "not_found", "Unknown supplier product.");
  const detail = await cj.product(pid);
  const v = detail.variants?.find((x) => x.vid === sp.vid);
  const stock = v ? usStock(await cj.stock(sp.vid)) : 0;
  const cost = v ? toCents(v.variantSellPrice) : 0;
  const price = priceFor(cost, sp.freight_cents, cfg);
  const status = v && stock >= cfg.minUsStock ? "active" : "paused";
  transaction((db) => {
    run(db, `UPDATE supplier_products SET cost_cents = ?, us_stock = ?, price_cents = ?, status = ?, last_synced_at = ? WHERE pid = ?`, cost, stock, price, status, nowIso(), pid);
    for (const m of many<{ offer_id: string }>(db, `SELECT offer_id FROM supplier_product_map WHERE pid = ?`, pid)) {
      run(db, `UPDATE offers SET price_cents = ?, stock = ? WHERE id = ?`, price, status === "active" ? stock : 0, m.offer_id);
    }
  });
  return status;
}

export async function refreshAll(limit = 100): Promise<{ checked: number; paused: number }> {
  const rows = many<{ pid: string }>(getDb(), `SELECT pid FROM supplier_products ORDER BY last_synced_at ASC LIMIT ?`, limit);
  let paused = 0;
  for (const r of rows) if ((await refreshOne(r.pid)) === "paused") paused++;
  return { checked: rows.length, paused };
}

// ---------- Checkout re-check ----------
type Line = { offer_id: string | null; quantity: number; unit_price_cents: number };
/** Before a payment session is created: live US stock must cover qty and the price must not have risen. */
export async function recheckCart(db: DatabaseSync, cartId: string): Promise<void> {
  const lines = many<Line & { vid: string; pid: string }>(db,
    `SELECT l.offer_id, l.quantity, l.unit_price_cents, m.vid, m.pid FROM cart_lines l JOIN supplier_product_map m ON m.offer_id = l.offer_id WHERE l.cart_id = ?`, cartId);
  for (const l of lines) {
    const stock = usStock(await cj.stock(l.vid));
    if (stock < l.quantity) {
      run(db, `UPDATE offers SET stock = ? WHERE id = ?`, stock, l.offer_id);
      throw new ApiError(409, "insufficient_stock", "An item from Mercavine Store just sold out at the warehouse. Nothing was charged.");
    }
    const detail = await cj.product(l.pid);
    const v = detail.variants?.find((x) => x.vid === l.vid);
    const sp = one<{ freight_cents: number }>(db, `SELECT freight_cents FROM supplier_products WHERE pid = ?`, l.pid);
    const price = v ? priceFor(toCents(v.variantSellPrice), sp?.freight_cents ?? 0) : Infinity;
    if (price > l.unit_price_cents) {
      if (Number.isFinite(price)) run(db, `UPDATE offers SET price_cents = ? WHERE id = ?`, price, l.offer_id);
      throw new ApiError(409, "price_changed", "The supplier price changed. Ask your bot to refresh the cart. Nothing was charged.");
    }
  }
}

/**
 * Checkout prep for Mercavine Store lines, before a PaymentIntent is created: re-check CJ stock and
 * price, then (re)compute sales tax on the exact basis quote() uses. A changed basis forces a new
 * calculation; an unchanged one reuses the stored quote.
 */
export async function prepareCheckout(cartId: string): Promise<void> {
  const db = getDb();
  await recheckCart(db, cartId);
  const { taxBasis } = await import("./cart");
  const { calculateTax } = await import("./tax");
  const { firstPartyRouting } = await import("./first-party");
  const cart = one<{ shipping_address_id: string | null }>(db, `SELECT shipping_address_id FROM carts WHERE id = ?`, cartId);
  const address = cart?.shipping_address_id ? one<Parameters<typeof taxBasis>[2] & object>(db, `SELECT * FROM addresses WHERE id = ?`, cart.shipping_address_id) : undefined;
  if (!address) throw new ApiError(422, "address_required", "Add a shipping address so we can calculate sales tax.");
  const lines = many<{ id: string; unit_price_cents: number; quantity: number; shipping_cents: number }>(db,
    `SELECT id, unit_price_cents, quantity, shipping_cents FROM cart_lines WHERE cart_id = ? AND seller_id = ? AND status != 'unavailable'`, cartId, FIRST_PARTY_SELLER_ID);
  if (!lines.length) return;
  const subtotal = lines.reduce((n, l) => n + l.unit_price_cents * l.quantity, 0);
  const shipping = lines.reduce((n, l) => n + l.shipping_cents, 0);
  const basis = taxBasis(subtotal, shipping, address);
  const existing = one<{ basis: string }>(db, `SELECT basis FROM tax_quotes WHERE cart_id = ? AND seller_id = ?`, cartId, FIRST_PARTY_SELLER_ID);
  if (existing?.basis === basis) return;
  const route = firstPartyRouting();
  const result = await calculateTax({
    reference: cartId,
    address: address as unknown as Parameters<typeof calculateTax>[0]["address"],
    lines: lines.map((l) => ({ reference: l.id, amountCents: l.unit_price_cents * l.quantity, quantity: l.quantity })),
    shippingCents: shipping,
    stripeAccount: route.stripeAccountId,
  });
  run(db, `INSERT INTO tax_quotes (cart_id, seller_id, basis, provider, tax_cents, approximate, calculation_id, stripe_account, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(cart_id, seller_id) DO UPDATE SET basis = excluded.basis, provider = excluded.provider, tax_cents = excluded.tax_cents,
      approximate = excluded.approximate, calculation_id = excluded.calculation_id, stripe_account = excluded.stripe_account, created_at = excluded.created_at`,
    cartId, FIRST_PARTY_SELLER_ID, basis, result.provider, result.taxCents, result.approximate ? 1 : 0, result.calculationId, route.stripeAccountId, nowIso());
}

/** After capture: turn the Stripe Tax calculation into a recorded transaction. Never blocks fulfillment. */
export async function commitTaxFor(cartId: string): Promise<string | null> {
  const db = getDb();
  const tq = one<{ calculation_id: string | null; transaction_id: string | null; stripe_account: string }>(db,
    `SELECT calculation_id, transaction_id, stripe_account FROM tax_quotes WHERE cart_id = ? AND seller_id = ?`, cartId, FIRST_PARTY_SELLER_ID);
  const order = one<{ id: string }>(db, `SELECT id FROM orders WHERE cart_id = ? AND seller_id = ?`, cartId, FIRST_PARTY_SELLER_ID);
  if (!tq?.calculation_id || tq.transaction_id || !order) return tq?.transaction_id ?? null;
  const { commitTax } = await import("./tax");
  try {
    const id = await commitTax(tq.calculation_id, order.id, tq.stripe_account);
    run(db, `UPDATE tax_quotes SET transaction_id = ?, order_id = ? WHERE cart_id = ? AND seller_id = ?`, id, order.id, cartId, FIRST_PARTY_SELLER_ID);
    return id;
  } catch (e) {
    console.error("tax transaction failed", (e as Error).message);
    run(db, `UPDATE tax_quotes SET order_id = ?, transaction_id = NULL WHERE cart_id = ? AND seller_id = ?`, order.id, cartId, FIRST_PARTY_SELLER_ID);
    return null;
  }
}

/** Full refund of a first-party order: reverse the Stripe Tax transaction (idempotent). */
export async function reverseTaxForPaymentIntent(paymentIntentId: string): Promise<string | null> {
  const db = getDb();
  const row = one<{ cart_id: string; order_id: string; transaction_id: string | null; reversal_id: string | null; stripe_account: string }>(db,
    `SELECT t.cart_id, o.id AS order_id, t.transaction_id, t.reversal_id, t.stripe_account FROM orders o JOIN tax_quotes t ON t.cart_id = o.cart_id AND t.seller_id = o.seller_id WHERE o.stripe_payment_intent_id = ?`, paymentIntentId);
  if (!row?.transaction_id || row.reversal_id) return row?.reversal_id ?? null;
  const { reverseTax } = await import("./tax");
  const id = await reverseTax(row.transaction_id, row.order_id, row.stripe_account);
  run(db, `UPDATE tax_quotes SET reversal_id = ? WHERE cart_id = ? AND seller_id = ?`, id, row.cart_id, FIRST_PARTY_SELLER_ID);
  return id;
}

export function cartHasFirstParty(db: DatabaseSync, cartId: string): boolean {
  return Boolean(one(db, `SELECT 1 FROM cart_lines WHERE cart_id = ? AND seller_id = ? LIMIT 1`, cartId, FIRST_PARTY_SELLER_ID));
}

// ---------- Approval gate ----------
/** Called when a first-party cart is fully authorized. Creates the pending row once (dedupe on cart_id). */
export function queueForApproval(db: DatabaseSync, cartId: string): void {
  run(db, `INSERT OR IGNORE INTO supplier_orders (id, cart_id, supplier, status, dedupe_key, created_at, updated_at)
    VALUES (?, ?, 'cj', 'pending_approval', ?, ?, ?)`, newId("spo"), cartId, `mv-${cartId}`, nowIso(), nowIso());
}

export function captureAllowed(db: DatabaseSync, cartId: string): boolean {
  const row = one<{ status: string }>(db, `SELECT status FROM supplier_orders WHERE cart_id = ?`, cartId);
  return row !== undefined && row.status !== "pending_approval" && row.status !== "rejected";
}

export function listSupplierOrders(status?: string) {
  return many(getDb(), `SELECT * FROM supplier_orders ${status ? "WHERE status = ?" : ""} ORDER BY created_at DESC LIMIT 200`, ...(status ? [status] : []));
}

/**
 * Admin approval: re-check stock, capture the payment, then create the CJ order (dry-run unless
 * CJ_ORDERS_LIVE=true). Order creation never runs before capture succeeds.
 */
export async function approveSupplierOrder(id: string, admin: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const so = one<{ cart_id: string; status: string }>(db, `SELECT cart_id, status FROM supplier_orders WHERE id = ?`, id);
  if (!so) throw new ApiError(404, "not_found", "Unknown supplier order.");
  if (so.status !== "pending_approval") throw new ApiError(409, "invalid_state", `Supplier order is ${so.status}.`);
  const lines = many<{ vid: string; quantity: number }>(db,
    `SELECT m.vid, l.quantity FROM cart_lines l JOIN supplier_product_map m ON m.offer_id = l.offer_id WHERE l.cart_id = ?`, so.cart_id);
  for (const l of lines) {
    if (usStock(await cj.stock(l.vid)) < l.quantity) throw new ApiError(409, "insufficient_stock", "Warehouse stock no longer covers this order. Reject it to release the hold.");
  }
  run(db, `UPDATE supplier_orders SET status = 'approved', approved_by = ?, approved_at = ?, updated_at = ? WHERE id = ?`, admin, nowIso(), nowIso(), id);
  const { settleCardCart } = await import("./cart");
  const paid = await settleCardCart(so.cart_id);
  if (!paid) {
    run(db, `UPDATE supplier_orders SET status = 'capture_failed', updated_at = ? WHERE id = ?`, nowIso(), id);
    throw new ApiError(402, "capture_failed", "Payment capture did not complete. No supplier order was created.");
  }
  await commitTaxFor(so.cart_id);
  return placeSupplierOrder(id);
}

export async function rejectSupplierOrder(id: string, admin: string, reason: string): Promise<void> {
  const db = getDb();
  const so = one<{ cart_id: string; status: string }>(db, `SELECT cart_id, status FROM supplier_orders WHERE id = ?`, id);
  if (!so) throw new ApiError(404, "not_found", "Unknown supplier order.");
  if (so.status !== "pending_approval") throw new ApiError(409, "invalid_state", `Supplier order is ${so.status}.`);
  const { stripeCardClient, applyIntentStatus } = await import("./payments");
  const stripe = await stripeCardClient();
  for (const a of many<{ provider_id: string; stripe_account_id: string }>(db, `SELECT provider_id, stripe_account_id FROM payment_attempts WHERE cart_id = ? AND status = 'authorized'`, so.cart_id)) {
    await stripe.cancelIntent(a.provider_id, { stripeAccount: a.stripe_account_id });
    applyIntentStatus(db, a.provider_id, "canceled");
  }
  run(db, `UPDATE supplier_orders SET status = 'rejected', approved_by = ?, detail = ?, updated_at = ? WHERE id = ?`, admin, reason.slice(0, 500), nowIso(), id);
}

/** Build and (if live) send createOrderV2. Dedupe: orderNumber = dedupe_key and status guard. */
export async function placeSupplierOrder(id: string): Promise<Record<string, unknown>> {
  const db = getDb();
  const so = one<{ cart_id: string; status: string; dedupe_key: string; cj_order_id: string | null }>(db, `SELECT * FROM supplier_orders WHERE id = ?`, id)!;
  if (so.cj_order_id || so.status === "placed" || so.status === "dry_run") return { id, status: so.status, cj_order_id: so.cj_order_id, deduped: true };
  if (so.status !== "approved") throw new ApiError(409, "invalid_state", "Supplier order must be approved and captured first.");
  const captured = one(db, `SELECT 1 FROM payment_attempts WHERE cart_id = ? AND status = 'captured' LIMIT 1`, so.cart_id);
  if (!captured) throw new ApiError(409, "not_captured", "Payment is not captured. No supplier order was created.");
  const body = buildOrderBody(db, so.cart_id, so.dedupe_key);
  const order = one<{ id: string }>(db, `SELECT id FROM orders WHERE cart_id = ? AND seller_id = ?`, so.cart_id, FIRST_PARTY_SELLER_ID);
  if (!storeConfig().ordersLive) {
    run(db, `UPDATE supplier_orders SET status = 'dry_run', order_id = ?, request_json = ?, updated_at = ? WHERE id = ?`, order?.id ?? null, JSON.stringify(body), nowIso(), id);
    return { id, status: "dry_run", request: body };
  }
  // Claim before calling so a concurrent approve cannot double-send.
  const claim = db.prepare(`UPDATE supplier_orders SET status = 'placing', updated_at = ? WHERE id = ? AND status = 'approved'`).run(nowIso(), id);
  if (claim.changes !== 1) return { id, deduped: true };
  try {
    const res = await cj.createOrderV2(body);
    run(db, `UPDATE supplier_orders SET status = 'placed', cj_order_id = ?, order_id = ?, request_json = ?, updated_at = ? WHERE id = ?`, res.orderId, order?.id ?? null, JSON.stringify(body), nowIso(), id);
    return { id, status: "placed", cj_order_id: res.orderId };
  } catch (e) {
    run(db, `UPDATE supplier_orders SET status = 'place_failed', detail = ?, updated_at = ? WHERE id = ?`, String((e as Error).message).slice(0, 500), nowIso(), id);
    throw e;
  }
}

export function buildOrderBody(db: DatabaseSync, cartId: string, orderNumber: string) {
  const addr = one<{ recipient: string; line1: string; line2: string | null; city: string; region: string; postal_code: string; country: string }>(db,
    `SELECT a.* FROM carts c JOIN addresses a ON a.id = c.shipping_address_id WHERE c.id = ?`, cartId);
  if (!addr) throw new ApiError(422, "address_required", "Cart has no shipping address.");
  const lines = many<{ vid: string; quantity: number; line_id: string; logistic_name: string }>(db,
    `SELECT m.vid, l.quantity, l.id AS line_id, sp.logistic_name FROM cart_lines l JOIN supplier_product_map m ON m.offer_id = l.offer_id JOIN supplier_products sp ON sp.pid = m.pid WHERE l.cart_id = ?`, cartId);
  return {
    orderNumber,
    shippingCountryCode: addr.country || "US",
    shippingCountry: "United States",
    shippingProvince: addr.region,
    shippingCity: addr.city,
    shippingZip: addr.postal_code,
    shippingCustomerName: addr.recipient.slice(0, 50),
    shippingAddress: addr.line1,
    shippingAddress2: addr.line2 ?? "",
    fromCountryCode: "US",
    logisticName: lines[0]?.logistic_name ?? "",
    payType: 3, // create only: no wallet deduction. Paying in CJ stays a manual step.
    platform: "Api",
    products: lines.map((l) => ({ vid: l.vid, quantity: l.quantity, storeLineItemId: l.line_id })),
  };
}

// ---------- Tracking ----------
export async function syncTracking(): Promise<{ checked: number; shipped: number }> {
  const db = getDb();
  const rows = many<{ id: string; cj_order_id: string; order_id: string | null }>(db,
    `SELECT id, cj_order_id, order_id FROM supplier_orders WHERE status = 'placed' AND cj_order_id IS NOT NULL`);
  let shipped = 0;
  for (const r of rows) {
    const d = await cj.orderDetail(r.cj_order_id);
    run(db, `UPDATE supplier_orders SET cj_status = ?, tracking_number = ?, tracking_url = ?, updated_at = ? WHERE id = ?`,
      d.orderStatus, d.trackNumber ?? null, d.trackingUrl ?? null, nowIso(), r.id);
    if (d.trackNumber && r.order_id) {
      const { markShipped } = await import("./orders");
      const o = one<{ tracking_number: string | null }>(db, `SELECT tracking_number FROM orders WHERE id = ?`, r.order_id);
      if (!o?.tracking_number) { markShipped(r.order_id, d.logisticName || d.trackingProvider || "carrier", d.trackNumber); shipped++; }
    }
  }
  return { checked: rows.length, shipped };
}
