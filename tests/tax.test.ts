import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveCart, settleCardCart } from "../src/lib/cart";
import { setCjTransport } from "../src/lib/cj";
import { approveSupplierOrder, prepareCheckout } from "../src/lib/cj-store";
import { getDb } from "../src/lib/db";
import { applyIntentStatus, setStripeCardClient } from "../src/lib/payments";
import { calculateTax, setStripeTaxClient, tableRateBps, type StripeTaxClient } from "../src/lib/tax";
import { handleStripeEvent } from "../src/lib/stripe-webhook";
import { fakeCj, fakeStripe, storeCart } from "./cj-fakes";
import { useTempDb } from "./db";

function fakeTax(opts: { status?: string; rateBps?: number; failCalc?: boolean } = {}) {
  const calcs: Record<string, unknown>[] = [];
  const txs: { calculation: string; reference: string }[] = [];
  const reversals: string[] = [];
  let n = 0;
  const client: StripeTaxClient = {
    async settingsStatus() { return opts.status ?? "active"; },
    async createCalculation(params) {
      if (opts.failCalc) throw new Error("permission denied");
      calcs.push(params);
      const items = params.line_items as { amount: number }[];
      const base = items.reduce((a, b) => a + b.amount, 0) + (params.shipping_cost as { amount: number }).amount;
      return { id: `taxcalc_${++n}`, tax_amount_exclusive: Math.round((base * (opts.rateBps ?? 700)) / 10_000) };
    },
    async createTransactionFromCalculation(p) { txs.push(p); return { id: `tax_tx_${txs.length}` }; },
    async createReversal(p) { reversals.push(p.original_transaction); return { id: `tax_rev_${reversals.length}` }; },
  };
  setStripeTaxClient(client);
  return { calcs, txs, reversals };
}

const addr = { line1: "1 Main St", city: "Raleigh", region: "NC", postal_code: "27601", country: "US" };
const input = { reference: "cart_x", address: addr, lines: [{ reference: "l1", amountCents: 10_000, quantity: 1 }], shippingCents: 0, stripeAccount: "platform" };

describe("sales tax: provider rules", () => {
  useTempDb();
  afterEach(() => { setStripeTaxClient(null); for (const v of ["TAX_PROVIDER", "TAX_REGISTERED_STATES"]) delete process.env[v]; });

  it("only registered states are taxed", async () => {
    const t = fakeTax();
    process.env.TAX_REGISTERED_STATES = "NC";
    expect(await calculateTax({ ...input, address: { ...addr, region: "SC" } })).toMatchObject({ provider: "not_registered", taxCents: 0 });
    expect(t.calcs).toHaveLength(0);
    const r = await calculateTax(input);
    expect(r).toMatchObject({ provider: "stripe", taxCents: 700, calculationId: "taxcalc_1" });
    expect(t.calcs[0]).toMatchObject({ currency: "usd", customer_details: { address: { state: "NC", postal_code: "27601", country: "US" }, address_source: "shipping" }, line_items: [{ amount: 10_000, tax_code: "txcd_99999999", tax_behavior: "exclusive" }], shipping_cost: { amount: 0 } });
  });

  it("fails closed when Stripe Tax is inactive or the key can't calculate", async () => {
    process.env.TAX_REGISTERED_STATES = "NC";
    fakeTax({ status: "pending" });
    await expect(calculateTax(input)).rejects.toMatchObject({ code: "tax_unavailable" });
    fakeTax({ failCalc: true });
    await expect(calculateTax(input)).rejects.toMatchObject({ code: "tax_unavailable" });
  });

  it("table provider uses the data file and is flagged approximate; none is an explicit $0", async () => {
    process.env.TAX_REGISTERED_STATES = "NC";
    process.env.TAX_PROVIDER = "table";
    expect(tableRateBps("NC")).toBe(475);
    expect(await calculateTax(input)).toMatchObject({ provider: "table", taxCents: 475, approximate: true });
    process.env.TAX_PROVIDER = "none";
    expect(await calculateTax(input)).toMatchObject({ provider: "none", taxCents: 0 });
    process.env.TAX_PROVIDER = "bogus";
    await expect(calculateTax(input)).rejects.toMatchObject({ code: "tax_misconfigured" });
  });
});

describe("sales tax: Mercavine Store checkout", () => {
  useTempDb();
  beforeEach(() => {
    process.env.CJ_API_KEY = "cj-key-placeholder";
    process.env.MERCAVINE_STORE_ENABLED = "true";
    process.env.CJ_CATEGORY_IDS = "c1";
    process.env.CJ_SYNC_MAX_PAGES = "1";
    process.env.TAX_REGISTERED_STATES = "FL"; // seed address adr_home is Jacksonville, FL
  });
  afterEach(() => {
    setCjTransport(null); setStripeCardClient(null); setStripeTaxClient(null);
    for (const v of ["CJ_API_KEY", "MERCAVINE_STORE_ENABLED", "CJ_CATEGORY_IDS", "CJ_SYNC_MAX_PAGES", "TAX_REGISTERED_STATES", "TAX_PROVIDER", "STRIPE_PUBLISHABLE_KEY"]) delete process.env[v];
  });

  async function ready() {
    const cj = fakeCj();
    const { syncCatalog } = await import("../src/lib/cj-store");
    await syncCatalog();
    return cj;
  }

  it("taxes before the PaymentIntent, holds and captures the full amount, stores tax, commits and reverses", async () => {
    await ready();
    const tax = fakeTax({ rateBps: 700 });
    const stripe = fakeStripe();
    const { cartId, raw } = await storeCart();
    const approved = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(approved.paid).toBe(false);
    expect(tax.calcs).toHaveLength(1);
    // $15.00 item (min price) + 7% = $16.05 held on the intent.
    expect(stripe.created[0].params.amount).toBe(1605);
    const [intent] = [...stripe.intents.values()];
    intent.status = "requires_capture";
    applyIntentStatus(getDb(), intent.id, "requires_capture");
    await settleCardCart(cartId);
    const so = getDb().prepare(`SELECT id FROM supplier_orders WHERE cart_id = ?`).get(cartId) as { id: string };
    await approveSupplierOrder(so.id, "jp");
    expect(stripe.captured).toEqual([intent.id]);
    const order = getDb().prepare(`SELECT id, tax_cents, total_cents FROM orders WHERE cart_id = ?`).get(cartId) as { id: string; tax_cents: number; total_cents: number };
    expect(order).toMatchObject({ tax_cents: 105, total_cents: 1605 });
    expect(tax.txs).toEqual([{ calculation: "taxcalc_1", reference: order.id }]);

    await handleStripeEvent({ id: "evt_r", type: "charge.refunded", data: { object: { payment_intent: intent.id, refunded: true, amount: 1605, amount_refunded: 1605 } } } as never, {} as never);
    expect(tax.reversals).toEqual(["tax_tx_1"]);
    await handleStripeEvent({ id: "evt_r2", type: "charge.refunded", data: { object: { payment_intent: intent.id, refunded: true } } } as never, {} as never);
    expect(tax.reversals).toHaveLength(1);
  });

  it("blocks checkout (no PaymentIntent) when Stripe Tax is unavailable", async () => {
    await ready();
    fakeTax({ status: "inactive" });
    const stripe = fakeStripe();
    const { raw } = await storeCart();
    await expect(approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" })).rejects.toMatchObject({ code: "tax_unavailable" });
    expect(stripe.created).toHaveLength(0);
  });

  it("unregistered ship-to state: $0 tax, no Stripe Tax call", async () => {
    await ready();
    process.env.TAX_REGISTERED_STATES = "NC";
    const tax = fakeTax();
    const stripe = fakeStripe();
    const { raw } = await storeCart();
    await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(tax.calcs).toHaveLength(0);
    expect(stripe.created[0].params.amount).toBe(1500);
  });

  it("a changed basis forces a recalculation; unchanged reuses the quote; stale quote never charges", async () => {
    await ready();
    const tax = fakeTax();
    fakeStripe();
    const { cartId } = await storeCart();
    await prepareCheckout(cartId);
    await prepareCheckout(cartId);
    expect(tax.calcs).toHaveLength(1);
    getDb().prepare(`UPDATE cart_lines SET quantity = 2 WHERE cart_id = ?`).run(cartId);
    await prepareCheckout(cartId);
    expect(tax.calcs).toHaveLength(2);
    expect((tax.calcs[1].line_items as { amount: number }[])[0].amount).toBe(3000);
  });
});
