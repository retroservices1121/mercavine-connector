import { describe, expect, it } from "vitest";
import { botByToken, login, revokeBot } from "../src/lib/auth";
import { approveCart, createCart, declineCart, loadApproval, submitCart, type LineInput } from "../src/lib/cart";
import { setNow } from "../src/lib/clock";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { ApiError } from "../src/lib/errors";
import { sha256 } from "../src/lib/ids";
import { applicationFee } from "../src/lib/money";
import { listOrders } from "../src/lib/orders";
import { assertBotSafe } from "../src/lib/redact";
import { clearMemoryWebhooks, memoryWebhooks, signWebhook, verifyWebhook, webhookKeys } from "../src/lib/webhooks";
import { useTempDb } from "./db";

function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}

function key(label: string) {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

type CartBody = {
  id: string;
  status: string;
  approval_url?: string;
  order_ids: string[];
  seller_groups: { seller: { id: string }; total: number }[];
};

function cartOf(result: { body: unknown }) {
  return result.body as CartBody;
}

function create(lines: LineInput[], idem = key("create")) {
  const result = createCart({
    bot: bot(),
    lines,
    shippingAddressId: "adr_home",
    idempotencyKey: idem,
  });
  return { result, cart: cartOf(result) };
}

describe("checkout", () => {
  useTempDb();

  it("searches, approves a two-seller cart, and records a 3% fee on each charge", async () => {
    const { cart } = create([
      { offer_id: "ofr_brass_hinge", quantity: 1 },
      { offer_id: "ofr_tape", quantity: 1 },
    ]);
    expect(cart.status).toBe("draft");
    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") });
    const pending = cartOf(submitted);
    expect(pending.status).toBe("pending_approval");
    expect(pending.approval_url).toMatch(/\/a\/osa_/);
    assertBotSafe(pending);

    const raw = pending.approval_url!.split("/a/")[1];
    const stored = getDb().prepare(`SELECT token_hash FROM approval_tokens WHERE cart_id = ?`).all(cart.id) as { token_hash: string }[];
    expect(stored).toEqual([{ token_hash: sha256(raw) }]);
    expect(JSON.stringify(stored)).not.toContain(raw);

    const view = loadApproval(raw, "usr_jp");
    expect(view.kind).toBe("review");
    if (view.kind !== "review") return;
    expect(view.cart.fee_bps).toBe(300);
    expect(view.cart.fee_label).toBe("3%");
    const bySeller = Object.fromEntries(view.cart.seller_fees.map((fee) => [fee.seller_id, fee]));
    expect(bySeller.sel_hinge).toMatchObject({ charge_cents: 2580, fee_cents: 77 });
    expect(bySeller.sel_bench).toMatchObject({ charge_cents: 2365, fee_cents: 71 });
    for (const fee of view.cart.seller_fees) {
      expect(fee.fee_cents).toBe(applicationFee(fee.charge_cents, 300));
    }
    expect(view.cart.totals.grand_total.amount).toBe(4945);

    const paid = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(paid.paid).toBe(true);
    const orders = listOrders(bot(), cart.id);
    expect(orders).toHaveLength(2);
    expect(orders.every((order) => order.payment_status === "paid")).toBe(true);
    for (const order of orders) assertBotSafe(order);
    expect(JSON.stringify(orders)).not.toMatch(/mock_pi_|acct_|stripe|last4|client_secret/);

    const fees = getDb().prepare(`SELECT seller_id, application_fee_cents, total_cents, payment_status FROM orders WHERE cart_id = ?`).all(cart.id) as {
      seller_id: string;
      application_fee_cents: number;
      total_cents: number;
      payment_status: string;
    }[];
    expect(fees.find((row) => row.seller_id === "sel_hinge")?.application_fee_cents).toBe(77);
    expect(fees.find((row) => row.seller_id === "sel_bench")?.application_fee_cents).toBe(71);

    const stock = getDb().prepare(`SELECT id, stock FROM offers WHERE id IN ('ofr_brass_hinge', 'ofr_tape')`).all() as { id: string; stock: number }[];
    expect(stock.find((row) => row.id === "ofr_brass_hinge")?.stock).toBe(39);
    expect(stock.find((row) => row.id === "ofr_tape")?.stock).toBe(49);
    const held = getDb().prepare(`SELECT COUNT(*) AS n FROM inventory_reservations WHERE cart_id = ? AND status = 'committed'`).get(cart.id) as { n: number };
    expect(held.n).toBe(2);

    const again = loadApproval(raw, "usr_jp");
    expect(again.kind).toBe("status");
    await expect(approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" })).rejects.toMatchObject({ code: "invalid_state" });
  });

  it("replays an identical idempotency key and rejects a reused key with a different body", () => {
    const idem = key("same");
    const first = create([{ offer_id: "ofr_brass_hinge", quantity: 1 }], idem);
    const second = create([{ offer_id: "ofr_brass_hinge", quantity: 1 }], idem);
    expect(second.result.replayed).toBe(true);
    expect(second.cart.id).toBe(first.cart.id);
    expect(() => create([{ offer_id: "ofr_tape", quantity: 1 }], idem)).toThrowError(
      expect.objectContaining({ status: 422, code: "idempotency_key_reuse" }),
    );
    void first;
  });

  it("releases stock when the shopper declines", () => {
    const { cart } = create([{ offer_id: "ofr_brass_hinge", quantity: 2 }]);
    const pending = cartOf(submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") }));
    const raw = pending.approval_url!.split("/a/")[1];
    const declined = declineCart({ rawToken: raw, userId: "usr_jp", reason: "not_now" });
    expect(declined.status).toBe("declined");
    const released = getDb().prepare(`SELECT COUNT(*) AS n FROM inventory_reservations WHERE cart_id = ? AND status = 'released'`).get(cart.id) as { n: number };
    expect(released.n).toBe(1);
    const stock = getDb().prepare(`SELECT stock FROM offers WHERE id = 'ofr_brass_hinge'`).get() as { stock: number };
    expect(stock.stock).toBe(40);
  });

  it("voids the other seller when one direct charge fails", async () => {
    const { cart } = create([
      { offer_id: "ofr_brass_hinge", quantity: 1 },
      { offer_id: "ofr_tape", quantity: 1 },
    ]);
    const pending = cartOf(submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") }));
    const raw = pending.approval_url!.split("/a/")[1];
    const failed = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up", failSellerId: "sel_bench" });
    expect(failed.paid).toBe(false);
    if (failed.paid) return;
    expect(failed.code).toBe("card_declined");
    expect(failed.cart.status).toBe("pending_approval");
    const orders = getDb().prepare(`SELECT COUNT(*) AS n FROM orders WHERE cart_id = ?`).get(cart.id) as { n: number };
    expect(orders.n).toBe(0);
    const attempts = getDb().prepare(`SELECT seller_id, status FROM payment_attempts WHERE cart_id = ? ORDER BY seller_id`).all(cart.id) as { seller_id: string; status: string }[];
    expect(attempts).toEqual([
      { seller_id: "sel_bench", status: "failed" },
      { seller_id: "sel_hinge", status: "voided" },
    ]);
    const log = getDb().prepare(`SELECT seller_id, action FROM payment_log WHERE cart_id = ? ORDER BY rowid`).all(cart.id) as { seller_id: string; action: string }[];
    expect(log.map((row) => row.action)).toEqual(["authorize", "fail", "void"]);
  });

  it("rejects a price change, thin stock, a duplicate pending cart, and a foreign viewer", () => {
    const priced = create([{ offer_id: "ofr_brass_hinge", quantity: 1 }]);
    getDb().prepare(`UPDATE offers SET price_cents = price_cents + 100 WHERE id = 'ofr_brass_hinge'`).run();
    expect(() => submitCart({ bot: bot(), cartId: priced.cart.id, idempotencyKey: key("submit") })).toThrowError(expect.objectContaining({ code: "price_changed", status: 409 }));

    const thin = create([{ offer_id: "ofr_wrench_set", quantity: 2 }]);
    expect(() => submitCart({ bot: bot(), cartId: thin.cart.id, idempotencyKey: key("submit") })).toThrowError(expect.objectContaining({ code: "insufficient_stock", status: 409 }));

    const first = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    const second = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    submitCart({ bot: bot(), cartId: first.cart.id, idempotencyKey: key("submit") });
    expect(() => submitCart({ bot: bot(), cartId: second.cart.id, idempotencyKey: key("submit") })).toThrowError(expect.objectContaining({ code: "duplicate_pending_cart", status: 409 }));

    const pending = cartOf(submitCart({ bot: bot(), cartId: create([{ offer_id: "ofr_wood_stain", quantity: 1 }]).cart.id, idempotencyKey: key("submit") }));
    const raw = pending.approval_url!.split("/a/")[1];
    const foreign = loadApproval(raw, "usr_sam");
    expect(foreign).toEqual({ kind: "foreign" });

    setNow(new Date(Date.now() + 31 * 60_000));
    const expired = loadApproval(raw, "usr_jp");
    expect(expired.kind).toBe("expired");
  });

  it("cancels open carts when the bot is revoked", () => {
    const { cart } = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") });
    const session = login("jp@mercavine.test", "shelf-demo-2026");
    expect(session.user.id).toBe("usr_jp");
    revokeBot("bot_grok_jp", "usr_jp");
    const row = getDb().prepare(`SELECT status, status_reason FROM carts WHERE id = ?`).get(cart.id) as { status: string; status_reason: string };
    expect(row).toEqual({ status: "cancelled", status_reason: "bot_revoked" });
  });

  it("hands Shopify lines off without creating a charge", () => {
    const { cart } = create([
      {
        provider: "shopify",
        external_id: "gid://shopify/Product/1",
        title: "Shop lamp",
        seller_name: "Example Shop",
        seller_id: "shop_example",
        unit_price: 2500,
        quantity: 1,
        continue_url: "https://example-shop.example/checkout",
      },
    ]);
    const handed = cartOf(submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") }));
    expect(handed.status).toBe("handed_off");
    expect(JSON.stringify(handed)).toContain("https://example-shop.example/checkout");
    const attempts = getDb().prepare(`SELECT COUNT(*) AS n FROM payment_attempts WHERE cart_id = ?`).get(cart.id) as { n: number };
    expect(attempts.n).toBe(0);
    expect(() =>
      create([
        { offer_id: "ofr_tape", quantity: 1 },
        { provider: "shopify", external_id: "gid://shopify/Product/2", title: "Other", seller_name: "Shop", unit_price: 100, quantity: 1 },
      ]),
    ).toThrowError(expect.objectContaining({ code: "mixed_checkout_lanes" }));
  });

  it("signs webhook deliveries and delivers memory endpoints", async () => {
    const body = JSON.stringify({ hello: "mercavine" });
    const id = "whd_roundtrip";
    const timestamp = Math.floor(Date.now() / 1000).toString();
    webhookKeys();
    const signature = signWebhook(id, timestamp, body);
    expect(verifyWebhook(id, timestamp, body, `v1,${signature}`)).toBe(true);
    expect(verifyWebhook(id, timestamp, `${body}x`, `v1,${signature}`)).toBe(false);

    clearMemoryWebhooks();
    getDb()
      .prepare(`INSERT INTO webhook_endpoints (id, bot_client_id, url, events, disabled_at, failure_since, created_at) VALUES (?, ?, ?, ?, NULL, NULL, ?)`)
      .run("whe_mem", "bot_grok_jp", "memory:tests", "cart.*", new Date().toISOString());
    const { cart } = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(memoryWebhooks().some((item) => item.url === "memory:tests" && item.body.includes("cart.created"))).toBe(true);
    expect(memoryWebhooks()[0]?.headers["webhook-signature"]).toMatch(/^v1,/);
    void cart;
  });
});
