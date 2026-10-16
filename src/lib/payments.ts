import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { config, sellerStripeAccount } from "./config";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { platformFeeCents } from "./money";
import { run } from "./sql";
import { firstPartyRouting, isFirstPartySeller, PLATFORM_ACCOUNT } from "./first-party";

export type SellerCharge = {
  sellerId: string;
  sellerName: string;
  stripeAccountId: string;
  amountCents: number;
  feeCents: number;
  currency: "usd";
  statementDescriptor: string;
};

export type SettleOk = { ok: true; attempts: { sellerId: string; providerId: string; amountCents: number; feeCents: number }[] };
export type SettleFail = { ok: false; code: "card_declined" | "authentication_failed" | "processing_error" };
export type SettleResult = SettleOk | SettleFail;

function log(db: DatabaseSync, cartId: string, sellerId: string, action: string) {
  run(db, `INSERT INTO payment_log (cart_id, seller_id, action, created_at) VALUES (?, ?, ?, ?)`, cartId, sellerId, action, nowIso());
}

function insertAttempt(
  db: DatabaseSync,
  cartId: string,
  charge: SellerCharge,
  status: string,
  providerId: string | null,
  failureCode: string | null,
) {
  run(
    db,
    `INSERT INTO payment_attempts (
      id, cart_id, seller_id, stripe_account_id, amount_cents, fee_cents, currency, status, provider_id, failure_code, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    newId("pat"),
    cartId,
    charge.sellerId,
    charge.stripeAccountId,
    charge.amountCents,
    charge.feeCents,
    charge.currency,
    status,
    providerId,
    failureCode,
    nowIso(),
  );
}

export function buildCharge(input: {
  sellerId: string;
  sellerName: string;
  storedStripeAccountId: string;
  statementDescriptor: string;
  amountCents: number;
}): SellerCharge {
  const bps = config().platformFeeBps;
  if (isFirstPartySeller(input.sellerId)) {
    // Mercavine Store: merchant of record is the platform. No application fee. See first-party.ts.
    const route = firstPartyRouting();
    return {
      sellerId: input.sellerId,
      sellerName: input.sellerName,
      stripeAccountId: route.stripeAccountId,
      amountCents: input.amountCents,
      feeCents: 0,
      currency: "usd",
      statementDescriptor: input.statementDescriptor.slice(0, 22),
    };
  }
  return {
    sellerId: input.sellerId,
    sellerName: input.sellerName,
    stripeAccountId: sellerStripeAccount(input.sellerId, input.storedStripeAccountId),
    amountCents: input.amountCents,
    feeCents: platformFeeCents("stripe", input.amountCents, bps),
    currency: "usd",
    statementDescriptor: input.statementDescriptor.slice(0, 22),
  };
}

/** Authorize every seller, then capture all. A failure voids any authorization already made. */
export function mockSettle(db: DatabaseSync, cartId: string, charges: SellerCharge[], failSellerId?: string): SettleResult {
  if (charges.some((c) => isFirstPartySeller(c.sellerId))) {
    // The store's approval gate lives in the card flow; mock settlement would capture instantly.
    throw new ApiError(422, "seller_unavailable", "Mercavine Store items need live card checkout. Nothing was charged.");
  }
  const ordered = failSellerId
    ? [...charges.filter((charge) => charge.sellerId !== failSellerId), ...charges.filter((charge) => charge.sellerId === failSellerId)]
    : charges;
  const authorized: { charge: SellerCharge; providerId: string }[] = [];
  for (const charge of ordered) {
    if (failSellerId && charge.sellerId === failSellerId) {
      log(db, cartId, charge.sellerId, "fail");
      insertAttempt(db, cartId, charge, "failed", null, "card_declined");
      for (const prev of authorized) {
        log(db, cartId, prev.charge.sellerId, "void");
        run(db, `UPDATE payment_attempts SET status = 'voided' WHERE cart_id = ? AND provider_id = ?`, cartId, prev.providerId);
      }
      return { ok: false, code: "card_declined" };
    }
    const providerId = `mock_pi_${newId("x")}`;
    log(db, cartId, charge.sellerId, "authorize");
    insertAttempt(db, cartId, charge, "authorized", providerId, null);
    authorized.push({ charge, providerId });
  }
  for (const prev of authorized) {
    log(db, cartId, prev.charge.sellerId, "capture");
    run(db, `UPDATE payment_attempts SET status = 'captured' WHERE cart_id = ? AND provider_id = ?`, cartId, prev.providerId);
  }
  return {
    ok: true,
    attempts: authorized.map((item) => ({
      sellerId: item.charge.sellerId,
      providerId: item.providerId,
      amountCents: item.charge.amountCents,
      feeCents: item.charge.feeCents,
    })),
  };
}

/** The slice of the Stripe SDK the card flow uses. Injectable so tests never reach Stripe. */
export type CardIntent = { id: string; status: string; client_secret?: string | null; amount: number; last_payment_error?: { code?: string | null } | null };
export type StripeCardClient = {
  createIntent(params: Record<string, unknown>, opts: { stripeAccount: string; idempotencyKey: string }): Promise<CardIntent>;
  retrieveIntent(id: string, opts: { stripeAccount: string }): Promise<CardIntent>;
  captureIntent(id: string, opts: { stripeAccount: string; idempotencyKey: string }): Promise<CardIntent>;
  cancelIntent(id: string, opts: { stripeAccount: string }): Promise<unknown>;
};

let cardOverride: StripeCardClient | null = null;
export function setStripeCardClient(client: StripeCardClient | null) {
  cardOverride = client;
}

export async function stripeCardClient(): Promise<StripeCardClient> {
  if (cardOverride) return cardOverride;
  const key = config().stripeSecretKey;
  // Fail closed: Stripe mode never silently settles in mock.
  if (!key) throw new ApiError(503, "payments_unavailable", "Payments are temporarily unavailable. Nothing was charged.");
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);
  return {
    createIntent: (params, opts) => stripe.paymentIntents.create(params as never, platformOpts(opts)) as Promise<CardIntent>,
    retrieveIntent: (id, opts) => stripe.paymentIntents.retrieve(id, {}, platformOpts(opts)) as Promise<CardIntent>,
    captureIntent: (id, opts) => stripe.paymentIntents.capture(id, {}, platformOpts(opts)) as Promise<CardIntent>,
    cancelIntent: (id, opts) => stripe.paymentIntents.cancel(id, {}, platformOpts(opts)),
  };
}

/** Platform-account charges (first-party store) send no Stripe-Account header. */
function platformOpts<T extends { stripeAccount?: string }>(opts: T): T {
  if (opts.stripeAccount !== PLATFORM_ACCOUNT) return opts;
  const rest = { ...opts };
  delete rest.stripeAccount;
  return rest;
}

export type PendingCardIntent = { seller_id: string; seller_name: string; stripe_account: string; amount_cents: number; client_secret: string; status: string };

/**
 * Real card checkout. One PaymentIntent per seller, created as a direct charge on the seller's connected
 * account with application_fee_amount (3%). No payment method is attached here: the shopper enters it in
 * Stripe's Payment Element on the hosted approval page (cards, Link, Apple Pay, Google Pay via
 * automatic_payment_methods). Manual capture: nothing is captured until every seller is authorized.
 */
export async function createCardIntents(db: DatabaseSync, cartId: string, botId: string, charges: SellerCharge[]): Promise<PendingCardIntent[]> {
  if (charges.some((c) => !c.stripeAccountId || c.stripeAccountId.startsWith("acct_mock"))) {
    throw new ApiError(422, "seller_unavailable", "A seller in this cart can't accept payments right now. Nothing was charged.");
  }
  const stripe = await stripeCardClient();
  const out: PendingCardIntent[] = [];
  for (const charge of charges) {
    const existing = db
      .prepare(`SELECT provider_id, client_secret, status FROM payment_attempts WHERE cart_id = ? AND seller_id = ? AND amount_cents = ? AND status IN ('awaiting_payment','authorized') ORDER BY created_at DESC LIMIT 1`)
      .get(cartId, charge.sellerId, charge.amountCents) as { provider_id: string; client_secret: string; status: string } | undefined;
    if (existing?.client_secret) {
      out.push({ seller_id: charge.sellerId, seller_name: charge.sellerName, stripe_account: charge.stripeAccountId, amount_cents: charge.amountCents, client_secret: existing.client_secret, status: existing.status });
      continue;
    }
    const intent = await stripe.createIntent(
      {
        amount: charge.amountCents,
        currency: charge.currency,
        capture_method: "manual",
        automatic_payment_methods: { enabled: true },
        ...(charge.feeCents > 0 ? { application_fee_amount: charge.feeCents } : {}),
        statement_descriptor_suffix: charge.statementDescriptor.slice(0, 22),
        metadata: { cart_id: cartId, bot_client_id: botId, seller_id: charge.sellerId },
      },
      { stripeAccount: charge.stripeAccountId, idempotencyKey: `mv_pi_${cartId}_${charge.sellerId}_${charge.amountCents}` },
    );
    if (!intent.client_secret) throw new ApiError(502, "stripe_unavailable", "Stripe did not return a payment session. Nothing was charged.");
    insertAttempt(db, cartId, charge, "awaiting_payment", intent.id, null);
    run(db, `UPDATE payment_attempts SET client_secret = ? WHERE provider_id = ?`, intent.client_secret, intent.id);
    log(db, cartId, charge.sellerId, "intent");
    out.push({ seller_id: charge.sellerId, seller_name: charge.sellerName, stripe_account: charge.stripeAccountId, amount_cents: charge.amountCents, client_secret: intent.client_secret, status: "awaiting_payment" });
  }
  return out;
}

/** Map a PaymentIntent status onto our attempt row. Idempotent: replays and out-of-order events are no-ops. */
export function applyIntentStatus(db: DatabaseSync, intentId: string, status: string, failureCode?: string | null): string | null {
  const row = db.prepare(`SELECT cart_id, seller_id, status FROM payment_attempts WHERE provider_id = ?`).get(intentId) as
    | { cart_id: string; seller_id: string; status: string }
    | undefined;
  if (!row) return null;
  const rank: Record<string, number> = { awaiting_payment: 0, failed: 0, authorized: 1, captured: 2, voided: 3 };
  let next = row.status;
  if (status === "requires_capture") next = "authorized";
  else if (status === "succeeded") next = "captured";
  else if (status === "canceled") next = "voided";
  else if (status === "requires_payment_method" && failureCode) next = "failed";
  if (next !== row.status && (rank[next] ?? 0) >= (rank[row.status] ?? 0)) {
    run(db, `UPDATE payment_attempts SET status = ?, failure_code = ?, updated_at = ? WHERE provider_id = ?`, next, failureCode ?? null, nowIso(), intentId);
    log(db, row.cart_id, row.seller_id, next);
  }
  return row.cart_id;
}

/** Capture every authorized intent once all sellers in the cart are authorized. Returns true when all are captured. */
export async function captureIfReady(db: DatabaseSync, cartId: string): Promise<boolean> {
  const rows = db.prepare(`SELECT provider_id, stripe_account_id, status FROM payment_attempts WHERE cart_id = ? AND status != 'voided' AND status != 'failed'`).all(cartId) as {
    provider_id: string;
    stripe_account_id: string;
    status: string;
  }[];
  if (!rows.length || rows.some((r) => r.status === "awaiting_payment")) return false;
  const { cartHasFirstParty, queueForApproval, captureAllowed } = await import("./cj-store");
  if (cartHasFirstParty(db, cartId) && !captureAllowed(db, cartId)) {
    // Mercavine Store orders wait, authorized but uncaptured, for an admin to approve.
    queueForApproval(db, cartId);
    return false;
  }
  const stripe = await stripeCardClient();
  for (const r of rows.filter((x) => x.status === "authorized")) {
    const intent = await stripe.captureIntent(r.provider_id, { stripeAccount: r.stripe_account_id, idempotencyKey: `mv_cap_${r.provider_id}` });
    applyIntentStatus(db, r.provider_id, intent.status);
  }
  const after = db.prepare(`SELECT COUNT(*) AS n FROM payment_attempts WHERE cart_id = ? AND status = 'authorized'`).get(cartId) as { n: number };
  return after.n === 0;
}

export async function settleCharges(
  db: DatabaseSync,
  cartId: string,
  botId: string,
  charges: SellerCharge[],
  failSellerId?: string,
): Promise<SettleResult> {
  void botId;
  return mockSettle(db, cartId, charges, failSellerId);
}
