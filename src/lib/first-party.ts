/**
 * First-party "Mercavine Store" seller. Isolated here so the charge routing can move to a Connect
 * account later without touching the cart or payment code.
 *
 * Default: charges are created on the PLATFORM Stripe account (no Stripe-Account header) with no
 * application fee, because Mercavine is the merchant of record.
 * Switch: set MERCAVINE_STORE_STRIPE_ACCOUNT=acct_... to route the store's charges to that connected
 * account instead (still no application fee, since the fee would be paid to ourselves).
 */
import { getDb } from "./db";
import { one, run } from "./sql";
import { nowIso } from "./clock";

export const FIRST_PARTY_SELLER_ID = "sel_mercavine_store";
/** Stored in payment_attempts.stripe_account_id for platform-account charges. Never sent to Stripe. */
export const PLATFORM_ACCOUNT = "platform";

export function isFirstPartySeller(sellerId: string): boolean {
  const row = one<{ first_party: number }>(getDb(), `SELECT first_party FROM sellers WHERE id = ?`, sellerId);
  return row?.first_party === 1;
}

export function firstPartyEnabled(): boolean {
  return process.env.MERCAVINE_STORE_ENABLED === "true";
}

/** Where a first-party charge goes and what fee it carries. */
export function firstPartyRouting(): { stripeAccountId: string; feeCents: 0 } {
  const acct = process.env.MERCAVINE_STORE_STRIPE_ACCOUNT?.trim();
  return { stripeAccountId: acct && acct.startsWith("acct_") ? acct : PLATFORM_ACCOUNT, feeCents: 0 };
}

/** Stripe request options: omit stripeAccount for the platform account. */
export function stripeAccountOpt(stored: string): { stripeAccount?: string } {
  return stored === PLATFORM_ACCOUNT ? {} : { stripeAccount: stored };
}

/** Create the store seller row (idempotent). Status stays 'paused' until MERCAVINE_STORE_ENABLED=true. */
export function ensureFirstPartySeller(): void {
  const db = getDb();
  run(db, `INSERT OR IGNORE INTO sellers (
      id, name, slug, rating, rating_count, stripe_account_id, statement_descriptor, return_window_days, restocking_fee_pct,
      ships_from_city, ships_from_region, prime_enrolled, status, first_party, created_at
    ) VALUES (?, 'Mercavine Store', 'mercavine-store', 0, 0, ?, 'MERCAVINE', 30, 0, '', 'US', 0, 'active', 1, ?)`,
    FIRST_PARTY_SELLER_ID, PLATFORM_ACCOUNT, nowIso());
}
