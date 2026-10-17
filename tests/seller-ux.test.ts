import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { searchNative } from "../src/lib/catalog";
import { getDb } from "../src/lib/db";
import { setStripeOnboardingClient } from "../src/lib/sellers";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["ux", "pass", "phrase"].join("-");
let ip = 0;
const req = (path: string, method: string, body?: unknown, headers: Record<string, string> = {}) =>
  handleApi(new Request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, "x-forwarded-for": `10.88.0.${++ip}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function seller(email: string, name = "Oak & Pine Goods") {
  const res = await req("/api/v1/sellers/signup", "POST", {
    business_name: name, contact_name: "Pat Seller", contact_email: email, password: PW,
    category: "tools", state: "VT", description: "Hand tools made in Vermont.", agree_terms: true,
  });
  const json = await res.json();
  return { cookie: cookieOf(res), sellerId: json.seller_id as string };
}
const product = { title: "Walnut Mallet", description: "A solid walnut mallet.", category: "tools", price: "34.50", stock: 5 };
async function addProduct(cookie: string, extra: Record<string, unknown> = {}) {
  const res = await req("/api/v1/seller/products", "POST", { ...product, ...extra }, { cookie });
  return { res, json: await res.json() };
}

/** Minimal buyer + bot + cart + order rows pointing at `offerId`, shipped to Burlington, VT. */
function fakeOrder(sellerId: string, offerId: string | null, title: string) {
  const db = getDb();
  const at = new Date().toISOString();
  const n = Math.random().toString(36).slice(2, 8);
  db.prepare(`INSERT INTO users (id, email, name, display_name, password_hash, created_at) VALUES (?, ?, 'Jane Smith', 'Jane Smith', 'x', ?)`).run(`usr_${n}`, `jane${n}@example.com`, at);
  db.prepare(`INSERT INTO addresses (id, user_id, label, recipient, line1, city, region, postal_code) VALUES (?, ?, 'Home', 'Jane Smith', '12 Elm St', 'Burlington', 'VT', '05401')`).run(`adr_${n}`, `usr_${n}`);
  db.prepare(`INSERT INTO bots (id, user_id, name, token_hash, scopes, per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents, allowed_categories, created_at)
    VALUES (?, ?, 'bot', ?, '', 0, 0, 0, 0, '', ?)`).run(`bot_${n}`, `usr_${n}`, `th_${n}`, at);
  db.prepare(`INSERT INTO carts (id, user_id, bot_client_id, status, shipping_address_id, created_at, updated_at) VALUES (?, ?, ?, 'completed', ?, ?, ?)`).run(`crt_${n}`, `usr_${n}`, `bot_${n}`, `adr_${n}`, at, at);
  db.prepare(`INSERT INTO cart_lines (id, cart_id, offer_id, seller_id, seller_name, title, quantity, unit_price_cents) VALUES (?, ?, ?, ?, 'x', ?, 2, 3450)`).run(`cl_${n}`, `crt_${n}`, offerId, sellerId, title);
  db.prepare(`INSERT INTO orders (id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents, tax_cents, total_cents, application_fee_cents, payment_status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'x', 'paid', 'usd', 6900, 0, 0, 6900, 207, 'succeeded', ?, ?)`).run(`ord_${n}`, `crt_${n}`, `usr_${n}`, `bot_${n}`, sellerId, at, at);
  db.prepare(`INSERT INTO order_lines (id, order_id, title, quantity, unit_price_cents) VALUES (?, ?, ?, 2, 3450)`).run(`ol_${n}`, `ord_${n}`, title);
  return `ord_${n}`;
}

describe("seller dashboard UX", () => {
  useTempDb();
  beforeEach(() => { resetSignupRateLimits(); setStripeOnboardingClient(null); });

  it("returns field-specific product errors", async () => {
    const s = await seller("f@example.com");
    const { res, json } = await addProduct(s.cookie, { price: "0.01" });
    expect(res.status).toBe(422);
    expect(json.error.field).toBe("price");
    const signup = await req("/api/v1/sellers/signup", "POST", { business_name: "X Co", contact_name: "Pat", contact_email: "g@example.com", password: PW, category: "tools", state: "ZZ", description: "Something nice.", agree_terms: true });
    expect((await signup.json()).error.field).toBe("state");
  });

  it("deletes an unreferenced product; owner only; shoppers and other sellers get 401/404", async () => {
    const a = await seller("a@example.com");
    const b = await seller("b@example.com", "Other Co");
    const { json: p } = await addProduct(a.cookie);
    expect((await req(`/api/v1/seller/products/${p.product_id}`, "DELETE", undefined, { cookie: b.cookie })).status).toBe(404);
    const shopper = await req("/api/v1/users", "POST", { email: "shop@example.com", password: PW });
    expect((await req(`/api/v1/seller/products/${p.product_id}`, "DELETE", undefined, { cookie: cookieOf(shopper) })).status).toBe(401);
    const del = await req(`/api/v1/seller/products/${p.product_id}`, "DELETE", undefined, { cookie: a.cookie });
    expect(await del.json()).toEqual({ product_id: p.product_id, result: "deleted" });
    expect(getDb().prepare(`SELECT COUNT(*) AS n FROM products WHERE id = ?`).get(p.product_id)).toEqual({ n: 0 });
  });

  it("soft-unlists a product referenced by an order, hides it from search, and can relist it", async () => {
    const a = await seller("c@example.com");
    const { json: p } = await addProduct(a.cookie, { title: "Cherry Spoon" });
    getDb().prepare(`UPDATE sellers SET status = 'active', stripe_charges_enabled = 1, stripe_account_id = 'acct_live_test' WHERE id = ?`).run(a.sellerId);
    expect(searchNative({ q: "cherry spoon" }).length).toBe(1);
    fakeOrder(a.sellerId, p.offer_id, "Cherry Spoon");
    const del = await req(`/api/v1/seller/products/${p.product_id}`, "DELETE", undefined, { cookie: a.cookie });
    expect((await del.json()).result).toBe("unlisted");
    expect(searchNative({ q: "cherry spoon" }).length).toBe(0);
    const relist = await req(`/api/v1/seller/products/${p.product_id}/relist`, "POST", {}, { cookie: a.cookie });
    expect((await relist.json()).unlisted).toBe(false);
    expect(searchNative({ q: "cherry spoon" }).length).toBe(1);
  });

  it("lists only this seller's orders with city/state and no other buyer details", async () => {
    const a = await seller("d@example.com");
    const b = await seller("e@example.com", "Other Co");
    expect((await (await req("/api/v1/seller/orders", "GET", undefined, { cookie: a.cookie })).json()).orders).toEqual([]);
    const mine = fakeOrder(a.sellerId, null, "Walnut Mallet");
    fakeOrder(b.sellerId, null, "Not Mine");
    const res = await req("/api/v1/seller/orders", "GET", undefined, { cookie: a.cookie });
    const text = await res.text();
    const { orders } = JSON.parse(text);
    expect(orders.map((o: { order_id: string }) => o.order_id)).toEqual([mine]);
    expect(orders[0]).toMatchObject({ status: "paid", total_cents: 6900, items: [{ title: "Walnut Mallet", quantity: 2 }], ship_to: { city: "Burlington", region: "VT" } });
    for (const leak of ["Jane", "Smith", "@example.com", "12 Elm", "05401", "usr_", "Not Mine"]) expect(text).not.toContain(leak);
    const shopper = await req("/api/v1/users", "POST", { email: "s2@example.com", password: PW });
    expect((await req("/api/v1/seller/orders", "GET", undefined, { cookie: cookieOf(shopper) })).status).toBe(401);
  });
});
