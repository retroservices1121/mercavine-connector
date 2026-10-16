import { securityAlert } from "./monitoring";
import { assertEmailVerified } from "./email-auth";
import { sellerVisibleSql } from "./catalog";
import type { DatabaseSync } from "node:sqlite";
import { fulfillNativeOrder } from "./amazon-mcf";
import type { BotRecord } from "./auth";
import { hasPasskey } from "./auth";
import { addDays, addHours, addMinutes, now, nowIso } from "./clock";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { emit, notify } from "./events";
import { ApiError } from "./errors";
import { mintApprovalSecret, newId, sha256 } from "./ids";
import { withIdempotency, type IdemResult } from "./idempotency";
import { applicationFee, feePercentLabel, money, taxBpsForRegion, taxCents } from "./money";
import { applyIntentStatus, buildCharge, captureIfReady, createCardIntents, mockSettle, settleCharges, stripeCardClient, type PendingCardIntent, type SellerCharge } from "./payments";
import { assertBotSafe } from "./redact";
import { shopifyHandoffMessage, SPONSORED_DISCLOSURE, SPONSORED_LABEL, type ShopifyPlacement } from "./shopify";
import { assertShopPayFee, claimShopPay, markShopPayPaid, openShopPayRequest, readShopPay, shopPayPublic, shopPayRuntime } from "./shop-pay";
import { many, one, run } from "./sql";

type CartRow = {
  id: string;
  user_id: string;
  bot_client_id: string;
  status: string;
  version: number;
  lane: string;
  shipping_address_id: string | null;
  note_for_human: string | null;
  client_reference: string | null;
  lock_expires_at: string | null;
  lock_extended: number;
  status_reason: string | null;
  approval_requested_at: string | null;
  approval_viewed_at: string | null;
  decided_at: string | null;
  decided_by: string | null;
  approval_method: string | null;
  decline_reason: string | null;
  decline_note: string | null;
  share_decline_note: number;
  created_at: string;
  updated_at: string;
};

type LineRow = {
  id: string;
  cart_id: string;
  offer_id: string | null;
  provider: string;
  external_id: string | null;
  seller_id: string;
  seller_name: string;
  title: string;
  variant_label: string | null;
  category: string | null;
  quantity: number;
  unit_price_cents: number;
  currency: string;
  shipping_cents: number;
  eta_min_days: number;
  eta_max_days: number;
  return_window_days: number;
  restocking_fee_pct: number;
  status: string;
  continue_url: string | null;
  placement_json: string | null;
};

type AddressRow = {
  id: string;
  label: string;
  recipient: string;
  line1: string;
  line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  country: string;
  user_id: string;
};

type OfferJoin = {
  id: string;
  product_id: string;
  seller_id: string;
  title: string;
  category: string;
  seller_name: string;
  variant_label: string | null;
  price_cents: number;
  currency: string;
  shipping_cents: number;
  eta_min_days: number;
  eta_max_days: number;
  lock_ttl_minutes: number;
  return_window_days: number;
  restocking_fee_pct: number;
  statement_descriptor: string;
  stripe_account_id: string;
  rating: number;
  rating_count: number;
};

export type LineInput = {
  offer_id?: string;
  quantity: number;
  provider?: "native" | "shopify" | "shop";
  external_id?: string;
  title?: string;
  seller_name?: string;
  seller_id?: string;
  unit_price?: number;
  continue_url?: string;
  placement?: ShopifyPlacement | null;
  /** Set only by verifyShopLines. Client JSON must not be trusted. */
  verifiedByServer?: boolean;
};

const NEXT: Record<string, string> = {
  submit: "pending_approval",
  cancel: "cancelled",
  decline: "declined",
  expire: "expired",
  approve: "approved",
  payment_failed: "pending_approval",
  paid: "paid",
  shop_pay_wait: "pending_shop_pay",
  shop_pay_paid: "paid",
};

const FROM: Record<string, string[]> = {
  submit: ["draft"],
  cancel: ["draft", "pending_approval", "pending_shop_pay"],
  decline: ["pending_approval"],
  expire: ["draft", "pending_approval"],
  approve: ["pending_approval"],
  payment_failed: ["approved"],
  paid: ["approved"],
  shop_pay_wait: ["approved"],
  shop_pay_paid: ["pending_shop_pay"],
};

function mustCart(db: DatabaseSync, id: string): CartRow {
  const cart = one<CartRow>(db, `SELECT * FROM carts WHERE id = ?`, id);
  if (!cart) throw new ApiError(404, "not_found", "Cart not found.");
  return cart;
}

function linesOf(db: DatabaseSync, cartId: string): LineRow[] {
  return many<LineRow>(db, `SELECT * FROM cart_lines WHERE cart_id = ? ORDER BY id`, cartId);
}

function plainNote(value?: string | null): string | null {
  if (!value) return null;
  const cleaned = value.replace(/https?:\/\/\S+/gi, "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, 500);
  return cleaned || null;
}

function addressFor(db: DatabaseSync, userId: string, requested?: string | null): AddressRow {
  if (requested) {
    const row = one<AddressRow>(db, `SELECT * FROM addresses WHERE id = ? AND user_id = ?`, requested, userId);
    if (!row) throw new ApiError(422, "address_not_found", "That saved address is not on this account.");
    return row;
  }
  const row = one<AddressRow>(db, `SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC, id LIMIT 1`, userId);
  if (!row) throw new ApiError(422, "address_required", "Add a shipping address before checkout.");
  return row;
}

function sellable(db: DatabaseSync, offerId: string): number {
  const offer = one<{ stock: number }>(db, `SELECT stock FROM offers WHERE id = ?`, offerId);
  if (!offer) return 0;
  const held = one<{ q: number }>(
    db,
    `SELECT COALESCE(SUM(qty), 0) AS q FROM inventory_reservations WHERE offer_id = ? AND status = 'held' AND expires_at > ?`,
    offerId,
    nowIso(),
  );
  return offer.stock - (held?.q ?? 0);
}

function transition(db: DatabaseSync, cartId: string, event: keyof typeof NEXT, patch: Record<string, string | number | null> = {}) {
  const cart = mustCart(db, cartId);
  if (!FROM[event].includes(cart.status)) {
    throw new ApiError(409, "invalid_state", `Cannot ${event} a cart that is ${cart.status}.`, { status: cart.status });
  }
  const sets = ["status = ?", "updated_at = ?"];
  const params: (string | number | null)[] = [NEXT[event], nowIso()];
  for (const [key, value] of Object.entries(patch)) {
    sets.push(`${key} = ?`);
    params.push(value);
  }
  params.push(cartId);
  run(db, `UPDATE carts SET ${sets.join(", ")} WHERE id = ?`, ...params);
  return mustCart(db, cartId);
}

function releaseLocks(db: DatabaseSync, cartId: string) {
  run(db, `UPDATE inventory_reservations SET status = 'released' WHERE cart_id = ? AND status = 'held'`, cartId);
  run(db, `UPDATE approval_tokens SET revoked_at = ? WHERE cart_id = ? AND consumed_at IS NULL AND revoked_at IS NULL`, nowIso(), cartId);
}

function commitStock(db: DatabaseSync, cartId: string) {
  const rows = many<{ offer_id: string; qty: number }>(
    db,
    `SELECT offer_id, qty FROM inventory_reservations WHERE cart_id = ? AND status = 'held'`,
    cartId,
  );
  for (const row of rows) {
    const result = db.prepare(`UPDATE offers SET stock = stock - ? WHERE id = ? AND stock >= ?`).run(row.qty, row.offer_id, row.qty);
    if (result.changes !== 1) throw new ApiError(409, "insufficient_stock", "Reserved stock was no longer available at capture.");
  }
  run(db, `UPDATE inventory_reservations SET status = 'committed' WHERE cart_id = ? AND status = 'held'`, cartId);
  run(db, `UPDATE cart_lines SET status = 'committed' WHERE cart_id = ? AND status = 'reserved'`, cartId);
}

export function sweepExpired(): number {
  return transaction((db) => sweepIn(db));
}

function sweepIn(db: DatabaseSync): number {
  const at = nowIso();
  const cutoff = new Date(now().getTime() - config().draftTtlHours * 3_600_000).toISOString();
  const pending = many<{ id: string }>(db, `SELECT id FROM carts WHERE status = 'pending_approval' AND lock_expires_at IS NOT NULL AND lock_expires_at < ?`, at);
  const drafts = many<{ id: string }>(db, `SELECT id FROM carts WHERE status = 'draft' AND updated_at < ?`, cutoff);
  for (const cart of [...pending, ...drafts]) expireCart(db, cart.id);
  return pending.length + drafts.length;
}

function expireCart(db: DatabaseSync, cartId: string) {
  const cart = mustCart(db, cartId);
  if (cart.status !== "pending_approval" && cart.status !== "draft") return;
  if (cart.status === "pending_approval" && cart.lock_expires_at && cart.lock_expires_at >= nowIso()) return;
  transition(db, cartId, "expire", { status_reason: cart.status === "draft" ? "idle" : "lock_ttl" });
  releaseLocks(db, cartId);
  emit(db, {
    type: "cart.expired",
    userId: cart.user_id,
    botId: cart.bot_client_id,
    cartId,
    data: { cart_id: cartId, version: cart.version, status: "expired" },
    actorType: "system",
  });
}

function quote(db: DatabaseSync, cart: CartRow) {
  const lines = linesOf(db, cart.id);
  const address = cart.shipping_address_id
    ? one<AddressRow>(db, `SELECT * FROM addresses WHERE id = ?`, cart.shipping_address_id)
    : undefined;
  const bps = cart.lane === "shop_pay" ? 0 : taxBpsForRegion(address?.region, config().defaultTaxBps);
  const groups = new Map<string, {
    seller: { id: string; name: string; rating: number; rating_count: number; statement_descriptor: string; stripe_account_id: string };
    lines: LineRow[];
    subtotal: number;
    shipping: number;
    tax: number;
    total: number;
    taxPending: boolean;
    firstParty: boolean;
  }>();
  for (const line of lines) {
    let group = groups.get(line.seller_id);
    if (!group) {
      const seller = one<{ rating: number; rating_count: number; statement_descriptor: string; stripe_account_id: string; first_party: number }>(
        db,
        `SELECT rating, rating_count, statement_descriptor, stripe_account_id, first_party FROM sellers WHERE id = ?`,
        line.seller_id,
      );
      group = {
        seller: {
          id: line.seller_id,
          name: line.seller_name,
          rating: seller?.rating ?? 0,
          rating_count: seller?.rating_count ?? 0,
          statement_descriptor: seller?.statement_descriptor ?? line.seller_name,
          stripe_account_id: seller?.stripe_account_id ?? "",
        },
        lines: [],
        subtotal: 0,
        shipping: 0,
        tax: 0,
        total: 0,
        taxPending: false,
        firstParty: seller?.first_party === 1,
      };
      groups.set(line.seller_id, group);
    }
    group.lines.push(line);
    if (line.status === "unavailable") continue;
    group.subtotal += line.unit_price_cents * line.quantity;
    group.shipping += line.shipping_cents;
  }
  let subtotal = 0;
  let shipping = 0;
  let tax = 0;
  for (const group of groups.values()) {
    if (group.firstParty) {
      // Mercavine Store: tax comes only from a stored quote computed on exactly this basis (tax.ts).
      const tq = one<{ basis: string; tax_cents: number }>(db, `SELECT basis, tax_cents FROM tax_quotes WHERE cart_id = ? AND seller_id = ?`, cart.id, group.seller.id);
      const fresh = tq !== undefined && tq.basis === taxBasis(group.subtotal, group.shipping, address);
      group.tax = fresh ? tq.tax_cents : 0;
      group.taxPending = !fresh && cart.lane !== "shop_pay";
    } else {
      group.tax = taxCents(group.subtotal + group.shipping, bps);
    }
    group.total = group.subtotal + group.shipping + group.tax;
    subtotal += group.subtotal;
    shipping += group.shipping;
    tax += group.tax;
  }
  return { lines, address, taxBps: bps, groups: [...groups.values()], subtotal, shipping, tax, grand: subtotal + shipping + tax };
}

/** What a first-party tax quote was computed on. Any change (price, qty, shipping, address) invalidates it. */
export function taxBasis(subtotal: number, shipping: number, address: AddressRow | undefined): string {
  return [subtotal, shipping, address?.id ?? "", address?.line1 ?? "", address?.city ?? "", (address?.region ?? "").toUpperCase(), address?.postal_code ?? ""].join("|");
}

function paymentStatus(cart: CartRow): "pending" | "authorized" | "paid" | "failed" | "refunded" {
  if (cart.status === "paid") return "paid";
  if (cart.status === "approved") return "authorized";
  if (cart.status_reason === "payment_failed") return "failed";
  return "pending";
}

function orderIds(db: DatabaseSync, cartId: string): string[] {
  return many<{ id: string }>(db, `SELECT id FROM orders WHERE cart_id = ? ORDER BY id`, cartId).map((row) => row.id);
}

export function toBotCart(db: DatabaseSync, cartId: string) {
  const cart = mustCart(db, cartId);
  const bot = one<{ name: string }>(db, `SELECT name FROM bots WHERE id = ?`, cart.bot_client_id);
  const view = quote(db, cart);
  const today = now();
  const payload = {
    id: cart.id,
    status: cart.status,
    version: cart.version,
    lane: cart.lane,
    user_id: cart.user_id,
    bot_client_id: cart.bot_client_id,
    bot_name: bot?.name ?? "Bot",
    created_at: cart.created_at,
    lock_expires_at: cart.lock_expires_at,
    client_reference: cart.client_reference,
    note_for_human: cart.note_for_human,
    shipping_address: view.address
      ? { id: view.address.id, label: view.address.label, city: view.address.city, region: view.address.region }
      : null,
    seller_groups: view.groups.map((group) => ({
      seller: { id: group.seller.id, name: group.seller.name },
      merchant_of_record: true,
      lines: group.lines.map((line) => ({
        line_id: line.id,
        offer_id: line.offer_id,
        title: line.title,
        variant: line.variant_label,
        quantity: line.quantity,
        unit_price: line.unit_price_cents,
        status: line.status,
        shipping_est: { amount: line.shipping_cents, eta: [addDays(today, line.eta_min_days), addDays(today, line.eta_max_days)] },
      })),
      shipping: group.shipping,
      tax: group.tax,
      ...(group.firstParty ? { tax_status: group.taxPending ? "calculated_at_checkout" : "calculated" } : {}),
      subtotal: group.subtotal,
      total: group.total,
    })),
    totals: { subtotal: view.subtotal, shipping: view.shipping, tax: view.tax, grand_total: money(view.grand), currency: "usd" },
    payment_status: paymentStatus(cart),
    approval: {
      requested_at: cart.approval_requested_at,
      viewed_at: cart.approval_viewed_at,
      decided_at: cart.decided_at,
      decided_by: cart.decided_by,
      method: cart.approval_method,
      decline_reason: cart.decline_reason,
    },
    status_reason: cart.status_reason,
    order_ids: orderIds(db, cart.id),
    shop_pay: cart.lane === "shop_pay" ? shopPayPublic(readShopPay(cart.id)) : null,
    platform_fee_applies: cart.lane !== "shop_pay",
  };
  if (process.env.NODE_ENV !== "production") assertBotSafe(payload);
  return payload;
}

export function toHumanCart(db: DatabaseSync, cartId: string) {
  const cart = mustCart(db, cartId);
  const bot = toBotCart(db, cartId);
  const view = quote(db, cart);
  const botRow = one<{ name: string; approval_threshold_cents: number; per_month_limit_cents: number }>(
    db,
    `SELECT name, approval_threshold_cents, per_month_limit_cents FROM bots WHERE id = ?`,
    cart.bot_client_id,
  );
  const monthStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 1)).toISOString();
  const spent = one<{ s: number }>(
    db,
    `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spend_ledger WHERE bot_client_id = ? AND created_at >= ?`,
    cart.bot_client_id,
    monthStart,
  );
  const shopPay = cart.lane === "shop_pay";
  const feeBps = shopPay ? 0 : config().platformFeeBps;
  return {
    ...bot,
    shipping_address_full: view.address ? { ...view.address } : null,
    changes_pending: view.lines.some((line) => line.status === "unavailable"),
    fee_bps: feeBps,
    fee_label: feePercentLabel(feeBps),
    payment_mode: config().paymentMode,
    platform_fee_applies: !shopPay,
    seller_fees: view.groups.filter((group) => group.total > 0).map((group) => ({
      seller_id: group.seller.id,
      seller_name: group.seller.name,
      charge_cents: group.total,
      fee_cents: shopPay ? 0 : applicationFee(group.total, feeBps),
    })),
    limits: {
      spent_month_cents: spent?.s ?? 0,
      month_limit_cents: botRow?.per_month_limit_cents ?? 0,
      threshold_cents: botRow?.approval_threshold_cents ?? 0,
      above_threshold: view.grand > (botRow?.approval_threshold_cents ?? 0),
    },
    bot_name: botRow?.name ?? "Bot",
    saved_addresses: many<AddressRow>(db, `SELECT * FROM addresses WHERE user_id = ? ORDER BY is_default DESC`, cart.user_id).map((row) => ({ ...row })),
  };
}

function insertNativeLine(db: DatabaseSync, cartId: string, offerId: string, quantity: number) {
  const offer = one<OfferJoin>(
    db,
    `SELECT o.id, o.product_id, o.seller_id, o.variant_label, o.price_cents, o.currency, o.shipping_cents,
            o.eta_min_days, o.eta_max_days, o.lock_ttl_minutes, o.return_window_days, o.restocking_fee_pct,
            p.title, p.category, s.name AS seller_name, s.statement_descriptor, s.stripe_account_id, s.rating, s.rating_count
     FROM offers o JOIN products p ON p.id = o.product_id JOIN sellers s ON s.id = o.seller_id WHERE o.id = ? AND ${sellerVisibleSql()}`,
    offerId,
  );
  if (!offer) throw new ApiError(422, "unknown_offer", `Unknown offer ${offerId}.`, { offer_id: offerId });
  const id = newId("cl");
  run(
    db,
    `INSERT INTO cart_lines (
      id, cart_id, offer_id, provider, external_id, seller_id, seller_name, title, variant_label, category,
      quantity, unit_price_cents, currency, shipping_cents, eta_min_days, eta_max_days, return_window_days,
      restocking_fee_pct, status, continue_url
    ) VALUES (?, ?, ?, 'native', NULL, ?, ?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, ?, 'quoted', NULL)`,
    id,
    cartId,
    offer.id,
    offer.seller_id,
    offer.seller_name,
    offer.title,
    offer.variant_label,
    offer.category,
    quantity,
    offer.price_cents,
    offer.shipping_cents,
    offer.eta_min_days,
    offer.eta_max_days,
    offer.return_window_days,
    offer.restocking_fee_pct,
  );
}

function replaceLines(db: DatabaseSync, cartId: string, inputs: LineInput[]) {
  if (!inputs.length) throw new ApiError(422, "empty_cart", "Add at least one line.");
  const providers = new Set(inputs.map((line) => line.provider ?? (line.offer_id ? "native" : "shopify")));
  if (providers.size > 1) {
    throw new ApiError(422, "mixed_checkout_lanes", "A cart is one lane only: Mercavine, Shopify handoff, or Shop Pay.");
  }
  run(db, `DELETE FROM cart_lines WHERE cart_id = ?`, cartId);
  const lane = providers.has("shop") ? "shop_pay" : providers.has("shopify") ? "shopify" : "native";
  run(db, `UPDATE carts SET lane = ?, version = version + 1, updated_at = ? WHERE id = ?`, lane, nowIso(), cartId);
  for (const input of inputs) {
    if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 99) {
      throw new ApiError(422, "bad_quantity", "Quantity must be a whole number from 1 to 99.");
    }
    if (lane === "native") {
      if (!input.offer_id) throw new ApiError(422, "unknown_offer", "Each Mercavine line needs an offer_id.");
      insertNativeLine(db, cartId, input.offer_id, input.quantity);
    } else if (lane === "shop_pay") {
      if (!input.verifiedByServer) throw new ApiError(409, "availability_unverified", "Verify this Shop product before adding it.");
      if (!input.external_id || !input.title || !input.seller_name || input.unit_price == null || !input.continue_url?.startsWith("https://")) {
        throw new ApiError(422, "shop_line_incomplete", "Shop Pay lines need a variant, title, seller, price, and https checkout URL.");
      }
      run(
        db,
        `INSERT INTO cart_lines (
          id, cart_id, offer_id, provider, external_id, seller_id, seller_name, title, variant_label, category,
          quantity, unit_price_cents, currency, shipping_cents, eta_min_days, eta_max_days, return_window_days,
          restocking_fee_pct, status, continue_url
        ) VALUES (?, ?, NULL, 'shop', ?, ?, ?, ?, NULL, 'shop', ?, ?, 'usd', 0, 5, 10, 30, 0, 'quoted', ?)`,
        newId("cl"),
        cartId,
        input.external_id,
        input.seller_id || input.external_id,
        input.seller_name,
        input.title,
        input.quantity,
        input.unit_price,
        input.continue_url,
      );
    } else {
      if (!input.external_id || !input.title || !input.seller_name || input.unit_price == null) {
        throw new ApiError(422, "shopify_line_incomplete", "Shopify lines need external_id, title, seller_name, and unit_price.");
      }
      run(
        db,
        `INSERT INTO cart_lines (
          id, cart_id, offer_id, provider, external_id, seller_id, seller_name, title, variant_label, category,
          quantity, unit_price_cents, currency, shipping_cents, eta_min_days, eta_max_days, return_window_days,
          restocking_fee_pct, status, continue_url, placement_json
        ) VALUES (?, ?, NULL, 'shopify', ?, ?, ?, ?, NULL, 'shopify', ?, ?, 'usd', 0, 5, 10, 30, 0, 'quoted', ?, ?)`,
        newId("cl"),
        cartId,
        input.external_id,
        input.seller_id || input.external_id,
        input.seller_name,
        input.title,
        input.quantity,
        input.unit_price,
        input.continue_url ?? null,
        input.placement?.type ? JSON.stringify({ type: input.placement.type }) : null,
      );
    }
  }
  const sellers = new Set(linesOf(db, cartId).map((line) => line.seller_id));
  if (sellers.size > config().maxSellersPerCart) {
    throw new ApiError(422, "too_many_sellers", `A cart can include at most ${config().maxSellersPerCart} sellers.`);
  }
}

function assertOwner(cart: CartRow, bot: BotRecord) {
  if (cart.bot_client_id !== bot.id || cart.user_id !== bot.user_id) throw new ApiError(404, "not_found", "Cart not found.");
}

export function createCart(input: {
  bot: BotRecord;
  lines?: LineInput[];
  shippingAddressId?: string;
  note?: string;
  clientReference?: string;
  fromCartId?: string;
  idempotencyKey?: string;
}): IdemResult {
  assertEmailVerified(input.bot.user_id);
  const payload = {
    lines: input.lines ?? null,
    shipping_address_id: input.shippingAddressId ?? null,
    note_for_human: input.note ?? null,
    client_reference: input.clientReference ?? null,
    from_cart_id: input.fromCartId ?? null,
  };
  return withIdempotency(input.bot.id, input.idempotencyKey, payload, (db) => {
    sweepIn(db);
    if (input.fromCartId) return cloneCart(db, input.bot, input.fromCartId, input.idempotencyKey);
    if (!input.lines?.length) throw new ApiError(422, "empty_cart", "Add at least one line.");
    const address = addressFor(db, input.bot.user_id, input.shippingAddressId);
    const id = newId("cart");
    const at = nowIso();
    run(
      db,
      `INSERT INTO carts (
        id, user_id, bot_client_id, status, version, lane, shipping_address_id, note_for_human, client_reference,
        lock_expires_at, lock_extended, status_reason, approval_requested_at, approval_viewed_at, decided_at,
        decided_by, approval_method, decline_reason, decline_note, share_decline_note, notify_hint, created_at, updated_at
      ) VALUES (?, ?, ?, 'draft', 0, 'native', ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
      id,
      input.bot.user_id,
      input.bot.id,
      address.id,
      plainNote(input.note),
      input.clientReference?.slice(0, 200) ?? null,
      at,
      at,
    );
    replaceLines(db, id, input.lines);
    emit(db, {
      type: "cart.created",
      userId: input.bot.user_id,
      botId: input.bot.id,
      cartId: id,
      actorType: "bot",
      actorId: input.bot.id,
      data: { cart_id: id, status: "draft" },
    });
    return { status: 201, body: toBotCart(db, id) };
  });
}

function cloneCart(db: DatabaseSync, bot: BotRecord, fromId: string, _key?: string): { status: number; body: unknown } {
  const source = mustCart(db, fromId);
  assertOwner(source, bot);
  if (!["declined", "expired", "cancelled", "paid"].includes(source.status) && source.status !== "handed_off") {
    throw new ApiError(409, "invalid_state", "Only a finished cart can be cloned.", { status: source.status });
  }
  const id = newId("cart");
  const at = nowIso();
  run(
    db,
    `INSERT INTO carts (
      id, user_id, bot_client_id, status, version, lane, shipping_address_id, note_for_human, client_reference,
      lock_expires_at, lock_extended, status_reason, approval_requested_at, approval_viewed_at, decided_at,
      decided_by, approval_method, decline_reason, decline_note, share_decline_note, notify_hint, created_at, updated_at
    ) VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?, NULL, 0, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?, ?)`,
    id,
    bot.user_id,
    bot.id,
    source.lane,
    source.shipping_address_id,
    source.note_for_human,
    source.client_reference,
    at,
    at,
  );
  for (const line of linesOf(db, source.id)) {
    if (line.provider === "native" && line.offer_id) insertNativeLine(db, id, line.offer_id, line.quantity);
    else {
      run(
        db,
        `INSERT INTO cart_lines (
          id, cart_id, offer_id, provider, external_id, seller_id, seller_name, title, variant_label, category,
          quantity, unit_price_cents, currency, shipping_cents, eta_min_days, eta_max_days, return_window_days,
          restocking_fee_pct, status, continue_url, placement_json
        ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'usd', 0, ?, ?, 30, 0, 'quoted', ?, ?)`,
        newId("cl"),
        id,
        line.provider === "shop" ? "shop" : "shopify",
        line.external_id,
        line.seller_id,
        line.seller_name,
        line.title,
        line.variant_label,
        line.provider === "shop" ? "shop" : "shopify",
        line.quantity,
        line.unit_price_cents,
        line.eta_min_days,
        line.eta_max_days,
        line.continue_url,
        line.placement_json,
      );
    }
  }
  return { status: 201, body: toBotCart(db, id) };
}

export function updateCart(input: {
  bot: BotRecord;
  cartId: string;
  lines?: LineInput[];
  shippingAddressId?: string;
  note?: string;
  idempotencyKey?: string;
}): IdemResult {
  const payload = { cart_id: input.cartId, lines: input.lines ?? null, shipping_address_id: input.shippingAddressId ?? null, note_for_human: input.note ?? null };
  return withIdempotency(input.bot.id, input.idempotencyKey, payload, (db) => {
    const cart = mustCart(db, input.cartId);
    assertOwner(cart, input.bot);
    if (cart.status !== "draft") throw new ApiError(409, "invalid_state", "Only a draft cart can be updated.", { status: cart.status });
    if (input.shippingAddressId) {
      const address = addressFor(db, input.bot.user_id, input.shippingAddressId);
      run(db, `UPDATE carts SET shipping_address_id = ? WHERE id = ?`, address.id, cart.id);
    }
    if (input.note !== undefined) run(db, `UPDATE carts SET note_for_human = ? WHERE id = ?`, plainNote(input.note), cart.id);
    if (input.lines) replaceLines(db, cart.id, input.lines);
    else run(db, `UPDATE carts SET version = version + 1, updated_at = ? WHERE id = ?`, nowIso(), cart.id);
    emit(db, {
      type: "cart.updated",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "bot",
      actorId: input.bot.id,
      data: { cart_id: cart.id, version: mustCart(db, cart.id).version },
    });
    return { status: 200, body: toBotCart(db, cart.id) };
  });
}

function fingerprint(lines: LineRow[]): string {
  return lines
    .filter((line) => line.status !== "unavailable" && line.offer_id)
    .map((line) => `${line.offer_id}:${line.quantity}`)
    .sort()
    .join("|");
}

function spendSince(db: DatabaseSync, botId: string, since: string): number {
  return one<{ s: number }>(db, `SELECT COALESCE(SUM(amount_cents), 0) AS s FROM spend_ledger WHERE bot_client_id = ? AND created_at >= ?`, botId, since)?.s ?? 0;
}

export function merchantOrigin(checkoutUrl: string): string {
  try {
    const url = new URL(checkoutUrl);
    return `${url.protocol}//${url.host}`;
  } catch {
    return checkoutUrl;
  }
}

function shopFingerprint(lines: LineRow[]): string {
  return lines
    .filter((line) => line.status !== "unavailable")
    .map((line) => `${line.external_id}:${line.quantity}`)
    .sort()
    .join("|");
}

/** Shop Pay stays on the approval link. It does not reserve native stock and does not auto-charge. */
function submitShopPay(db: DatabaseSync, cart: CartRow, input: { bot: BotRecord; notify?: string[] }): { status: number; body: unknown } {
  if (shopPayRuntime(cart.user_id) === "off") throw new ApiError(403, "shop_pay_disabled", "Shop Pay is off. Set SHOP_PAY_ENABLED=true.");
  if (cart.status !== "draft") throw new ApiError(409, "invalid_state", "Only a draft cart can be submitted.", { status: cart.status });
  const active = linesOf(db, cart.id).filter((line) => line.status !== "unavailable");
  if (!active.length) throw new ApiError(422, "nothing_to_charge", "Every line is unavailable.");
  const sellers = new Set(active.map((line) => line.seller_id));
  if (sellers.size !== 1) throw new ApiError(422, "too_many_sellers", "Shop Pay checkout is one merchant at a time.");
  if (!active[0].continue_url?.startsWith("https://")) {
    throw new ApiError(422, "shop_line_incomplete", "Shop Pay needs an https merchant checkout URL.");
  }
  const print = shopFingerprint(active);
  const pendingCarts = many<{ id: string }>(
    db,
    `SELECT id FROM carts WHERE user_id = ? AND bot_client_id = ? AND status IN ('pending_approval', 'pending_shop_pay') AND id != ?`,
    cart.user_id,
    cart.bot_client_id,
    cart.id,
  );
  for (const dup of pendingCarts) {
    if (shopFingerprint(linesOf(db, dup.id)) === print) {
      throw new ApiError(409, "duplicate_pending_cart", "This bot already has this Shop Pay cart waiting.", { existing_cart_id: dup.id });
    }
  }
  const preview = quote(db, cart);
  if (preview.grand > input.bot.per_order_limit_cents) {
    throw new ApiError(403, "over_limit", "This cart is over the bot's per-order limit.", { limit: "per_order" });
  }
  const dayStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate())).toISOString();
  const monthStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 1)).toISOString();
  if (spendSince(db, input.bot.id, dayStart) + preview.grand > input.bot.per_day_limit_cents) {
    throw new ApiError(403, "over_limit", "This cart would exceed the bot's daily limit.", { limit: "per_day" });
  }
  if (spendSince(db, input.bot.id, monthStart) + preview.grand > input.bot.per_month_limit_cents) {
    throw new ApiError(403, "over_limit", "This cart would exceed the bot's monthly limit.", { limit: "per_month" });
  }
  const expires = addMinutes(now(), config().defaultLockTtlMinutes);
  const secret = mintApprovalSecret();
  transition(db, cart.id, "submit", {
    lock_expires_at: expires,
    approval_requested_at: nowIso(),
    notify_hint: (input.notify ?? []).join(","),
    status_reason: null,
  });
  run(
    db,
    `INSERT INTO approval_tokens (
      id, cart_id, cart_version, user_id, token_hash, expires_at, consumed_at, revoked_at, view_count, view_window_started_at, last_view_at, failed_auth, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 0, ?)`,
    newId("atk"),
    cart.id,
    mustCart(db, cart.id).version,
    cart.user_id,
    secret.hash,
    expires,
    nowIso(),
  );
  const approvalUrl = `${config().publicBaseUrl}/a/${secret.raw}`;
  const summary = toBotCart(db, cart.id);
  const title = `${summary.bot_name} wants Shop Pay approval`;
  const bodyText = `${active.length} item(s), ${money(preview.grand).amount / 100} USD, expires ${expires}. The 3% fee does not apply.`;
  notify(db, cart.user_id, "inapp", title, `${bodyText} Review: ${approvalUrl}`);
  for (const channel of input.notify ?? []) {
    notify(db, cart.user_id, channel, title, `${bodyText} Delivery by ${channel} is not wired in this build.`);
  }
  emit(db, {
    type: "cart.submitted",
    userId: cart.user_id,
    botId: cart.bot_client_id,
    cartId: cart.id,
    actorType: "bot",
    actorId: input.bot.id,
    data: { cart_id: cart.id, version: summary.version, status: "pending_approval", lane: "shop_pay", expires_at: expires },
  });
  const body = { ...summary, approval_url: approvalUrl, expires_at: expires, auto_approved: false };
  if (process.env.NODE_ENV !== "production") assertBotSafe(body);
  return { status: 200, body };
}

export function submitCart(input: {
  bot: BotRecord;
  cartId: string;
  idempotencyKey?: string;
  allowPartial?: boolean;
  notify?: string[];
}): IdemResult {
  assertEmailVerified(input.bot.user_id);
  const payload = { cart_id: input.cartId, allow_partial: Boolean(input.allowPartial), notify: input.notify ?? [] };
  return withIdempotency(input.bot.id, input.idempotencyKey, payload, (db) => {
    sweepIn(db);
    const cart = mustCart(db, input.cartId);
    assertOwner(cart, input.bot);
    if (cart.lane === "shopify") return handoffShopify(db, cart);
    if (cart.lane === "shop_pay") return submitShopPay(db, cart, input);
    if (cart.status !== "draft") throw new ApiError(409, "invalid_state", "Only a draft cart can be submitted.", { status: cart.status });
    const current = linesOf(db, cart.id).filter((line) => line.provider === "native" && line.offer_id);
    const priceChanges: { line_id: string; offer_id: string; quoted_price: number; new_price: number }[] = [];
    const stockProblems: { line_id: string; offer_id: string; requested_qty: number; available_qty: number }[] = [];
    for (const line of current) {
      const offer = one<{ price_cents: number }>(db, `SELECT price_cents FROM offers WHERE id = ?`, line.offer_id);
      if (!offer) throw new ApiError(422, "unknown_offer", "An offer on this cart no longer exists.");
      if (offer.price_cents !== line.unit_price_cents) {
        priceChanges.push({ line_id: line.id, offer_id: line.offer_id!, quoted_price: line.unit_price_cents, new_price: offer.price_cents });
      }
      const available = sellable(db, line.offer_id!);
      if (available < line.quantity) stockProblems.push({ line_id: line.id, offer_id: line.offer_id!, requested_qty: line.quantity, available_qty: available });
    }
    if (priceChanges.length) {
      throw new ApiError(409, "price_changed", "A price changed since this draft was quoted. Update the cart and confirm with the shopper.", { lines: priceChanges });
    }
    if (stockProblems.length && !input.allowPartial) {
      throw new ApiError(409, "insufficient_stock", "Not enough stock to reserve this cart.", { lines: stockProblems });
    }
    for (const problem of stockProblems) {
      if (problem.available_qty <= 0) {
        run(db, `UPDATE cart_lines SET status = 'unavailable' WHERE id = ?`, problem.line_id);
      } else {
        const line = current.find((item) => item.id === problem.line_id)!;
        run(db, `UPDATE cart_lines SET quantity = ?, status = 'quoted' WHERE id = ?`, problem.available_qty, problem.line_id);
        run(
          db,
          `INSERT INTO cart_lines (
            id, cart_id, offer_id, provider, external_id, seller_id, seller_name, title, variant_label, category,
            quantity, unit_price_cents, currency, shipping_cents, eta_min_days, eta_max_days, return_window_days,
            restocking_fee_pct, status, continue_url
          ) VALUES (?, ?, ?, 'native', NULL, ?, ?, ?, ?, ?, ?, ?, 'usd', 0, ?, ?, ?, ?, 'unavailable', NULL)`,
          newId("cl"),
          cart.id,
          line.offer_id,
          line.seller_id,
          line.seller_name,
          line.title,
          line.variant_label,
          line.category,
          problem.requested_qty - problem.available_qty,
          line.unit_price_cents,
          line.eta_min_days,
          line.eta_max_days,
          line.return_window_days,
          line.restocking_fee_pct,
        );
      }
    }
    const fresh = linesOf(db, cart.id);
    const active = fresh.filter((line) => line.status !== "unavailable");
    if (!active.length) throw new ApiError(422, "nothing_to_charge", "Every line is unavailable.");
    const sellers = new Set(active.map((line) => line.seller_id));
    if (sellers.size > config().maxSellersPerCart) throw new ApiError(422, "too_many_sellers", "Too many sellers on this cart.");
    const print = fingerprint(fresh);
    const pendingCarts = many<{ id: string }>(
      db,
      `SELECT id FROM carts WHERE user_id = ? AND bot_client_id = ? AND status = 'pending_approval' AND id != ?`,
      cart.user_id,
      cart.bot_client_id,
      cart.id,
    );
    for (const dup of pendingCarts) {
      if (fingerprint(linesOf(db, dup.id)) === print) {
        throw new ApiError(409, "duplicate_pending_cart", "This bot already has this cart waiting for approval.", { existing_cart_id: dup.id });
      }
    }
    const pendingCount = one<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM carts WHERE user_id = ? AND bot_client_id = ? AND status = 'pending_approval'`,
      cart.user_id,
      cart.bot_client_id,
    );
    if ((pendingCount?.n ?? 0) >= config().maxPendingCarts) {
      throw new ApiError(403, "over_limit", "Too many carts are already waiting for approval.", { limit: "pending_carts", max: config().maxPendingCarts });
    }
    const preview = quote(db, { ...cart, shipping_address_id: cart.shipping_address_id });
    if (preview.grand > input.bot.per_order_limit_cents) {
      throw new ApiError(403, "over_limit", "This cart is over the bot's per-order limit.", { limit: "per_order" });
    }
    const dayStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), now().getUTCDate())).toISOString();
    const monthStart = new Date(Date.UTC(now().getUTCFullYear(), now().getUTCMonth(), 1)).toISOString();
    if (spendSince(db, input.bot.id, dayStart) + preview.grand > input.bot.per_day_limit_cents) {
      throw new ApiError(403, "over_limit", "This cart would exceed the bot's daily limit.", { limit: "per_day" });
    }
    if (spendSince(db, input.bot.id, monthStart) + preview.grand > input.bot.per_month_limit_cents) {
      throw new ApiError(403, "over_limit", "This cart would exceed the bot's monthly limit.", { limit: "per_month" });
    }
    for (const line of active) {
      if (line.category && !input.bot.allowed_categories.includes(line.category)) {
        throw new ApiError(403, "over_limit", `Category ${line.category} is not allowed for this bot.`, { limit: "category", category: line.category });
      }
    }
    let ttl = config().defaultLockTtlMinutes;
    for (const line of active) {
      if (!line.offer_id) continue;
      const offer = one<{ lock_ttl_minutes: number }>(db, `SELECT lock_ttl_minutes FROM offers WHERE id = ?`, line.offer_id);
      ttl = Math.min(ttl, offer?.lock_ttl_minutes ?? ttl);
      run(
        db,
        `INSERT INTO inventory_reservations (id, cart_id, line_id, offer_id, qty, unit_price_cents, shipping_cents, expires_at, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'held')`,
        newId("rsv"),
        cart.id,
        line.id,
        line.offer_id,
        line.quantity,
        line.unit_price_cents,
        line.shipping_cents,
        addMinutes(now(), ttl),
      );
      run(db, `UPDATE cart_lines SET status = 'reserved' WHERE id = ?`, line.id);
    }
    const expires = addMinutes(now(), ttl);
    const secret = mintApprovalSecret();
    transition(db, cart.id, "submit", {
      lock_expires_at: expires,
      approval_requested_at: nowIso(),
      notify_hint: (input.notify ?? []).join(","),
      status_reason: null,
    });
    run(
      db,
      `INSERT INTO approval_tokens (
        id, cart_id, cart_version, user_id, token_hash, expires_at, consumed_at, revoked_at, view_count, view_window_started_at, last_view_at, failed_auth, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 0, ?)`,
      newId("atk"),
      cart.id,
      mustCart(db, cart.id).version,
      cart.user_id,
      secret.hash,
      expires,
      nowIso(),
    );
    const approvalUrl = `${config().publicBaseUrl}/a/${secret.raw}`;
    const summary = toBotCart(db, cart.id);
    const title = `${summary.bot_name} wants approval`;
    const bodyText = `${active.length} item(s), ${money(preview.grand).amount / 100} USD, expires ${expires}.`;
    notify(db, cart.user_id, "inapp", title, `${bodyText} Review: ${approvalUrl}`);
    for (const channel of input.notify ?? []) {
      notify(db, cart.user_id, channel, title, `${bodyText} Delivery by ${channel} is not wired in this build.`);
    }
    emit(db, {
      type: "cart.submitted",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "bot",
      actorId: input.bot.id,
      data: { cart_id: cart.id, version: summary.version, status: "pending_approval", expires_at: expires },
    });
    let body: Record<string, unknown> = {
      ...summary,
      approval_url: approvalUrl,
      expires_at: expires,
      auto_approved: false,
      ...(config().paymentMode === "stripe"
        ? {
            payment_url: approvalUrl,
            checkout_mode: "hosted_payment_link",
            payment_note: "Send the shopper this link. They approve and pay on Mercavine with card, Link, Apple Pay or Google Pay. Card details never pass through the bot.",
          }
        : {}),
    };
    if (autoMatches(db, input.bot, cart.id) && config().paymentMode === "mock") {
      body = autoApprove(db, cart.id, input.bot, approvalUrl);
    }
    return { status: 200, body };
  });
}

function autoMatches(db: DatabaseSync, bot: BotRecord, cartId: string): boolean {
  const rule = one<{ max_per_order_cents: number; allowed_categories: string; seller_allowlist: string | null }>(
    db,
    `SELECT max_per_order_cents, allowed_categories, seller_allowlist FROM auto_rules WHERE bot_client_id = ? AND user_id = ? AND enabled = 1`,
    bot.id,
    bot.user_id,
  );
  if (!rule) return false;
  const view = quote(db, mustCart(db, cartId));
  if (view.grand > rule.max_per_order_cents || view.grand > bot.approval_threshold_cents) return false;
  const categories = JSON.parse(rule.allowed_categories) as string[];
  const allow = rule.seller_allowlist ? (JSON.parse(rule.seller_allowlist) as string[]) : null;
  for (const line of view.lines) {
    if (line.status === "unavailable") continue;
    if (line.category && !categories.includes(line.category)) return false;
    if (allow && !allow.includes(line.seller_id)) return false;
  }
  return true;
}

function chargesFor(db: DatabaseSync, cartId: string): SellerCharge[] {
  const view = quote(db, mustCart(db, cartId));
  if (view.groups.some((group) => group.taxPending)) {
    // Fail closed: never create a payment for a first-party group without a current tax quote.
    throw new ApiError(409, "tax_required", "Sales tax for this order needs to be recalculated. Nothing was charged.");
  }
  return view.groups
    .filter((group) => group.total > 0)
    .map((group) =>
      buildCharge({
        sellerId: group.seller.id,
        sellerName: group.seller.name,
        storedStripeAccountId: group.seller.stripe_account_id,
        statementDescriptor: group.seller.statement_descriptor,
        amountCents: group.total,
      }),
    );
}

function finalizePaid(db: DatabaseSync, cartId: string, method: string, decidedBy: string) {
  const cart = transition(db, cartId, "paid", { decided_at: nowIso(), decided_by: decidedBy, approval_method: method, status_reason: null });
  const view = quote(db, cart);
  const attempts = many<{ seller_id: string; provider_id: string; stripe_account_id: string; fee_cents: number }>(
    db,
    `SELECT seller_id, provider_id, stripe_account_id, fee_cents FROM payment_attempts WHERE cart_id = ? AND status = 'captured'`,
    cartId,
  );
  const ids: string[] = [];
  for (const group of view.groups) {
    if (group.total <= 0) continue;
    const orderId = newId("ord");
    const attempt = attempts.find((row) => row.seller_id === group.seller.id);
    const etaStart = addDays(now(), Math.min(...group.lines.map((line) => line.eta_min_days)));
    const etaEnd = addDays(now(), Math.max(...group.lines.map((line) => line.eta_max_days)));
    run(
      db,
      `INSERT INTO orders (
        id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents,
        tax_cents, total_cents, application_fee_cents, payment_status, stripe_payment_intent_id, stripe_account_id,
        tracking_carrier, tracking_number, ship_eta_start, ship_eta_end, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, 'created', 'usd', ?, ?, ?, ?, ?, 'paid', ?, ?, NULL, NULL, ?, ?, ?, ?)`,
      orderId,
      cartId,
      cart.user_id,
      cart.bot_client_id,
      group.seller.id,
      group.seller.name,
      group.subtotal,
      group.shipping,
      group.tax,
      group.total,
      attempt?.fee_cents ?? 0,
      attempt?.provider_id ?? null,
      attempt?.stripe_account_id ?? null,
      etaStart,
      etaEnd,
      nowIso(),
      nowIso(),
    );
    for (const line of group.lines.filter((item) => item.status !== "unavailable")) {
      run(
        db,
        `INSERT INTO order_lines (id, order_id, cart_line_id, title, variant_label, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId("ol"),
        orderId,
        line.id,
        line.title,
        line.variant_label,
        line.quantity,
        line.unit_price_cents,
      );
    }
    fulfillNativeOrder(db, {
      orderId,
      sellerId: group.seller.id,
      lines: group.lines
        .filter((item) => item.status !== "unavailable")
        .map((line) => ({ offerId: line.offer_id, quantity: line.quantity })),
    });
    run(
      db,
      `INSERT INTO spend_ledger (id, bot_client_id, user_id, cart_id, order_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      newId("spd"),
      cart.bot_client_id,
      cart.user_id,
      cartId,
      orderId,
      group.total,
      nowIso(),
    );
    ids.push(orderId);
    emit(db, {
      type: "order.created",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId,
      resourceId: orderId,
      actorType: "system",
      data: { order_id: orderId, cart_id: cartId, seller_id: group.seller.id, total: money(group.total) },
    });
  }
  commitStock(db, cartId);
  run(db, `UPDATE approval_tokens SET consumed_at = ? WHERE cart_id = ? AND consumed_at IS NULL`, nowIso(), cartId);
  const summary = toBotCart(db, cartId);
  emit(db, {
    type: "cart.paid",
    userId: cart.user_id,
    botId: cart.bot_client_id,
    cartId,
    actorType: "system",
    data: { cart_id: cartId, version: summary.version, status: "paid", order_ids: ids, grand_total: money(view.grand) },
  });
  return summary;
}

function autoApprove(db: DatabaseSync, cartId: string, bot: BotRecord, approvalUrl: string) {
  const rule = one<{ id: string }>(db, `SELECT id FROM auto_rules WHERE bot_client_id = ? AND enabled = 1`, bot.id);
  transition(db, cartId, "approve", { decided_by: `auto_rule:${rule?.id ?? "unknown"}`, approval_method: "auto_rule", decided_at: nowIso() });
  const settled = mockSettle(db, cartId, chargesFor(db, cartId));
  if (!settled.ok) {
    transition(db, cartId, "payment_failed", { status_reason: "payment_failed" });
    emit(db, {
      type: "cart.payment_failed",
      userId: bot.user_id,
      botId: bot.id,
      cartId,
      data: { cart_id: cartId, code: settled.code },
    });
    return { ...toBotCart(db, cartId), approval_url: approvalUrl, expires_at: mustCart(db, cartId).lock_expires_at, auto_approved: false };
  }
  emit(db, { type: "cart.approved", userId: bot.user_id, botId: bot.id, cartId, actorType: "system", data: { cart_id: cartId, decided_by: `auto_rule:${rule?.id}` } });
  const paid = finalizePaid(db, cartId, "auto_rule", `auto_rule:${rule?.id ?? "unknown"}`);
  notify(db, bot.user_id, "inapp", `${paid.bot_name} bought this order`, "Auto-approve matched your rule. You can cancel until the seller accepts.");
  return { ...paid, approval_url: null, auto_approved: true, expires_at: null };
}

function storedPlacement(raw: string | null): ShopifyPlacement | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as { type?: unknown };
    return typeof parsed?.type === "string" && parsed.type ? { type: parsed.type } : null;
  } catch {
    return null;
  }
}

function handoffShopify(db: DatabaseSync, cart: CartRow): { status: number; body: unknown } {
  const lines = linesOf(db, cart.id);
  const continueUrls = lines.map((line) => {
    const placement = storedPlacement(line.placement_json);
    return {
      seller: line.seller_name,
      title: line.title,
      url: line.continue_url || `${config().publicBaseUrl}/shopify-handoff/stub?line=${encodeURIComponent(line.external_id || line.id)}`,
      stub: !line.continue_url,
      ...(placement ? { label: SPONSORED_LABEL, placement, disclosure: SPONSORED_DISCLOSURE } : {}),
    };
  });
  const sponsored = continueUrls.some((item) => "label" in item && item.label === SPONSORED_LABEL);
  run(db, `UPDATE carts SET status = 'handed_off', updated_at = ?, status_reason = 'shopify_continue_url' WHERE id = ?`, nowIso(), cart.id);
  const note = shopifyHandoffMessage();
  const body = {
    id: cart.id,
    status: "handed_off",
    lane: "shopify",
    checkout_mode: "merchant_handoff",
    in_bot_checkout: false,
    continue_urls: continueUrls,
    ...(sponsored ? { disclosure: SPONSORED_DISCLOSURE } : {}),
    message: note.message,
    ...(note.code ? { code: note.code } : {}),
    payment_status: "pending",
  };
  if (process.env.NODE_ENV !== "production") assertBotSafe(body);
  emit(db, {
    type: "cart.handed_off",
    userId: cart.user_id,
    botId: cart.bot_client_id,
    cartId: cart.id,
    actorType: "bot",
    data: { cart_id: cart.id, status: "handed_off", continue_urls: continueUrls.map((item) => item.url) },
  });
  return { status: 200, body };
}

export function getCartForBot(bot: BotRecord, cartId: string) {
  return transaction((db) => {
    sweepIn(db);
    const cart = mustCart(db, cartId);
    assertOwner(cart, bot);
    return toBotCart(db, cartId);
  });
}

export function cancelCart(input: { bot: BotRecord; cartId: string; reason?: string; idempotencyKey?: string }): IdemResult {
  return withIdempotency(input.bot.id, input.idempotencyKey, { cart_id: input.cartId, reason: input.reason ?? "user_changed_mind" }, (db) => {
    const cart = mustCart(db, input.cartId);
    assertOwner(cart, input.bot);
    transition(db, cart.id, "cancel", { status_reason: input.reason ?? "user_changed_mind" });
    releaseLocks(db, cart.id);
    run(db, `UPDATE shop_pay_requests SET status = 'cancelled', updated_at = ? WHERE cart_id = ? AND status != 'paid'`, nowIso(), cart.id);
    emit(db, {
      type: "cart.cancelled",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "bot",
      actorId: input.bot.id,
      data: { cart_id: cart.id, by: "bot", reason: input.reason ?? "user_changed_mind" },
    });
    return { status: 200, body: toBotCart(db, cart.id) };
  });
}

type TokenRow = {
  id: string;
  cart_id: string;
  cart_version: number;
  user_id: string;
  token_hash: string;
  expires_at: string;
  consumed_at: string | null;
  revoked_at: string | null;
  view_count: number;
  view_window_started_at: string | null;
  last_view_at: string | null;
  failed_auth: number;
};

function tokenRow(db: DatabaseSync, raw: string): TokenRow | undefined {
  return one<TokenRow>(db, `SELECT * FROM approval_tokens WHERE token_hash = ?`, sha256(raw));
}

export function loadApproval(rawToken: string, userId: string) {
  return transaction((db) => {
    sweepIn(db);
    const token = tokenRow(db, rawToken);
    if (!token) return { kind: "invalid" as const };
    const cart = mustCart(db, token.cart_id);
    if (token.user_id !== userId || cart.user_id !== userId) {
      emit(db, {
        type: "approval.foreign_view",
        userId: cart.user_id,
        botId: cart.bot_client_id,
        cartId: cart.id,
        actorType: "human",
        actorId: userId,
        data: { cart_id: cart.id },
      });
      notify(db, cart.user_id, "inapp", "Someone else opened an approval link", "A signed-in account that does not own this request tried to view it. No items were shown.");
      return { kind: "foreign" as const };
    }
    if (cart.status === "pending_shop_pay") {
      return { kind: "status" as const, cart: toHumanCart(db, cart.id), has_passkey: hasPasskey(userId, db) };
    }
    if (cart.status === "approved" && cart.lane !== "shop_pay" && config().paymentMode === "stripe" && !token.consumed_at) {
      return { kind: "card" as const, cart: toHumanCart(db, cart.id), publishable_key: config().stripePublishableKey };
    }
    if (cart.status === "expired" || (cart.status === "pending_approval" && token.expires_at < nowIso())) {
      return { kind: "expired" as const, expired_at: cart.lock_expires_at ?? token.expires_at, cart_id: cart.id };
    }
    if (token.revoked_at || (cart.status === "cancelled" && cart.status_reason === "security_hold")) {
      return { kind: "cancelled" as const, reason: cart.status_reason };
    }
    if (token.consumed_at || ["paid", "declined", "cancelled"].includes(cart.status)) {
      return { kind: "status" as const, cart: toHumanCart(db, cart.id), has_passkey: hasPasskey(userId, db) };
    }
    if (token.cart_version !== cart.version) return { kind: "stale" as const };
    const windowStart = token.view_window_started_at;
    const staleWindow = !windowStart || Date.parse(windowStart) < now().getTime() - 10 * 60_000;
    const recent = token.last_view_at && Date.parse(token.last_view_at) > now().getTime() - 1000;
    let views = token.view_count;
    if (!recent) {
      views = staleWindow ? 1 : token.view_count + 1;
      if (views > 10) return { kind: "rate_limited" as const };
      run(
        db,
        `UPDATE approval_tokens SET view_count = ?, view_window_started_at = ?, last_view_at = ? WHERE id = ?`,
        views,
        staleWindow ? nowIso() : windowStart,
        nowIso(),
        token.id,
      );
    }
    if (!cart.approval_viewed_at) {
      run(db, `UPDATE carts SET approval_viewed_at = ? WHERE id = ?`, nowIso(), cart.id);
      emit(db, { type: "cart.approval_viewed", userId: cart.user_id, botId: cart.bot_client_id, cartId: cart.id, actorType: "human", actorId: userId, data: { cart_id: cart.id } });
    }
    return { kind: "review" as const, cart: toHumanCart(db, cart.id), has_passkey: hasPasskey(userId, db), payment_mode: config().paymentMode };
  });
}

export function noteFailedApprovalLogin(nextPath: string | null) {
  if (!nextPath) return;
  const match = /\/a\/([^/?#]+)/.exec(nextPath);
  if (!match) return;
  transaction((db) => {
    const token = tokenRow(db, decodeURIComponent(match[1]));
    if (!token || token.consumed_at || token.revoked_at) return;
    const fails = token.failed_auth + 1;
    if (fails >= 5) {
      run(db, `UPDATE approval_tokens SET failed_auth = ?, revoked_at = ? WHERE id = ?`, fails, nowIso(), token.id);
      securityAlert("approval_security_hold", { cart_id: token.cart_id, failures: fails });
      const cart = mustCart(db, token.cart_id);
      if (cart.status === "pending_approval" || cart.status === "draft") {
        transition(db, cart.id, "cancel", { status_reason: "security_hold" });
        releaseLocks(db, cart.id);
      }
      return;
    }
    run(db, `UPDATE approval_tokens SET failed_auth = ? WHERE id = ?`, fails, token.id);
  });
}

/** Mercavine Store: re-check CJ stock/price, then compute tax, before any PaymentIntent exists. */
async function prepareFirstPartyFor(rawToken: string) {
  if (config().paymentMode !== "stripe") return;
  const token = tokenRow(getDb(), rawToken);
  if (!token) return;
  const { cartHasFirstParty, prepareCheckout } = await import("./cj-store");
  if (cartHasFirstParty(getDb(), token.cart_id)) await prepareCheckout(token.cart_id);
}

export async function approveCart(input: {
  rawToken: string;
  userId: string;
  method: "passkey" | "dev_step_up";
  assertionId?: string;
  acknowledgedChanges?: boolean;
  failSellerId?: string;
}) {
  assertEmailVerified(input.userId);
  await prepareFirstPartyFor(input.rawToken);
  const prepared = transaction((db) => {
    const token = tokenRow(db, input.rawToken);
    if (!token || token.revoked_at) throw new ApiError(409, "invalid_state", "This approval link is no longer valid.");
    if (token.user_id !== input.userId) throw new ApiError(403, "foreign_cart", "This request belongs to another account.");
    const cart = mustCart(db, token.cart_id);
    if (cart.status !== "pending_approval") throw new ApiError(409, "invalid_state", `This cart is ${cart.status}.`, { status: cart.status });
    if (token.expires_at < nowIso() || token.cart_version !== cart.version) {
      throw new ApiError(409, "invalid_state", "This approval link has expired or was replaced.");
    }
    if (input.method === "dev_step_up" && !config().allowDevStepUp) {
      throw new ApiError(403, "passkey_required", "Approve with a passkey.");
    }
    const view = quote(db, cart);
    if (view.lines.some((line) => line.status === "unavailable") && !input.acknowledgedChanges) {
      throw new ApiError(422, "changes_unacknowledged", "Confirm that you reviewed the unavailable lines.");
    }
    if (cart.lane === "shop_pay") {
      const active = linesOf(db, cart.id).filter((line) => line.status !== "unavailable");
      if (!active.length) throw new ApiError(422, "nothing_to_charge", "Nothing left to pay.");
      if (new Set(active.map((line) => line.seller_id)).size !== 1) {
        throw new ApiError(422, "too_many_sellers", "Shop Pay checkout is one merchant at a time.");
      }
      const checkoutUrl = active[0].continue_url ?? "";
      if (!checkoutUrl.startsWith("https://")) throw new ApiError(422, "bad_checkout_url", "Merchant checkout must be https.");
      transition(db, cart.id, "approve", {
        approval_method: input.method,
        decided_by: input.userId,
        decided_at: nowIso(),
      });
      emit(db, {
        type: "cart.approved",
        userId: cart.user_id,
        botId: cart.bot_client_id,
        cartId: cart.id,
        actorType: "human",
        actorId: input.userId,
        data: { cart_id: cart.id, method: input.method, lane: "shop_pay" },
      });
      return {
        kind: "shop_pay" as const,
        cartId: cart.id,
        userId: cart.user_id,
        botId: cart.bot_client_id,
        amount: view.grand,
        merchantName: active[0].seller_name,
        merchantUrl: merchantOrigin(checkoutUrl),
        checkoutUrl,
        summary: active.map((line) => line.title).join(", ").slice(0, 180),
      };
    }
    const charges = chargesFor(db, cart.id);
    if (!charges.length) throw new ApiError(422, "nothing_to_charge", "Nothing left to pay.");
    transition(db, cart.id, "approve", {
      approval_method: input.method,
      decided_by: input.userId,
      decided_at: nowIso(),
    });
    emit(db, {
      type: "cart.approved",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "human",
      actorId: input.userId,
      data: { cart_id: cart.id, method: input.method, assertion_id: input.assertionId ?? null },
    });
    return { kind: "stripe" as const, cartId: cart.id, botId: cart.bot_client_id, charges };
  });
  if (prepared.kind === "shop_pay") {
    try {
      await openShopPayRequest({
        id: newId("spr"),
        cartId: prepared.cartId,
        userId: prepared.userId,
        merchantName: prepared.merchantName,
        merchantUrl: prepared.merchantUrl,
        checkoutUrl: prepared.checkoutUrl,
        currency: "usd",
        amountCents: prepared.amount,
        summary: prepared.summary,
      });
    } catch (error) {
      transaction((db) => {
        const cart = mustCart(db, prepared.cartId);
        transition(db, prepared.cartId, "payment_failed", { status_reason: "payment_failed" });
        emit(db, {
          type: "cart.payment_failed",
          userId: cart.user_id,
          botId: cart.bot_client_id,
          cartId: cart.id,
          data: { cart_id: cart.id, code: error instanceof ApiError ? error.code : "shop_pay_failed" },
        });
      });
      throw error;
    }
    return transaction((db) => {
      transition(db, prepared.cartId, "shop_pay_wait", { status_reason: null });
      run(db, `UPDATE approval_tokens SET consumed_at = ? WHERE cart_id = ? AND consumed_at IS NULL`, nowIso(), prepared.cartId);
      return {
        paid: false as const,
        code: "shop_pay_approval" as const,
        shop_pay: shopPayPublic(readShopPay(prepared.cartId)),
        cart: toHumanCart(db, prepared.cartId),
      };
    });
  }
  if (config().paymentMode === "stripe") {
    let intents: PendingCardIntent[];
    try {
      intents = await createCardIntents(getDb(), prepared.cartId, prepared.botId, prepared.charges);
    } catch (error) {
      transaction((db) => {
        const cart = mustCart(db, prepared.cartId);
        transition(db, prepared.cartId, "payment_failed", { status_reason: "payment_failed" });
        emit(db, { type: "cart.payment_failed", userId: cart.user_id, botId: cart.bot_client_id, cartId: cart.id, data: { cart_id: cart.id, code: error instanceof ApiError ? error.code : "processing_error" } });
      });
      throw error;
    }
    return { paid: false as const, code: "card_required" as const, payment: cardPayload(intents), cart: toHumanCart(getDb(), prepared.cartId) };
  }
  const failSeller = config().paymentMode === "mock" ? input.failSellerId : undefined;
  const settled = await settleCharges(getDb(), prepared.cartId, prepared.botId, prepared.charges, failSeller);
  return transaction((db) => {
    if (!settled.ok) {
      const cart = mustCart(db, prepared.cartId);
      const remain = cart.lock_expires_at ? Date.parse(cart.lock_expires_at) - now().getTime() : 0;
      let expiry = cart.lock_expires_at;
      if (cart.lock_expires_at && !cart.lock_extended && remain < 10 * 60_000) {
        expiry = addMinutes(now(), 10);
        run(db, `UPDATE carts SET lock_extended = 1, lock_expires_at = ? WHERE id = ?`, expiry, cart.id);
        run(db, `UPDATE approval_tokens SET expires_at = ? WHERE cart_id = ? AND consumed_at IS NULL`, expiry, cart.id);
        run(db, `UPDATE inventory_reservations SET expires_at = ? WHERE cart_id = ? AND status = 'held'`, expiry, cart.id);
      }
      transition(db, prepared.cartId, "payment_failed", { status_reason: "payment_failed" });
      emit(db, {
        type: "cart.payment_failed",
        userId: cart.user_id,
        botId: cart.bot_client_id,
        cartId: cart.id,
        data: { cart_id: cart.id, code: settled.code },
      });
      return { paid: false as const, code: settled.code, cart: toHumanCart(db, prepared.cartId) };
    }
    const paid = finalizePaid(db, prepared.cartId, input.method, input.userId);
    return { paid: true as const, cart: toHumanCart(db, prepared.cartId), bot: paid };
  });
}

function cardPayload(intents: PendingCardIntent[]) {
  return {
    provider: "stripe",
    publishable_key: config().stripePublishableKey,
    intents: intents.map((i) => ({ seller_id: i.seller_id, seller_name: i.seller_name, stripe_account: i.stripe_account, amount_cents: i.amount_cents, client_secret: i.client_secret, status: i.status })),
  };
}

function approvedCardCart(db: DatabaseSync, rawToken: string, userId: string): CartRow {
  const token = tokenRow(db, rawToken);
  if (!token || token.revoked_at) throw new ApiError(409, "invalid_state", "This approval link is no longer valid.");
  if (token.user_id !== userId) throw new ApiError(403, "foreign_cart", "This request belongs to another account.");
  return mustCart(db, token.cart_id);
}

/** Card session for an approved cart: the Payment Element mounts these client secrets (one per seller). */
export async function cardSession(input: { rawToken: string; userId: string }) {
  const cart = transaction((db) => approvedCardCart(db, input.rawToken, input.userId));
  if (cart.status === "paid") return { paid: true as const, cart: toHumanCart(getDb(), cart.id) };
  if (cart.status !== "approved" || cart.lane === "shop_pay") throw new ApiError(409, "invalid_state", `This cart is ${cart.status}.`, { status: cart.status });
  const { cartHasFirstParty, prepareCheckout } = await import("./cj-store");
  if (cartHasFirstParty(getDb(), cart.id)) await prepareCheckout(cart.id);
  const intents = await createCardIntents(getDb(), cart.id, cart.bot_client_id, chargesFor(getDb(), cart.id));
  return { paid: false as const, code: "card_required", payment: cardPayload(intents) };
}

/** Called by the page after confirmPayment. Re-reads each intent from Stripe, so it works even before the webhook lands. */
export async function syncCardPayment(input: { rawToken: string; userId: string }) {
  const cart = transaction((db) => approvedCardCart(db, input.rawToken, input.userId));
  const db = getDb();
  if (cart.status === "approved") {
    const stripe = await stripeCardClient();
    const rows = many<{ provider_id: string; stripe_account_id: string }>(db, `SELECT provider_id, stripe_account_id FROM payment_attempts WHERE cart_id = ? AND status IN ('awaiting_payment','authorized','failed')`, cart.id);
    for (const row of rows) {
      const intent = await stripe.retrieveIntent(row.provider_id, { stripeAccount: row.stripe_account_id });
      applyIntentStatus(db, intent.id, intent.status, intent.last_payment_error?.code ?? null);
    }
    await settleCardCart(cart.id);
  }
  const fresh = mustCart(db, cart.id);
  return { paid: fresh.status === "paid", status: fresh.status, cart: toHumanCart(db, cart.id) };
}

/** Capture-and-finalize once every seller is authorized. Safe to call repeatedly (webhooks, page sync). */
export async function settleCardCart(cartId: string): Promise<boolean> {
  const db = getDb();
  const cart = one<CartRow>(db, `SELECT * FROM carts WHERE id = ?`, cartId);
  if (!cart) return false;
  if (cart.status === "paid") return true;
  if (cart.status !== "approved") return false;
  if (!(await captureIfReady(db, cartId))) return false;
  return transaction((tx) => {
    if (mustCart(tx, cartId).status !== "approved") return true;
    finalizePaid(tx, cartId, cart.approval_method ?? "card", cart.decided_by ?? cart.user_id);
    return true;
  });
}

/** Webhook: a card was declined. The Payment Element can retry the same intent; the bot is told. */
export function noteCardFailure(cartId: string, code: string) {
  transaction((db) => {
    const cart = one<CartRow>(db, `SELECT * FROM carts WHERE id = ?`, cartId);
    if (!cart) return;
    emit(db, { type: "cart.payment_failed", userId: cart.user_id, botId: cart.bot_client_id, cartId, data: { cart_id: cartId, code } });
  });
}

export function declineCart(input: { rawToken: string; userId: string; reason: string; note?: string; shareNote?: boolean }) {
  return transaction((db) => {
    const token = tokenRow(db, input.rawToken);
    if (!token || token.user_id !== input.userId) throw new ApiError(403, "foreign_cart", "This request belongs to another account.");
    const cart = mustCart(db, token.cart_id);
    transition(db, cart.id, "decline", {
      decline_reason: input.reason,
      decline_note: plainNote(input.note),
      share_decline_note: input.shareNote ? 1 : 0,
      decided_at: nowIso(),
      decided_by: input.userId,
      approval_method: "decline",
      status_reason: input.reason,
    });
    releaseLocks(db, cart.id);
    run(db, `UPDATE approval_tokens SET consumed_at = ? WHERE id = ?`, nowIso(), token.id);
    emit(db, {
      type: "cart.declined",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "human",
      actorId: input.userId,
      data: { cart_id: cart.id, reason_code: input.reason, ...(input.shareNote && input.note ? { note: plainNote(input.note) } : {}) },
    });
    notify(db, cart.user_id, "inapp", "You declined this cart", "Your bot was told.");
    return toHumanCart(db, cart.id);
  });
}

export function editPending(input: { rawToken: string; userId: string; lines: { line_id: string; quantity: number }[] }) {
  return transaction((db) => {
    const token = tokenRow(db, input.rawToken);
    if (!token || token.user_id !== input.userId || token.consumed_at || token.revoked_at) {
      throw new ApiError(409, "invalid_state", "This approval link is no longer valid.");
    }
    const cart = mustCart(db, token.cart_id);
    if (cart.status !== "pending_approval" || token.cart_version !== cart.version) {
      throw new ApiError(409, "invalid_state", "This approval link is no longer valid.");
    }
    const current = linesOf(db, cart.id);
    for (const edit of input.lines) {
      const line = current.find((item) => item.id === edit.line_id);
      if (!line) throw new ApiError(422, "unknown_line", "That line is not on this cart.");
      if (edit.quantity > line.quantity || edit.quantity < 0) {
        throw new ApiError(422, "bad_quantity", "You can only remove a line or lower its quantity.");
      }
      if (edit.quantity === 0) {
        run(db, `DELETE FROM cart_lines WHERE id = ?`, line.id);
        run(db, `UPDATE inventory_reservations SET status = 'released' WHERE line_id = ? AND status = 'held'`, line.id);
      } else if (edit.quantity < line.quantity) {
        run(db, `UPDATE cart_lines SET quantity = ? WHERE id = ?`, edit.quantity, line.id);
        run(db, `UPDATE inventory_reservations SET qty = ? WHERE line_id = ? AND status = 'held'`, edit.quantity, line.id);
      }
    }
    if (!linesOf(db, cart.id).some((line) => line.status !== "unavailable")) {
      throw new ApiError(422, "empty_cart", "Leave at least one item, or decline the cart.");
    }
    const version = cart.version + 1;
    run(db, `UPDATE carts SET version = ?, updated_at = ? WHERE id = ?`, version, nowIso(), cart.id);
    run(db, `UPDATE approval_tokens SET revoked_at = ? WHERE cart_id = ? AND consumed_at IS NULL`, nowIso(), cart.id);
    const secret = mintApprovalSecret();
    run(
      db,
      `INSERT INTO approval_tokens (
        id, cart_id, cart_version, user_id, token_hash, expires_at, consumed_at, revoked_at, view_count, view_window_started_at, last_view_at, failed_auth, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, 0, NULL, NULL, 0, ?)`,
      newId("atk"),
      cart.id,
      version,
      cart.user_id,
      secret.hash,
      cart.lock_expires_at,
      nowIso(),
    );
    return { approval_url: `${config().publicBaseUrl}/a/${secret.raw}`, token: secret.raw, cart: toHumanCart(db, cart.id) };
  });
}

export function changeApprovalAddress(rawToken: string, userId: string, addressId: string) {
  return transaction((db) => {
    const token = tokenRow(db, rawToken);
    if (!token || token.user_id !== userId || token.consumed_at || token.revoked_at) {
      throw new ApiError(409, "invalid_state", "This approval link is no longer valid.");
    }
    const cart = mustCart(db, token.cart_id);
    if (cart.status !== "pending_approval") throw new ApiError(409, "invalid_state", "The address can only change before you pay.");
    const address = addressFor(db, userId, addressId);
    run(db, `UPDATE carts SET shipping_address_id = ?, updated_at = ? WHERE id = ?`, address.id, nowIso(), cart.id);
    return toHumanCart(db, cart.id);
  });
}

export function askBotToRefresh(rawToken: string, userId: string) {
  return transaction((db) => {
    const token = tokenRow(db, rawToken);
    if (!token || token.user_id !== userId) throw new ApiError(403, "foreign_cart", "This request belongs to another account.");
    const cart = mustCart(db, token.cart_id);
    const bot = one<BotRecord & { scopes: string; allowed_categories: string }>(db, `SELECT * FROM bots WHERE id = ?`, cart.bot_client_id);
    if (!bot) throw new ApiError(404, "not_found", "Bot not found.");
    const cloned = cloneCart(db, { ...bot, scopes: JSON.parse(String(bot.scopes)), allowed_categories: JSON.parse(String(bot.allowed_categories)) } as BotRecord, cart.id);
    const body = cloned.body as { id: string };
    emit(db, {
      type: "cart.refresh_requested",
      userId,
      botId: cart.bot_client_id,
      cartId: cart.id,
      actorType: "human",
      actorId: userId,
      data: { cart_id: cart.id, cloned_cart_id: body.id },
    });
    return { cloned_cart_id: body.id };
  });
}

export function markLineUnavailable(cartId: string, lineId: string) {
  return transaction((db) => {
    run(db, `UPDATE cart_lines SET status = 'unavailable' WHERE id = ? AND cart_id = ?`, lineId, cartId);
    run(db, `UPDATE inventory_reservations SET status = 'released' WHERE line_id = ? AND status = 'held'`, lineId);
    const cart = mustCart(db, cartId);
    emit(db, { type: "cart.line_unavailable", userId: cart.user_id, botId: cart.bot_client_id, cartId, data: { cart_id: cartId, line_id: lineId } });
    return toBotCart(db, cartId);
  });
}

export async function finishShopPayForUser(cartId: string, userId: string) {
  const row = readShopPay(cartId);
  if (!row || row.user_id !== userId) throw new ApiError(404, "not_found", "No Shop Pay request for this cart.");
  if (row.status === "paid") {
    return transaction((db) => toHumanCart(db, cartId));
  }
  const claimed = await claimShopPay(row, userId);
  return transaction((db) => {
    const cart = mustCart(db, cartId);
    if (cart.user_id !== userId) throw new ApiError(403, "foreign_cart", "This request belongs to another account.");
    if (cart.status !== "pending_shop_pay") {
      throw new ApiError(409, "invalid_state", `This cart is ${cart.status}.`, { status: cart.status });
    }
    const fee = assertShopPayFee(row.amount_cents);
    transition(db, cartId, "shop_pay_paid", { status_reason: null, decided_at: nowIso(), decided_by: userId });
    const view = quote(db, mustCart(db, cartId));
    const ids: string[] = [];
    for (const group of view.groups) {
      if (group.total <= 0) continue;
      const orderId = newId("ord");
      const etaStart = addDays(now(), Math.min(...group.lines.map((line) => line.eta_min_days)));
      const etaEnd = addDays(now(), Math.max(...group.lines.map((line) => line.eta_max_days)));
      run(
        db,
        `INSERT INTO orders (
          id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents,
          tax_cents, total_cents, application_fee_cents, payment_status, stripe_payment_intent_id, stripe_account_id,
          tracking_carrier, tracking_number, ship_eta_start, ship_eta_end, created_at, updated_at, payment_provider
        ) VALUES (?, ?, ?, ?, ?, ?, 'created', 'usd', ?, ?, ?, ?, ?, 'paid', NULL, NULL, NULL, NULL, ?, ?, ?, ?, 'shop_pay')`,
        orderId,
        cartId,
        cart.user_id,
        cart.bot_client_id,
        group.seller.id,
        group.seller.name,
        group.subtotal,
        group.shipping,
        group.tax,
        group.total,
        fee,
        etaStart,
        etaEnd,
        nowIso(),
        nowIso(),
      );
      for (const line of group.lines.filter((item) => item.status !== "unavailable")) {
        run(
          db,
          `INSERT INTO order_lines (id, order_id, cart_line_id, title, variant_label, quantity, unit_price_cents) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          newId("ol"),
          orderId,
          line.id,
          line.title,
          line.variant_label,
          line.quantity,
          line.unit_price_cents,
        );
        run(db, `UPDATE cart_lines SET status = 'committed' WHERE id = ?`, line.id);
      }
      run(
        db,
        `INSERT INTO payment_attempts (id, cart_id, seller_id, stripe_account_id, amount_cents, fee_cents, currency, status, provider_id, failure_code, created_at)
         VALUES (?, ?, ?, '', ?, 0, 'usd', 'captured', ?, NULL, ?)`,
        newId("pay"),
        cartId,
        group.seller.id,
        group.total,
        claimed.orderRef,
        nowIso(),
      );
      run(
        db,
        `INSERT INTO spend_ledger (id, bot_client_id, user_id, cart_id, order_id, amount_cents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        newId("spd"),
        cart.bot_client_id,
        cart.user_id,
        cartId,
        orderId,
        group.total,
        nowIso(),
      );
      ids.push(orderId);
      emit(db, {
        type: "order.created",
        userId: cart.user_id,
        botId: cart.bot_client_id,
        cartId,
        resourceId: orderId,
        actorType: "system",
        data: { order_id: orderId, cart_id: cartId, seller_id: group.seller.id, total: money(group.total), payment_provider: "shop_pay", platform_fee_cents: 0 },
      });
    }
    markShopPayPaid(row.id);
    const summary = toBotCart(db, cartId);
    emit(db, {
      type: "cart.paid",
      userId: cart.user_id,
      botId: cart.bot_client_id,
      cartId,
      actorType: "system",
      data: { cart_id: cartId, version: summary.version, status: "paid", order_ids: ids, grand_total: money(view.grand), payment_provider: "shop_pay" },
    });
    if (process.env.NODE_ENV !== "production") assertBotSafe(summary);
    return toHumanCart(db, cartId);
  });
}

export function humanOrders(userId: string) {
  return many<{ id: string; seller_name: string; status: string; total_cents: number; payment_status: string; payment_provider: string; created_at: string }>(
    getDb(),
    `SELECT id, seller_name, status, total_cents, payment_status, payment_provider, created_at FROM orders WHERE user_id = ? ORDER BY created_at DESC`,
    userId,
  );
}

export function notificationsFor(userId: string) {
  return many<{ id: string; channel: string; title: string; body: string; created_at: string }>(
    getDb(),
    `SELECT id, channel, title, body, created_at FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 20`,
    userId,
  );
}

export function draftExpiryHours() {
  return addHours(now(), config().draftTtlHours);
}
