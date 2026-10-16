import type { DatabaseSync } from "node:sqlite";
import { SIGNING_NOTE } from "./amazon-mcf";
import type { BotRecord } from "./auth";
import { nowIso } from "./clock";
import { transaction } from "./db";
import { emit, notify } from "./events";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { withIdempotency, type IdemResult } from "./idempotency";
import { money } from "./money";
import { assertBotSafe } from "./redact";
import { many, one, run } from "./sql";

type OrderRow = {
  id: string;
  cart_id: string;
  user_id: string;
  bot_client_id: string;
  seller_id: string;
  seller_name: string;
  status: string;
  currency: string;
  subtotal_cents: number;
  shipping_cents: number;
  tax_cents: number;
  total_cents: number;
  payment_status: string;
  tracking_carrier: string | null;
  tracking_number: string | null;
  ship_eta_start: string | null;
  ship_eta_end: string | null;
  created_at: string;
  updated_at: string;
};

function present(db: DatabaseSync, order: OrderRow) {
  const lines = many<{ id: string; title: string; variant_label: string | null; quantity: number; unit_price_cents: number }>(
    db,
    `SELECT id, title, variant_label, quantity, unit_price_cents FROM order_lines WHERE order_id = ?`,
    order.id,
  );
  const mcf = one<{
    seller_fulfillment_order_id: string;
    status: string;
    shipping_speed: string;
    earliest_arrival: string | null;
    latest_arrival: string | null;
  }>(
    db,
    `SELECT seller_fulfillment_order_id, status, shipping_speed, earliest_arrival, latest_arrival FROM mcf_orders WHERE order_id = ?`,
    order.id,
  );
  const payload = {
    id: order.id,
    cart_id: order.cart_id,
    status: order.status,
    seller: { id: order.seller_id, name: order.seller_name },
    lines: lines.map((line) => ({
      line_id: line.id,
      title: line.title,
      variant: line.variant_label,
      quantity: line.quantity,
      unit_price: line.unit_price_cents,
    })),
    totals: {
      subtotal: order.subtotal_cents,
      shipping: order.shipping_cents,
      tax: order.tax_cents,
      grand_total: money(order.total_cents),
      currency: order.currency,
    },
    payment_status: order.payment_status,
    tracking: order.tracking_number ? { carrier: order.tracking_carrier, number: order.tracking_number } : null,
    ship_eta: order.ship_eta_start ? [order.ship_eta_start, order.ship_eta_end] : null,
    created_at: order.created_at,
    updated_at: order.updated_at,
    ...(mcf
      ? {
          fulfillment: {
            provider: "amazon_mcf" as const,
            status: mcf.status,
            seller_fulfillment_order_id: mcf.seller_fulfillment_order_id,
            shipping_speed: mcf.shipping_speed,
            delivery_promise:
              mcf.earliest_arrival && mcf.latest_arrival
                ? { earliest: mcf.earliest_arrival, latest: mcf.latest_arrival }
                : null,
            ...(mcf.status === "signing_unavailable" ? { note: SIGNING_NOTE } : {}),
          },
        }
      : {}),
  };
  const pay = one<{ payment_provider: string; application_fee_cents: number }>(
    db,
    `SELECT payment_provider, application_fee_cents FROM orders WHERE id = ?`,
    order.id,
  );
  const withPay =
    pay?.payment_provider === "shop_pay"
      ? { ...payload, payment_provider: "shop_pay" as const, platform_fee_cents: 0 }
      : payload;
  if (pay?.payment_provider === "shop_pay" && pay.application_fee_cents !== 0) {
    throw new ApiError(500, "fee_invariant", "Shop Pay orders cannot carry a platform fee.");
  }
  if (process.env.NODE_ENV !== "production") assertBotSafe(withPay);
  return withPay;
}

function own(db: DatabaseSync, bot: BotRecord, orderId: string): OrderRow {
  const order = one<OrderRow>(
    db,
    `SELECT id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_status, tracking_carrier, tracking_number, ship_eta_start, ship_eta_end, created_at, updated_at FROM orders WHERE id = ?`,
    orderId,
  );
  if (!order || order.user_id !== bot.user_id) throw new ApiError(404, "not_found", "Order not found.");
  return order;
}

export function listOrders(bot: BotRecord, cartId?: string) {
  return transaction((db) => {
    const rows = cartId
      ? many<OrderRow>(db, `SELECT id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_status, tracking_carrier, tracking_number, ship_eta_start, ship_eta_end, created_at, updated_at FROM orders WHERE user_id = ? AND cart_id = ? ORDER BY created_at`, bot.user_id, cartId)
      : many<OrderRow>(db, `SELECT id, cart_id, user_id, bot_client_id, seller_id, seller_name, status, currency, subtotal_cents, shipping_cents, tax_cents, total_cents, payment_status, tracking_carrier, tracking_number, ship_eta_start, ship_eta_end, created_at, updated_at FROM orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 50`, bot.user_id);
    return rows.map((row) => present(db, row));
  });
}

export function getOrder(bot: BotRecord, orderId: string) {
  return transaction((db) => present(db, own(db, bot, orderId)));
}

export function cancelOrder(input: { bot: BotRecord; orderId: string; reason?: string; idempotencyKey?: string }): IdemResult {
  return withIdempotency(input.bot.id, input.idempotencyKey, { order_id: input.orderId, reason: input.reason ?? "ordered_by_mistake" }, (db) => {
    const order = own(db, input.bot, input.orderId);
    if (order.status === "cancelled" || order.status === "refunded") {
      throw new ApiError(409, "invalid_state", "This order is already closed.", { status: order.status });
    }
    if (order.status === "created") {
      run(db, `UPDATE orders SET status = 'cancelled', payment_status = 'refunded', updated_at = ? WHERE id = ?`, nowIso(), order.id);
      run(db, `UPDATE payment_attempts SET status = 'refunded' WHERE cart_id = ? AND seller_id = ?`, order.cart_id, order.seller_id);
      emit(db, {
        type: "order.cancelled",
        userId: order.user_id,
        botId: order.bot_client_id,
        cartId: order.cart_id,
        resourceId: order.id,
        actorType: "bot",
        actorId: input.bot.id,
        data: { order_id: order.id, by: "bot", reason: input.reason ?? "ordered_by_mistake" },
      });
      emit(db, {
        type: "order.refunded",
        userId: order.user_id,
        botId: order.bot_client_id,
        cartId: order.cart_id,
        resourceId: order.id,
        data: { order_id: order.id, amount: money(order.total_cents) },
      });
      notify(db, order.user_id, "inapp", "Your bot cancelled an order", `${order.seller_name} was refunded to the original payment method.`);
    } else {
      run(db, `UPDATE orders SET status = 'cancel_requested', updated_at = ? WHERE id = ?`, nowIso(), order.id);
      notify(db, order.user_id, "inapp", "Cancellation requested", `${order.seller_name} has to accept or reject this cancellation.`);
    }
    return { status: 200, body: present(db, own(db, input.bot, order.id)) };
  });
}

export function requestReturn(input: {
  bot: BotRecord;
  orderId: string;
  lines: { line_id: string; quantity: number }[];
  reason: string;
  idempotencyKey?: string;
}): IdemResult {
  return withIdempotency(input.bot.id, input.idempotencyKey, { order_id: input.orderId, lines: input.lines, reason: input.reason }, (db) => {
    const order = own(db, input.bot, input.orderId);
    if (order.payment_status !== "paid" && order.payment_status !== "refunded") {
      throw new ApiError(409, "invalid_state", "Returns start after the order is paid.");
    }
    const id = newId("rtn");
    run(
      db,
      `INSERT INTO returns (id, order_id, user_id, status, reason, lines_json, created_at) VALUES (?, ?, ?, 'requested', ?, ?, ?)`,
      id,
      order.id,
      order.user_id,
      input.reason,
      JSON.stringify(input.lines),
      nowIso(),
    );
    emit(db, {
      type: "return.requested",
      userId: order.user_id,
      botId: order.bot_client_id,
      cartId: order.cart_id,
      resourceId: id,
      actorType: "bot",
      actorId: input.bot.id,
      data: { return_id: id, order_id: order.id, reason: input.reason },
    });
    notify(db, order.user_id, "inapp", "Your bot requested a return", `${order.seller_name} will refund the original payment method if the return is accepted. Refunds cannot be redirected.`);
    return { status: 201, body: { id, order_id: order.id, status: "requested", reason: input.reason, lines: input.lines } };
  });
}

export function markShipped(orderId: string, carrier: string, tracking: string) {
  return transaction((db) => {
    const order = one<OrderRow>(db, `SELECT * FROM orders WHERE id = ?`, orderId);
    if (!order) throw new ApiError(404, "not_found", "Order not found.");
    run(
      db,
      `UPDATE orders SET status = 'shipped', tracking_carrier = ?, tracking_number = ?, updated_at = ? WHERE id = ?`,
      carrier,
      tracking,
      nowIso(),
      orderId,
    );
    emit(db, {
      type: "order.shipped",
      userId: order.user_id,
      botId: order.bot_client_id,
      cartId: order.cart_id,
      resourceId: orderId,
      actorType: "system",
      data: { order_id: orderId, carrier, tracking },
    });
    return present(db, { ...order, status: "shipped", tracking_carrier: carrier, tracking_number: tracking });
  });
}
