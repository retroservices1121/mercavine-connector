import { beforeEach, describe, expect, it } from "vitest";
import { resetSignupRateLimits } from "../src/lib/accounts";
import { handleApi } from "../src/lib/api";
import { searchNative } from "../src/lib/catalog";
import { config } from "../src/lib/config";
import { buildCharge } from "../src/lib/payments";
import { setStripeOnboardingClient } from "../src/lib/sellers";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
// Shape-valid placeholder; never sent anywhere (Stripe client is faked).
const FAKE_KEY = ["rk", "test", "placeholder0000"].join("_");
let ip = 0;

function req(path: string, method: string, body?: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`${base}${path}`, {
    method,
    headers: { "content-type": "application/json", origin: base, ...headers },
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  }));
}
const cookieOf = (res: Response) => (res.headers.get("set-cookie") ?? "").split(";")[0];

async function seller(email: string) {
  const res = await req("/api/v1/sellers/signup", "POST", {
    business_name: "Live Goods", contact_name: "Lee Live", contact_email: email, password: "live-mode-pass-1",
    category: "tools", state: "NY", description: "Real tools for real people.", agree_terms: true, age_confirmed: true,
  }, { "x-forwarded-for": `10.6.0.${++ip}` });
  return { cookie: cookieOf(res), id: (await res.json()).seller_id as string };
}

describe("live Stripe mode", () => {
  useTempDb();
  beforeEach(() => { resetSignupRateLimits(); setStripeOnboardingClient(null); });

  it("PAYMENT_MODE=live never falls back to mock, and fails closed without a key", async () => {
    process.env.PAYMENT_MODE = "live";
    expect(config().paymentMode).toBe("stripe");
    expect(config().stripeSecretKey).toBeNull();
    const health = await (await req("/api/health", "GET")).json();
    expect(health).toMatchObject({ payment_mode: "stripe", payments_ready: false });
    const s = await seller("nokey@example.com");
    const onboard = await req("/api/v1/seller/stripe/onboard", "POST", {}, { cookie: s.cookie });
    expect(onboard.status).toBe(503);
  });

  it("accepts restricted keys, and an unset PAYMENT_MODE with a key means Stripe", () => {
    process.env.STRIPE_SECRET_KEY = FAKE_KEY;
    expect(config().paymentMode).toBe("stripe");
    expect(config().stripeSecretKey).toBe(FAKE_KEY);
    expect(config().sampleCatalog).toBe(false);
    process.env.PAYMENT_MODE = "mock";
    expect(config().paymentMode).toBe("mock");
  });

  it("hides sample sellers in live mode and shows a real seller only once charges are enabled", async () => {
    expect(searchNative({ limit: 20 }).length).toBeGreaterThan(0); // mock mode: sample catalog visible
    process.env.PAYMENT_MODE = "live";
    process.env.STRIPE_SECRET_KEY = FAKE_KEY;
    expect(searchNative({ limit: 20 })).toHaveLength(0);
    const s = await seller("real@example.com");
    await req("/api/v1/seller/products", "POST", { title: "Live Hammer", description: "A good hammer.", category: "tools", price: "20", stock: 3 }, { cookie: s.cookie });
    setStripeOnboardingClient({
      async createExpressAccount() { return { id: "acct_1LiveTest" }; },
      async createAccountLink() { return { url: "https://connect.stripe.test/x" }; },
      async retrieveAccount(id) { return { id, charges_enabled: false, payouts_enabled: false, details_submitted: true }; },
    });
    await req("/api/v1/seller/stripe/onboard", "POST", {}, { cookie: s.cookie });
    await req("/api/v1/seller/stripe/refresh", "POST", {}, { cookie: s.cookie });
    expect(searchNative({ q: "live hammer" })).toHaveLength(0);
    // account.updated webhook flips it on (no webhook secret: must be rejected in live mode).
    const evt = JSON.stringify({ type: "account.updated", data: { object: { id: "acct_1LiveTest", charges_enabled: true, payouts_enabled: true, details_submitted: true } } });
    expect((await req("/api/v1/stripe/webhook", "POST", evt)).status).toBe(400);
    process.env.PAYMENT_MODE = "mock"; // mock mode accepts unsigned events for local testing
    expect((await req("/api/v1/stripe/webhook", "POST", evt)).status).toBe(200);
    process.env.PAYMENT_MODE = "live";
    const found = searchNative({ q: "live hammer" });
    expect(found).toHaveLength(1);
    expect(searchNative({ limit: 20 })).toHaveLength(1);
  });

  it("keeps the 3% application fee on direct charges", () => {
    const charge = buildCharge({ sellerId: "sel_x", sellerName: "X", storedStripeAccountId: "acct_1Real", statementDescriptor: "X", amountCents: 10_000 });
    expect(charge).toMatchObject({ amountCents: 10_000, feeCents: 300, stripeAccountId: "acct_1Real" });
  });
});
