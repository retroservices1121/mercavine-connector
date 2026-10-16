import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { config, sellerStripeAccount } from "./config";
import { newId } from "./ids";
import { platformFeeCents } from "./money";
import { run } from "./sql";

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

export async function stripeSettle(db: DatabaseSync, cartId: string, botId: string, charges: SellerCharge[]): Promise<SettleResult> {
  const key = config().stripeSecretKey;
  if (!key) return mockSettle(db, cartId, charges);
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);
  const paymentMethod = process.env.STRIPE_TEST_PAYMENT_METHOD?.trim() || "pm_card_visa";
  const authorized: { charge: SellerCharge; providerId: string }[] = [];
  try {
    for (const charge of charges) {
      const intent = await stripe.paymentIntents.create(
        {
          amount: charge.amountCents,
          currency: charge.currency,
          payment_method: paymentMethod,
          confirm: true,
          capture_method: "manual",
          application_fee_amount: charge.feeCents,
          statement_descriptor_suffix: charge.statementDescriptor.slice(0, 22),
          metadata: { cart_id: cartId, bot_client_id: botId, seller_id: charge.sellerId },
        },
        { stripeAccount: charge.stripeAccountId },
      );
      if (intent.status === "requires_action") {
        log(db, cartId, charge.sellerId, "fail");
        insertAttempt(db, cartId, charge, "failed", intent.id, "authentication_failed");
        await voidAuthorized(stripe, cartId, db, authorized);
        return { ok: false, code: "authentication_failed" };
      }
      if (intent.status !== "requires_capture") {
        log(db, cartId, charge.sellerId, "fail");
        insertAttempt(db, cartId, charge, "failed", intent.id, "card_declined");
        await voidAuthorized(stripe, cartId, db, authorized);
        return { ok: false, code: "card_declined" };
      }
      log(db, cartId, charge.sellerId, "authorize");
      insertAttempt(db, cartId, charge, "authorized", intent.id, null);
      authorized.push({ charge, providerId: intent.id });
    }
    for (const prev of authorized) {
      await stripe.paymentIntents.capture(prev.providerId, {}, { stripeAccount: prev.charge.stripeAccountId });
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
  } catch {
    await voidAuthorized(stripe, cartId, db, authorized);
    return { ok: false, code: "processing_error" };
  }
}

async function voidAuthorized(
  stripe: { paymentIntents: { cancel: (id: string, params: object, opts: { stripeAccount: string }) => Promise<unknown> } },
  cartId: string,
  db: DatabaseSync,
  authorized: { charge: SellerCharge; providerId: string }[],
) {
  for (const prev of authorized) {
    try {
      await stripe.paymentIntents.cancel(prev.providerId, {}, { stripeAccount: prev.charge.stripeAccountId });
    } catch {
      /* already canceled */
    }
    log(db, cartId, prev.charge.sellerId, "void");
    run(db, `UPDATE payment_attempts SET status = 'voided' WHERE cart_id = ? AND provider_id = ?`, cartId, prev.providerId);
  }
}

export async function settleCharges(
  db: DatabaseSync,
  cartId: string,
  botId: string,
  charges: SellerCharge[],
  failSellerId?: string,
): Promise<SettleResult> {
  if (config().paymentMode === "mock" || failSellerId) return mockSettle(db, cartId, charges, failSellerId);
  return stripeSettle(db, cartId, botId, charges);
}
