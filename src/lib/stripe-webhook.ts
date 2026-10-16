import { nowIso } from "./clock";
import { getDb } from "./db";
import { applyIntentStatus } from "./payments";
import type { StripeAccountState } from "./sellers";

type Evt = { id?: string; type?: string; account?: string; data?: { object?: Record<string, unknown> } };
type Deps = {
  applyStripeAccountState: (state: StripeAccountState) => unknown;
  settleCardCart: (cartId: string) => Promise<boolean>;
  noteCardFailure: (cartId: string, code: string) => void;
};

const str = (v: unknown) => (typeof v === "string" ? v : null);

/**
 * Idempotent Stripe event handler. Each event id is recorded once in stripe_events; replays return
 * { duplicate: true } and change nothing. State updates are also monotonic, so out-of-order events are safe.
 */
export async function handleStripeEvent(event: Evt, deps: Deps): Promise<{ duplicate?: boolean; handled?: string }> {
  const db = getDb();
  const id = str(event.id);
  const type = str(event.type) ?? "";
  if (id) {
    const seen = db.prepare(`INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)`).run(id, type, nowIso());
    if (seen.changes === 0) return { duplicate: true };
  }
  const obj = event.data?.object ?? {};
  const meta = (obj.metadata ?? {}) as Record<string, unknown>;
  try {
    switch (type) {
      case "account.updated": {
        const acct = str(obj.id);
        if (acct) {
          deps.applyStripeAccountState({
            id: acct,
            charges_enabled: obj.charges_enabled === true,
            payouts_enabled: obj.payouts_enabled === true,
            details_submitted: obj.details_submitted === true,
          });
        }
        return { handled: type };
      }
      case "payment_intent.amount_capturable_updated":
      case "payment_intent.succeeded": {
        const pi = str(obj.id);
        const cartId = pi ? applyIntentStatus(db, pi, str(obj.status) ?? (type.endsWith("succeeded") ? "succeeded" : "requires_capture")) : null;
        if (cartId) await deps.settleCardCart(cartId);
        if (pi && type === "payment_intent.succeeded") {
          db.prepare(`UPDATE orders SET payment_status = 'paid', updated_at = ? WHERE stripe_payment_intent_id = ? AND payment_status = 'pending'`).run(nowIso(), pi);
        }
        return { handled: type };
      }
      case "payment_intent.payment_failed": {
        const pi = str(obj.id);
        const err = (obj.last_payment_error ?? {}) as Record<string, unknown>;
        const code = str(err.decline_code) ?? str(err.code) ?? "card_declined";
        const cartId = pi ? applyIntentStatus(db, pi, "requires_payment_method", code) : null;
        if (pi) db.prepare(`UPDATE orders SET payment_status = 'failed', updated_at = ? WHERE stripe_payment_intent_id = ? AND payment_status = 'pending'`).run(nowIso(), pi);
        if (cartId ?? str(meta.cart_id)) deps.noteCardFailure((cartId ?? str(meta.cart_id))!, code);
        return { handled: type };
      }
      case "payment_intent.canceled": {
        const pi = str(obj.id);
        if (pi) applyIntentStatus(db, pi, "canceled");
        return { handled: type };
      }
      case "charge.refunded": {
        const pi = str(obj.payment_intent);
        if (pi) {
          const full = obj.refunded === true || (typeof obj.amount_refunded === "number" && obj.amount_refunded >= (obj.amount as number));
          db.prepare(`UPDATE orders SET payment_status = ?, updated_at = ? WHERE stripe_payment_intent_id = ?`).run(full ? "refunded" : "partially_refunded", nowIso(), pi);
        }
        return { handled: type };
      }
      case "charge.dispute.created": {
        const pi = str(obj.payment_intent);
        if (pi) db.prepare(`UPDATE orders SET payment_status = 'disputed', updated_at = ? WHERE stripe_payment_intent_id = ?`).run(nowIso(), pi);
        return { handled: type };
      }
      default:
        return { handled: "ignored" };
    }
  } catch (error) {
    // Let Stripe retry: forget the event so the retry is processed.
    if (id) db.prepare(`DELETE FROM stripe_events WHERE id = ?`).run(id);
    throw error;
  }
}
