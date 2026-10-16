import Stripe from "stripe";
import { afterEach, describe, expect, it } from "vitest";
import { handleApi } from "../src/lib/api";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, loadApproval, submitCart } from "../src/lib/cart";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { applicationFee } from "../src/lib/money";
import { setStripeCardClient, type CardIntent, type StripeCardClient } from "../src/lib/payments";
import { assertBotSafe } from "../src/lib/redact";
import { useTempDb } from "./db";

// Shape-valid placeholders; the Stripe client is faked, nothing leaves the process.
const FAKE_KEY = ["rk", "test", "placeholder0000"].join("_");
const WH_SECRET = ["whsec", "testplaceholder"].join("_");

type Created = { params: Record<string, unknown>; opts: { stripeAccount: string; idempotencyKey: string } };
function fakeStripe() {
  const intents = new Map<string, CardIntent & { account: string }>();
  const created: Created[] = [];
  const captured: string[] = [];
  let n = 0;
  const client: StripeCardClient = {
    async createIntent(params, opts) {
      created.push({ params, opts });
      const id = `pi_fake_${++n}`;
      const intent = { id, status: "requires_payment_method", client_secret: `${id}_secret_x`, amount: params.amount as number, account: opts.stripeAccount };
      intents.set(id, intent);
      return intent;
    },
    async retrieveIntent(id) { return intents.get(id)!; },
    async captureIntent(id) { captured.push(id); const i = intents.get(id)!; i.status = "succeeded"; return i; },
    async cancelIntent(id) { intents.get(id)!.status = "canceled"; return {}; },
  };
  return { client, intents, created, captured };
}

function bot() { return botByToken(DEV_BOT_TOKEN)!; }
const k = (l: string) => `${l}-${Math.random().toString(36).slice(2, 10)}`;

function signed(event: Record<string, unknown>, secret = WH_SECRET) {
  const payload = JSON.stringify(event);
  const header = Stripe.webhooks.generateTestHeaderString({ payload, secret });
  return handleApi(new Request("http://127.0.0.1:4317/api/v1/stripe/webhook", { method: "POST", headers: { "content-type": "application/json", "stripe-signature": header }, body: payload }));
}

async function liveCart() {
  const created = createCart({ bot: bot(), lines: [{ offer_id: "ofr_brass_hinge", quantity: 1 }, { offer_id: "ofr_tape", quantity: 1 }], shippingAddressId: "adr_home", idempotencyKey: k("c") });
  const cartId = (created.body as { id: string }).id;
  process.env.PAYMENT_MODE = "live";
  process.env.STRIPE_SECRET_KEY = FAKE_KEY;
  process.env.STRIPE_PUBLISHABLE_KEY = "pk_test_placeholder";
  process.env.STRIPE_WEBHOOK_SECRET = WH_SECRET;
  process.env.MERCAVINE_SAMPLE_CATALOG = "true";
  process.env.STRIPE_ACCOUNT_SEL_HINGE = "acct_1HingeTest";
  process.env.STRIPE_ACCOUNT_SEL_BENCH = "acct_1BenchTest";
  const submitted = submitCart({ bot: bot(), cartId, idempotencyKey: k("s") }).body as Record<string, unknown>;
  return { cartId, submitted, raw: String(submitted.approval_url).split("/a/")[1] };
}

describe("real card checkout (Payment Element, direct charges)", () => {
  useTempDb();
  afterEach(() => {
    setStripeCardClient(null);
    for (const v of ["STRIPE_PUBLISHABLE_KEY", "STRIPE_ACCOUNT_SEL_HINGE", "STRIPE_ACCOUNT_SEL_BENCH"]) delete process.env[v];
  });

  it("bot gets a hosted payment link, never card data; approval creates direct-charge intents with a 3% fee and wallets on", async () => {
    const fake = fakeStripe();
    setStripeCardClient(fake.client);
    const { cartId, submitted, raw } = await liveCart();
    expect(submitted).toMatchObject({ checkout_mode: "hosted_payment_link", auto_approved: false });
    expect(submitted.payment_url).toBe(submitted.approval_url);
    assertBotSafe(submitted);

    const approved = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(approved.paid).toBe(false);
    if (approved.paid || approved.code !== "card_required") throw new Error("expected card step");
    expect(approved.payment.publishable_key).toBe("pk_test_placeholder");
    expect(approved.payment.intents).toHaveLength(2);
    for (const c of fake.created) {
      expect(c.params).not.toHaveProperty("payment_method");
      expect(c.params).not.toHaveProperty("confirm");
      expect(c.params).toMatchObject({ currency: "usd", capture_method: "manual", automatic_payment_methods: { enabled: true }, metadata: { cart_id: cartId } });
      expect(c.params.application_fee_amount).toBe(applicationFee(c.params.amount as number, 300));
      expect(["acct_1HingeTest", "acct_1BenchTest"]).toContain(c.opts.stripeAccount);
      expect(c.opts.idempotencyKey).toMatch(/^mv_pi_/);
    }
    expect(loadApproval(raw, "usr_jp").kind).toBe("card");
    // Reloading the card step reuses the same intents (no duplicate charges).
    const { cardSession } = await import("../src/lib/cart");
    const session = await cardSession({ rawToken: raw, userId: "usr_jp" });
    expect(session.paid).toBe(false);
    expect(fake.created).toHaveLength(2);
  });

  it("webhooks: verified, idempotent, capture only after every seller authorizes, then refund and dispute update orders", async () => {
    const fake = fakeStripe();
    setStripeCardClient(fake.client);
    const { cartId, raw } = await liveCart();
    await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    const [a, b] = [...fake.intents.values()];

    expect((await signed({ id: "evt_x", type: "payment_intent.succeeded", data: { object: { id: a.id } } }, "whsec_wrong")).status).toBe(400);

    a.status = "requires_capture";
    const first = { id: "evt_1", type: "payment_intent.amount_capturable_updated", data: { object: { id: a.id, status: "requires_capture", metadata: { cart_id: cartId } } } };
    expect((await signed(first)).status).toBe(200);
    expect(fake.captured).toEqual([]);
    expect(await (await signed(first)).json()).toMatchObject({ duplicate: true });

    const failed = { id: "evt_2", type: "payment_intent.payment_failed", data: { object: { id: b.id, status: "requires_payment_method", last_payment_error: { code: "card_declined", decline_code: "insufficient_funds" }, metadata: { cart_id: cartId } } } };
    await signed(failed);
    const failRow = getDb().prepare(`SELECT status, failure_code FROM payment_attempts WHERE provider_id = ?`).get(b.id);
    expect(failRow).toMatchObject({ status: "failed", failure_code: "insufficient_funds" });
    expect((getDb().prepare(`SELECT status FROM carts WHERE id = ?`).get(cartId) as { status: string }).status).toBe("approved");

    b.status = "requires_capture";
    await signed({ id: "evt_3", type: "payment_intent.amount_capturable_updated", data: { object: { id: b.id, status: "requires_capture" } } });
    expect(fake.captured.sort()).toEqual([a.id, b.id].sort());
    expect((getDb().prepare(`SELECT status FROM carts WHERE id = ?`).get(cartId) as { status: string }).status).toBe("paid");
    const orders = getDb().prepare(`SELECT stripe_payment_intent_id, payment_status FROM orders WHERE cart_id = ? ORDER BY stripe_payment_intent_id`).all(cartId) as { stripe_payment_intent_id: string; payment_status: string }[];
    expect(orders.map((o) => o.payment_status)).toEqual(["paid", "paid"]);

    // succeeded after finalize is a no-op (no second order set).
    await signed({ id: "evt_4", type: "payment_intent.succeeded", data: { object: { id: a.id, status: "succeeded" } } });
    expect((getDb().prepare(`SELECT COUNT(*) AS n FROM orders WHERE cart_id = ?`).get(cartId) as { n: number }).n).toBe(2);

    await signed({ id: "evt_5", type: "charge.refunded", data: { object: { id: "ch_1", payment_intent: a.id, amount: a.amount, amount_refunded: a.amount, refunded: true } } });
    await signed({ id: "evt_6", type: "charge.dispute.created", data: { object: { id: "dp_1", payment_intent: b.id } } });
    const after = Object.fromEntries((getDb().prepare(`SELECT stripe_payment_intent_id AS id, payment_status AS s FROM orders WHERE cart_id = ?`).all(cartId) as { id: string; s: string }[]).map((r) => [r.id, r.s]));
    expect(after).toEqual({ [a.id]: "refunded", [b.id]: "disputed" });
  });

  it("account.updated activates a seller via the verified webhook", async () => {
    process.env.PAYMENT_MODE = "live";
    process.env.STRIPE_WEBHOOK_SECRET = `whsec_other,${WH_SECRET}`;
    getDb().prepare(`UPDATE sellers SET stripe_account_id = 'acct_1Upd', user_id = 'usr_jp', stripe_charges_enabled = 0 WHERE id = 'sel_hinge'`).run();
    const res = await signed({ id: "evt_acct", type: "account.updated", account: "acct_1Upd", data: { object: { id: "acct_1Upd", charges_enabled: true, payouts_enabled: true, details_submitted: true } } });
    expect(res.status).toBe(200);
    expect(getDb().prepare(`SELECT stripe_charges_enabled AS c FROM sellers WHERE id = 'sel_hinge'`).get()).toMatchObject({ c: 1 });
  });

  it("live mode without a webhook secret refuses unsigned events", async () => {
    process.env.PAYMENT_MODE = "live";
    const res = await handleApi(new Request("http://127.0.0.1:4317/api/v1/stripe/webhook", { method: "POST", body: "{}" }));
    expect(res.status).toBe(400);
  });
});
