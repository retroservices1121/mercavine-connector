import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, settleCardCart, submitCart } from "../src/lib/cart";
import { cjCall, pointsUsedToday, setCjTransport, type CjTransport } from "../src/lib/cj";
import { approveSupplierOrder, filterProduct, placeSupplierOrder, priceFor, rejectSupplierOrder, storeConfig, syncCatalog, syncTracking } from "../src/lib/cj-store";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { FIRST_PARTY_SELLER_ID } from "../src/lib/first-party";
import { applyIntentStatus, setStripeCardClient, type CardIntent, type StripeCardClient } from "../src/lib/payments";
import { handleApi } from "../src/lib/api";
import { useTempDb } from "./db";

const FAKE_KEY = ["rk", "test", "placeholder0000"].join("_");
const ADMIN = "admin-token-placeholder-0123456789";

/** Fake CJ: no network. Records every call; createOrderV2 is counted separately. */
function fakeCj(over: { stock?: number; price?: number } = {}) {
  const calls: string[] = [];
  const state = { stock: over.stock ?? 40, price: over.price ?? 10, orders: 0, tokenCalls: 0, expireOnce: false, track: null as string | null };
  const items = [
    { pid: "p1", productNameEn: "Steel Pry Bar Set 3pc", productSku: "S1", productImage: "https://img/p1.jpg", productWeight: "500", productType: "SUPPLIER_SHIPPED_PRODUCT", categoryName: "Hand Tools", categoryId: "c1", sellPrice: "10.00" },
    { pid: "p2", productNameEn: "Aluminum Radiator fit for Mitsubishi Outlander 2022", productSku: "S2", productImage: "", productWeight: "1", productType: "x", categoryName: "Hand Tools", categoryId: "c1", sellPrice: "90" },
    { pid: "p3", productNameEn: "Battery Adapter for DeWalt 20V", productSku: "S3", productImage: "", productWeight: "1", productType: "x", categoryName: "Hand Tools", categoryId: "c1", sellPrice: "9" },
  ];
  const t: CjTransport = async ({ path, query, body, token }) => {
    calls.push(path);
    if (path === "authentication/getAccessToken") { state.tokenCalls++; return { code: 200, message: "ok", data: { accessToken: `tok${state.tokenCalls}`, accessTokenExpiryDate: "2099-01-01T00:00:00Z" } }; }
    if (!token) return { code: 1600001, message: "no token", data: null };
    if (state.expireOnce) { state.expireOnce = false; return { code: 1600001, message: "expired", data: null }; }
    switch (path) {
      case "product/list": return { code: 200, message: "ok", data: { total: items.length, list: items } };
      case "product/query": return { code: 200, message: "ok", data: { pid: query!.pid, productNameEn: "x", productImage: "", description: "<p>Good bar</p>", variants: [{ vid: `v-${query!.pid}`, variantSku: `SKU-${query!.pid}`, variantSellPrice: state.price }] } };
      case "product/stock/queryByVid": return { code: 200, message: "ok", data: [{ vid: query!.vid, countryCode: "US", totalInventoryNum: state.stock }, { vid: query!.vid, countryCode: "CN", totalInventoryNum: 999 }] };
      case "logistic/freightCalculate": return { code: 200, message: "ok", data: [{ logisticName: "UPS US to US", logisticPrice: 2.5, logisticAging: "3-5" }, { logisticName: "USPS US to US", logisticPrice: 0, logisticAging: "3-7" }] };
      case "shopping/order/createOrderV2": state.orders++; expect((body as { payType: number }).payType).toBe(3); return { code: 200, message: "ok", data: { orderId: "CJ-ORDER-1" } };
      case "shopping/order/getOrderDetail": return { code: 200, message: "ok", data: { orderId: query!.orderId, orderStatus: state.track ? "SHIPPED" : "UNSHIPPED", trackNumber: state.track, logisticName: "USPS" } };
    }
    return { code: 404, message: "unknown", data: null };
  };
  setCjTransport(t, 0);
  return { calls, state };
}

function fakeStripe() {
  const intents = new Map<string, CardIntent>();
  const created: { params: Record<string, unknown>; opts: { stripeAccount: string } }[] = [];
  const captured: string[] = [];
  let n = 0;
  const client: StripeCardClient = {
    async createIntent(params, opts) { created.push({ params, opts }); const id = `pi_fp_${++n}`; const i = { id, status: "requires_payment_method", client_secret: `${id}_secret`, amount: params.amount as number }; intents.set(id, i); return i; },
    async retrieveIntent(id) { return intents.get(id)!; },
    async captureIntent(id) { captured.push(id); const i = intents.get(id)!; i.status = "succeeded"; return i; },
    async cancelIntent(id) { intents.get(id)!.status = "canceled"; return {}; },
  };
  setStripeCardClient(client);
  return { intents, created, captured };
}

const k = (l: string) => `${l}-${Math.random().toString(36).slice(2, 10)}`;
const bot = () => botByToken(DEV_BOT_TOKEN)!;

async function storeCart() {
  const offer = getDb().prepare(`SELECT offer_id FROM supplier_product_map WHERE pid = 'p1'`).get() as { offer_id: string };
  const created = createCart({ bot: bot(), lines: [{ offer_id: offer.offer_id, quantity: 1 }], shippingAddressId: "adr_home", idempotencyKey: k("c") });
  if (created.status >= 300) throw new Error(JSON.stringify(created.body));
  const cartId = (created.body as { id: string }).id;
  process.env.PAYMENT_MODE = "live";
  process.env.STRIPE_SECRET_KEY = FAKE_KEY;
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
  const submitted = submitCart({ bot: bot(), cartId, idempotencyKey: k("s") }).body as Record<string, unknown>;
  return { cartId, raw: String(submitted.approval_url).split("/a/")[1] };
}

describe("Mercavine Store (CJdropshipping)", () => {
  useTempDb();
  beforeEach(() => {
    process.env.CJ_API_KEY = "cj-key-placeholder";
    process.env.MERCAVINE_STORE_ENABLED = "true";
    delete process.env.CJ_ORDERS_LIVE;
    delete process.env.CJ_MARGIN_BPS;
    delete process.env.CJ_MIN_PRICE_CENTS;
    process.env.CJ_CATEGORY_IDS = "c1";
    process.env.CJ_SYNC_MAX_PAGES = "1";
  });
  afterEach(() => {
    setCjTransport(null);
    setStripeCardClient(null);
    for (const v of ["CJ_API_KEY", "MERCAVINE_STORE_ENABLED", "CJ_CATEGORY_IDS", "CJ_SYNC_MAX_PAGES", "CJ_ORDERS_LIVE", "STRIPE_PUBLISHABLE_KEY", "MERCAVINE_ADMIN_TOKEN"]) delete process.env[v];
  });

  it("prices at cost+freight plus a configurable margin with a configurable minimum", () => {
    expect(priceFor(1000, 0)).toBe(1500); // $12 < $15 floor
    expect(priceFor(4160, 0)).toBe(4992); // 41.60 * 1.2
    expect(priceFor(3000, 250)).toBe(3900);
    process.env.CJ_MARGIN_BPS = "3000";
    process.env.CJ_MIN_PRICE_CENTS = "2000";
    expect(priceFor(1000, 0, storeConfig())).toBe(2000);
    expect(priceFor(5000, 0, storeConfig())).toBe(6500);
  });

  it("filters auto parts, brand names, keywords and low US stock", () => {
    expect(filterProduct("A/C Blower Motor Fan fit for Ford Escape 2013-2019", 50)).toEqual({ ok: false, reason: "auto_parts" });
    expect(filterProduct("Buffing Wheel Kit For Dremel", 50)).toEqual({ ok: false, reason: "brand_name" });
    expect(filterProduct("Black+Decker style drill bits", 50)).toEqual({ ok: false, reason: "brand_name" });
    expect(filterProduct("Solar pool lights 2 pack", 4)).toEqual({ ok: false, reason: "low_stock" });
    expect(filterProduct("Solar pool lights 2 pack", 5)).toEqual({ ok: true });
    process.env.CJ_EXCLUDE_KEYWORDS = "laser";
    expect(filterProduct("Green laser pointer", 50)).toEqual({ ok: false, reason: "keyword" });
    delete process.env.CJ_EXCLUDE_KEYWORDS;
  });

  it("client caches the token, refreshes once on expiry, tracks points and enforces the budget", async () => {
    const cj = fakeCj();
    await cjCall("GET", "product/list");
    await cjCall("GET", "product/query", { query: { pid: "p1" } });
    expect(cj.state.tokenCalls).toBe(1);
    expect(pointsUsedToday()).toBe(60);
    cj.state.expireOnce = true;
    await cjCall("GET", "product/query", { query: { pid: "p1" } });
    expect(cj.state.tokenCalls).toBe(2);
    process.env.CJ_DAILY_POINT_BUDGET = "100";
    await expect(cjCall("GET", "product/list")).rejects.toThrow(/budget/);
    delete process.env.CJ_DAILY_POINT_BUDGET;
    // Token is never stored in plain env or returned; only in settings.
    const row = getDb().prepare(`SELECT value FROM settings WHERE key = 'cj_token'`).get() as { value: string };
    expect(JSON.parse(row.value).accessToken).toBe("tok2");
  });

  it("throttles to one request per interval", async () => {
    fakeCj();
    setCjTransport((await import("../src/lib/cj")).CJ_BASE ? (async (i) => ({ code: 200, message: "ok", data: i.path === "authentication/getAccessToken" ? { accessToken: "t", accessTokenExpiryDate: "2099-01-01T00:00:00Z" } : {} })) : null, 120);
    const t0 = Date.now();
    await Promise.all([cjCall("GET", "product/query"), cjCall("GET", "product/query"), cjCall("GET", "product/query")]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(3 * 120 - 20);
  });

  it("sync lists only clean US-stock items under the Mercavine Store seller with the cheapest freight", async () => {
    fakeCj();
    const report = await syncCatalog();
    expect(report).toMatchObject({ scanned: 3, listed: 1, skipped: { auto_parts: 1, brand_name: 1 } });
    const offer = getDb().prepare(`SELECT o.price_cents, o.stock, o.seller_id, s.first_party, sp.logistic_name FROM supplier_product_map m JOIN offers o ON o.id = m.offer_id JOIN sellers s ON s.id = o.seller_id JOIN supplier_products sp ON sp.pid = m.pid`).get();
    expect(offer).toMatchObject({ price_cents: 1500, stock: 40, seller_id: FIRST_PARTY_SELLER_ID, first_party: 1, logistic_name: "USPS US to US" });
    // A second sync refreshes instead of duplicating.
    expect((await syncCatalog()).updated).toBe(1);
    expect((getDb().prepare(`SELECT COUNT(*) n FROM supplier_products`).get() as { n: number }).n).toBe(1);
  });

  it("low-stock refresh pauses the offer; store hidden when disabled", async () => {
    const cj = fakeCj();
    await syncCatalog();
    cj.state.stock = 2;
    const { refreshAll } = await import("../src/lib/cj-store");
    expect(await refreshAll()).toMatchObject({ checked: 1, paused: 1 });
    expect((getDb().prepare(`SELECT stock FROM offers WHERE seller_id = ?`).get(FIRST_PARTY_SELLER_ID) as { stock: number }).stock).toBe(0);
    const { sellerVisibleSql } = await import("../src/lib/catalog");
    process.env.MERCAVINE_STORE_ENABLED = "false";
    const n = getDb().prepare(`SELECT COUNT(*) n FROM sellers s WHERE s.id = ? AND ${sellerVisibleSql()}`).get(FIRST_PARTY_SELLER_ID) as { n: number };
    expect(n.n).toBe(0);
  });

  it("platform charge, no fee; capture and createOrderV2 wait for admin approval; dry-run by default; deduped", async () => {
    const cj = fakeCj();
    await syncCatalog();
    const stripe = fakeStripe();
    const { cartId, raw } = await storeCart();
    const approved = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(approved.paid).toBe(false);
    expect(stripe.created).toHaveLength(1);
    expect(stripe.created[0].opts.stripeAccount).toBe("platform");
    expect(stripe.created[0].params).not.toHaveProperty("application_fee_amount");
    expect(stripe.created[0].params).toMatchObject({ capture_method: "manual" });

    const [intent] = [...stripe.intents.values()];
    intent.status = "requires_capture";
    applyIntentStatus(getDb(), intent.id, "requires_capture");
    expect(await settleCardCart(cartId)).toBe(false);
    expect(stripe.captured).toEqual([]);
    const so = getDb().prepare(`SELECT id, status FROM supplier_orders WHERE cart_id = ?`).get(cartId) as { id: string; status: string };
    expect(so.status).toBe("pending_approval");
    expect(cj.calls).not.toContain("shopping/order/createOrderV2");
    await expect(placeSupplierOrder(so.id)).rejects.toThrow(/approved/);

    const result = await approveSupplierOrder(so.id, "jp");
    expect(stripe.captured).toEqual([intent.id]);
    expect(result).toMatchObject({ status: "dry_run" });
    expect((result.request as Record<string, unknown>)).toMatchObject({ orderNumber: `mv-${cartId}`, payType: 3, fromCountryCode: "US", logisticName: "USPS US to US", products: [{ vid: "v-p1", quantity: 1 }] });
    expect(cj.state.orders).toBe(0);
    expect((getDb().prepare(`SELECT status, application_fee_cents FROM orders WHERE cart_id = ?`).get(cartId))).toMatchObject({ status: expect.any(String), application_fee_cents: 0 });
    await expect(approveSupplierOrder(so.id, "jp")).rejects.toThrow(/dry_run/);
    expect(await placeSupplierOrder(so.id)).toMatchObject({ deduped: true });
  });

  it("live mode places exactly one CJ order after capture, then tracking marks the order shipped", async () => {
    const cj = fakeCj();
    await syncCatalog();
    const stripe = fakeStripe();
    const { cartId, raw } = await storeCart();
    await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    const [intent] = [...stripe.intents.values()];
    intent.status = "requires_capture";
    applyIntentStatus(getDb(), intent.id, "requires_capture");
    await settleCardCart(cartId);
    const so = getDb().prepare(`SELECT id FROM supplier_orders WHERE cart_id = ?`).get(cartId) as { id: string };
    process.env.CJ_ORDERS_LIVE = "true";
    expect(await approveSupplierOrder(so.id, "jp")).toMatchObject({ status: "placed", cj_order_id: "CJ-ORDER-1" });
    expect(await placeSupplierOrder(so.id)).toMatchObject({ deduped: true });
    expect(cj.state.orders).toBe(1);
    expect(cj.calls.indexOf("shopping/order/createOrderV2")).toBeGreaterThan(-1);
    expect(stripe.captured).toHaveLength(1);

    expect(await syncTracking()).toMatchObject({ checked: 1, shipped: 0 });
    cj.state.track = "9400TRACK";
    expect(await syncTracking()).toMatchObject({ shipped: 1 });
    expect(getDb().prepare(`SELECT status, tracking_number FROM orders WHERE cart_id = ?`).get(cartId)).toMatchObject({ status: "shipped", tracking_number: "9400TRACK" });
  });

  it("reject voids the authorization and never orders", async () => {
    const cj = fakeCj();
    await syncCatalog();
    const stripe = fakeStripe();
    const { cartId, raw } = await storeCart();
    await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    const [intent] = [...stripe.intents.values()];
    applyIntentStatus(getDb(), intent.id, "requires_capture");
    await settleCardCart(cartId);
    const so = getDb().prepare(`SELECT id FROM supplier_orders WHERE cart_id = ?`).get(cartId) as { id: string };
    await rejectSupplierOrder(so.id, "jp", "out of stock");
    expect(intent.status).toBe("canceled");
    expect(stripe.captured).toEqual([]);
    expect(cj.state.orders).toBe(0);
  });

  it("checkout re-check blocks payment when warehouse stock ran out", async () => {
    const cj = fakeCj();
    await syncCatalog();
    const stripe = fakeStripe();
    const { raw } = await storeCart();
    cj.state.stock = 0;
    await expect(approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" })).rejects.toThrow(/sold out/);
    expect(stripe.created).toHaveLength(0);
  });

  it("checkout re-check blocks payment when supplier price rose", async () => {
    const cj = fakeCj();
    await syncCatalog();
    const stripe = fakeStripe();
    const { raw } = await storeCart();
    cj.state.price = 20;
    await expect(approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" })).rejects.toThrow(/price changed/);
    expect(stripe.created).toHaveLength(0);
  });

  it("admin API is hidden without a token and rejects a wrong one", async () => {
    const call = (auth?: string) => handleApi(new Request("http://127.0.0.1:4317/api/v1/admin/supplier-orders", { headers: auth ? { authorization: `Bearer ${auth}` } : {} }));
    expect((await call(ADMIN)).status).toBe(404);
    process.env.MERCAVINE_ADMIN_TOKEN = ADMIN;
    expect((await call("wrong")).status).toBe(401);
    expect((await call(ADMIN)).status).toBe(200);
  });
});
