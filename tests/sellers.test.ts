import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { searchNative } from "../src/lib/catalog";
import { getDb } from "../src/lib/db";
import { setStripeOnboardingClient, stripeCardState, type StripeAccountState } from "../src/lib/sellers";
import { clearMailOutbox, mailOutbox } from "../src/lib/mailer";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const PW = ["seller", "pass", "phrase"].join("-");
let ipCounter = 0;

function req(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

function sellerBody(email: string, extra: Record<string, unknown> = {}) {
  return {
    business_name: "Oak & Pine Goods", contact_name: "Pat Seller", contact_email: email, password: PW,
    phone: "555-123-4567", website: "https://oakpine.example", category: "tools", state: "VT",
    description: "Hand tools made in Vermont.", agree_terms: true, ...extra,
  };
}

async function signupSeller(email: string) {
  const res = await req("/api/v1/sellers/signup", "POST", sellerBody(email), { "x-forwarded-for": `10.9.0.${++ipCounter}` });
  return { res, cookie: cookieOf(res), json: await res.clone().json() };
}

/** Stateful fake Stripe: no network. */
function fakeStripe(state: Partial<StripeAccountState> = {}) {
  const calls: string[] = [];
  const account = { id: "acct_test_1", charges_enabled: false, payouts_enabled: false, details_submitted: false, ...state };
  setStripeOnboardingClient({
    async createExpressAccount() { calls.push("create"); return { id: account.id }; },
    async createAccountLink(input) { calls.push(`link:${input.returnUrl}|${input.refreshUrl}`); return { url: "https://connect.stripe.test/onboard/abc" }; },
    async retrieveAccount() { calls.push("retrieve"); return { ...account }; },
  });
  return { calls, account };
}

const product = { title: "Walnut Mallet", description: "A solid walnut mallet.", category: "tools", price: "34.50", stock: 5, image_url: "https://img.example/mallet.jpg" };

describe("seller onboarding", () => {
  useTempDb();
  beforeEach(() => { resetSignupRateLimits(); setStripeOnboardingClient(null); clearMailOutbox(); });

  it("signs up a seller, links it to a new user, signs in, and starts in onboarding", async () => {
    const { res, cookie, json } = await signupSeller("Pat@OakPine.example");
    expect(res.status).toBe(201);
    expect(cookie).toMatch(/^mv_session=/);
    expect(json.status).toBe("onboarding");
    const row = getDb().prepare(`SELECT s.status, s.user_id, s.stripe_account_id, u.email, u.password_hash FROM sellers s JOIN users u ON u.id = s.user_id WHERE s.id = ?`).get(json.seller_id) as Record<string, string>;
    expect(row.email).toBe("pat@oakpine.example");
    expect(row.status).toBe("onboarding");
    expect(row.stripe_account_id).toBe("");
    expect(row.password_hash).toMatch(/^[0-9a-f]{32}:[0-9a-f]{64}$/);
    const dash = await req("/api/v1/seller/dashboard", "GET", undefined, { cookie });
    expect((await dash.json()).seller.name).toBe("Oak & Pine Goods");
    // Same verification email as shopper sign-up (in-memory outbox, no provider).
    const sent = mailOutbox().filter((m) => m.to === "pat@oakpine.example");
    expect(sent).toHaveLength(1);
    expect(sent[0].tag).toBe("verify_email");
    expect(sent[0].text).toMatch(/\/verify\?token=/);
    expect((getDb().prepare(`SELECT email_verified FROM users WHERE email = ?`).get("pat@oakpine.example") as { email_verified: number }).email_verified).toBe(0);
  });

  it("reuses a signed-in shopper account and allows only one seller per account", async () => {
    const shopper = await req("/api/v1/users", "POST", { email: "shop@example.com", password: PW }, { "x-forwarded-for": "10.8.0.1" });
    const cookie = cookieOf(shopper);
    const before = (getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number }).n;
    const first = await req("/api/v1/sellers/signup", "POST", sellerBody("ignored@example.com", { password: undefined }), { cookie, "x-forwarded-for": "10.8.0.2" });
    expect(first.status).toBe(201);
    const users = getDb().prepare(`SELECT COUNT(*) AS n FROM users`).get() as { n: number };
    expect(users.n).toBe(before);
    const linked = getDb().prepare(`SELECT u.email FROM sellers s JOIN users u ON u.id = s.user_id`).get() as { email: string };
    expect(linked.email).toBe("shop@example.com");
    const again = await req("/api/v1/sellers/signup", "POST", sellerBody("x@example.com"), { cookie, "x-forwarded-for": "10.8.0.3" });
    expect(again.status).toBe(422);
  });

  it("rejects bad input with friendly messages, duplicate emails generically, and rate limits", async () => {
    const bad = await req("/api/v1/sellers/signup", "POST", sellerBody("a@b.example", { agree_terms: false }), { "x-forwarded-for": "10.7.0.1" });
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.message).toMatch(/seller terms/);
    await signupSeller("dupe@example.com");
    const dupe = await req("/api/v1/sellers/signup", "POST", sellerBody("dupe@example.com"), { "x-forwarded-for": "10.7.0.2" });
    expect((await dupe.json()).error.code).toBe("signup_failed");
    let last = 0;
    for (let i = 0; i < 7; i++) last = (await req("/api/v1/sellers/signup", "POST", sellerBody(`r${i}@example.com`), { "x-forwarded-for": "10.7.9.9" })).status;
    expect(last).toBe(429);
  });

  it("creates the Express account and Account Link with mercavine /seller URLs, then reports status from (mocked) Stripe", async () => {
    const { cookie } = await signupSeller("s1@example.com");
    const fake = fakeStripe();
    const start = await req("/api/v1/seller/stripe/onboard", "POST", {}, { cookie });
    expect((await start.json()).url).toBe("https://connect.stripe.test/onboard/abc");
    expect(fake.calls).toEqual(["create", `link:${base}/seller?stripe=return|${base}/seller?stripe=refresh`]);
    let dash = await (await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie })).json();
    expect(dash.stripe).toMatchObject({ connected: true, state: "in_progress", charges_enabled: false, payouts_enabled: false });
    expect(dash.seller.status).toBe("onboarding");

    fake.account.details_submitted = true;
    dash = await (await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie })).json();
    expect(dash.stripe.state).toBe("pending_review");

    fake.account.charges_enabled = true;
    dash = await (await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie })).json();
    expect(dash.stripe).toMatchObject({ state: "active", charges_enabled: true, payouts_enabled: false });
    expect(dash.seller.status).toBe("active");
    expect(dash.checklist.find((c: { key: string }) => c.key === "stripe").done).toBe(true);
    // Second onboarding call reuses the account.
    await req("/api/v1/seller/stripe/onboard", "POST", {}, { cookie });
    expect(fake.calls.filter((c) => c === "create")).toHaveLength(1);
    expect(stripeCardState({ stripe_account_id: "", stripe_charges_enabled: 0, stripe_details_submitted: 0 })).toBe("not_started");
  });

  it("hides a seller's listings from search and carts until Stripe charges are enabled", async () => {
    const { cookie } = await signupSeller("s2@example.com");
    const created = await (await req("/api/v1/seller/products", "POST", product, { cookie })).json();
    expect(created).toMatchObject({ title: "Walnut Mallet", price_cents: 3450, stock: 5 });
    expect(searchNative({ q: "walnut mallet" })).toHaveLength(0);
    const fake = fakeStripe({ charges_enabled: false });
    await req("/api/v1/seller/stripe/onboard", "POST", {}, { cookie });
    await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie });
    expect(searchNative({ q: "walnut mallet" })).toHaveLength(0);
    fake.account.charges_enabled = true;
    const dash = await (await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie })).json();
    expect(dash.listings_visible).toBe(true);
    const found = searchNative({ q: "walnut mallet" });
    expect(found).toHaveLength(1);
    expect(found[0].offers[0].price.amount).toBe(3450);
    // Seeded catalog sellers stay visible.
    expect(searchNative({ limit: 20 }).length).toBeGreaterThan(1);
  });

  it("lets a seller edit only their own products", async () => {
    const a = await signupSeller("a@example.com");
    const b = await signupSeller("b@example.com");
    const made = await (await req("/api/v1/seller/products", "POST", product, { cookie: a.cookie })).json();
    const edit = await req(`/api/v1/seller/products/${made.product_id}`, "PATCH", { ...product, price: "40", stock: 2 }, { cookie: a.cookie });
    expect(await edit.json()).toMatchObject({ price_cents: 4000, stock: 2 });
    const hijack = await req(`/api/v1/seller/products/${made.product_id}`, "PATCH", { ...product, title: "Pwned", price: "1" }, { cookie: b.cookie });
    expect(hijack.status).toBe(404);
    const list = await (await req("/api/v1/seller/products", "GET", undefined, { cookie: b.cookie })).json();
    expect(list.products).toHaveLength(0);
    const row = getDb().prepare(`SELECT title FROM products WHERE id = ?`).get(made.product_id) as { title: string };
    expect(row.title).toBe("Walnut Mallet");
    // A non-seller and an anonymous caller are refused.
    expect((await req("/api/v1/seller/products", "POST", product)).status).toBe(401);
    const bad = await req("/api/v1/seller/products", "POST", { ...product, image_url: "javascript:alert(1)" }, { cookie: a.cookie });
    expect(bad.status).toBe(422);
  });

  it("blocks Amazon connect on another seller's account", async () => {
    process.env.AMAZON_MCF_ENABLED = "true";
    const a = await signupSeller("amz-a@example.com");
    const b = await signupSeller("amz-b@example.com");
    const own = await req(`/api/v1/sellers/${a.json.seller_id}/amazon/connect`, "POST", {}, { cookie: a.cookie });
    expect(own.status).toBe(200);
    const other = await req(`/api/v1/sellers/${a.json.seller_id}/amazon/connect`, "POST", {}, { cookie: b.cookie });
    expect(other.status).toBe(404);
    const dash = await (await req("/api/v1/seller/dashboard", "GET", undefined, { cookie: a.cookie })).json();
    expect(dash.amazon.connected).toBe(true);
  });
});
