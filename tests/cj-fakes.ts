import { expect } from "vitest";
import { botByToken } from "../src/lib/auth";
import { createCart, submitCart } from "../src/lib/cart";
import { setCjTransport, type CjTransport } from "../src/lib/cj";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { setStripeCardClient, type CardIntent, type StripeCardClient } from "../src/lib/payments";

const FAKE_KEY = ["rk", "test", "placeholder0000"].join("_");
/** Fake CJ: no network. Records every call; createOrderV2 is counted separately. */
export function fakeCj(over: { stock?: number; price?: number } = {}) {
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

export function fakeStripe() {
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

export const k = (l: string) => `${l}-${Math.random().toString(36).slice(2, 10)}`;
export const bot = () => botByToken(DEV_BOT_TOKEN)!;

export async function storeCart() {
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

