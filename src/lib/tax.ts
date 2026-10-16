/**
 * Sales tax for Mercavine Store (first-party) sales. Marketplace-seller orders are untouched.
 *
 * TAX_PROVIDER=stripe (default) | table | none
 *   stripe: Stripe Tax calculations API. Fails CLOSED: if Stripe Tax isn't active or the key can't
 *           call it, checkout is blocked (no silent $0 tax).
 *   table:  state base-rate table in src/data/state-tax-rates.json. APPROXIMATION: ignores local rates.
 *   none:   explicit opt-out, $0 tax.
 * TAX_REGISTERED_STATES=NC,... : only these ship-to states are taxed; every other state gets $0.
 * Whether Mercavine must register anywhere (nexus / marketplace-facilitator rules) is a decision for
 * JP and an accountant, not this code.
 */
import rateFile from "../data/state-tax-rates.json";
import { ApiError } from "./errors";
import { PLATFORM_ACCOUNT } from "./first-party";

export type TaxProviderName = "stripe" | "table" | "none";
export type TaxInput = {
  reference: string; // cart id
  address: { line1: string; line2?: string | null; city: string; region: string; postal_code: string; country: string };
  lines: { reference: string; amountCents: number; quantity: number }[]; // amount = unit * qty
  shippingCents: number;
  stripeAccount: string; // PLATFORM_ACCOUNT or acct_...
};
export type TaxResult = { provider: TaxProviderName | "not_registered"; taxCents: number; calculationId: string | null; approximate: boolean };

/** Slice of the Stripe SDK used for tax. Injectable so tests never reach Stripe. */
export type StripeTaxClient = {
  settingsStatus(opts: { stripeAccount?: string }): Promise<string>;
  createCalculation(params: Record<string, unknown>, opts: { stripeAccount?: string }): Promise<{ id: string; tax_amount_exclusive: number }>;
  createTransactionFromCalculation(params: { calculation: string; reference: string }, opts: { stripeAccount?: string; idempotencyKey: string }): Promise<{ id: string }>;
  createReversal(params: { mode: "full"; original_transaction: string; reference: string }, opts: { stripeAccount?: string; idempotencyKey: string }): Promise<{ id: string }>;
};

let override: StripeTaxClient | null = null;
export function setStripeTaxClient(c: StripeTaxClient | null) { override = c; settingsCache.clear(); }

async function stripeTax(): Promise<StripeTaxClient> {
  if (override) return override;
  const key = process.env.STRIPE_SECRET_KEY?.trim();
  if (!key) throw taxUnavailable();
  const Stripe = (await import("stripe")).default;
  const s = new Stripe(key);
  return {
    settingsStatus: async (o) => (await s.tax.settings.retrieve({}, o)).status,
    createCalculation: (p, o) => s.tax.calculations.create(p as never, o) as unknown as Promise<{ id: string; tax_amount_exclusive: number }>,
    createTransactionFromCalculation: (p, o) => s.tax.transactions.createFromCalculation(p, o),
    createReversal: (p, o) => s.tax.transactions.createReversal(p, o),
  };
}

const acctOpt = (a: string) => (a === PLATFORM_ACCOUNT ? {} : { stripeAccount: a });
const taxUnavailable = () =>
  new ApiError(422, "tax_unavailable", "We couldn't calculate sales tax for this order, so nothing was charged. Please try again later.");

export function taxProvider(): TaxProviderName {
  const v = (process.env.TAX_PROVIDER ?? "stripe").trim().toLowerCase();
  if (v === "none" || v === "table" || v === "stripe") return v;
  throw new ApiError(500, "tax_misconfigured", "TAX_PROVIDER must be stripe, table, or none.");
}

export function registeredStates(): string[] {
  return (process.env.TAX_REGISTERED_STATES ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
}

export function tableRateBps(state: string): number {
  const pct = (rateFile.rates_pct as Record<string, number>)[state.toUpperCase()];
  return pct === undefined ? 0 : Math.round(pct * 100);
}

const settingsCache = new Map<string, { status: string; at: number }>();
async function assertStripeTaxActive(client: StripeTaxClient, account: string) {
  const hit = settingsCache.get(account);
  let status = hit && Date.now() - hit.at < 600_000 ? hit.status : null;
  if (!status) {
    try { status = await client.settingsStatus(acctOpt(account)); } catch { throw taxUnavailable(); }
    settingsCache.set(account, { status, at: Date.now() });
  }
  if (status !== "active") throw taxUnavailable();
}

export async function calculateTax(input: TaxInput): Promise<TaxResult> {
  const provider = taxProvider();
  if (provider === "none") return { provider, taxCents: 0, calculationId: null, approximate: false };
  const state = input.address.region.toUpperCase();
  if ((input.address.country || "US").toUpperCase() !== "US" || !registeredStates().includes(state)) {
    return { provider: "not_registered", taxCents: 0, calculationId: null, approximate: false };
  }
  const taxable = input.lines.reduce((n, l) => n + l.amountCents, 0) + input.shippingCents;
  if (provider === "table") {
    return { provider, taxCents: Math.round((taxable * tableRateBps(state)) / 10_000), calculationId: null, approximate: true };
  }
  const client = await stripeTax();
  await assertStripeTaxActive(client, input.stripeAccount);
  try {
    const calc = await client.createCalculation({
      currency: "usd",
      customer_details: {
        address: { line1: input.address.line1, line2: input.address.line2 ?? undefined, city: input.address.city, state, postal_code: input.address.postal_code, country: "US" },
        address_source: "shipping",
      },
      line_items: input.lines.map((l) => ({ amount: l.amountCents, quantity: l.quantity, reference: l.reference, tax_code: process.env.TAX_CODE_GOODS || "txcd_99999999", tax_behavior: "exclusive" })),
      shipping_cost: { amount: input.shippingCents, tax_behavior: "exclusive" },
      metadata: { cart_id: input.reference },
    }, acctOpt(input.stripeAccount));
    return { provider, taxCents: calc.tax_amount_exclusive, calculationId: calc.id, approximate: false };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    throw taxUnavailable();
  }
}

/** After capture: record the sale with Stripe Tax. No-op for non-Stripe providers. */
export async function commitTax(calculationId: string, orderId: string, stripeAccount: string): Promise<string> {
  const client = await stripeTax();
  const tx = await client.createTransactionFromCalculation({ calculation: calculationId, reference: orderId }, { ...acctOpt(stripeAccount), idempotencyKey: `mv_taxtx_${orderId}` });
  return tx.id;
}

export async function reverseTax(transactionId: string, orderId: string, stripeAccount: string): Promise<string> {
  const client = await stripeTax();
  const r = await client.createReversal({ mode: "full", original_transaction: transactionId, reference: `${orderId}-refund` }, { ...acctOpt(stripeAccount), idempotencyKey: `mv_taxrev_${orderId}` });
  return r.id;
}
