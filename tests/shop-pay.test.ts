import { describe, expect, it } from "vitest";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, finishShopPayForUser, loadApproval, submitCart } from "../src/lib/cart";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { getDb } from "../src/lib/db";
import { ApiError } from "../src/lib/errors";
import { applicationFee } from "../src/lib/money";
import { listOrders } from "../src/lib/orders";
import { assertBotSafe } from "../src/lib/redact";
import { pollShopLink, shopLinkPublic, startShopLink, verifyShopLines } from "../src/lib/shop-pay";
import { setShopFetchForTests } from "../src/lib/shop-mcp";
import { handleApi } from "../src/lib/api";
import { useTempDb } from "./db";

function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}

function key(label: string) {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

const shopLine = {
  provider: "shop" as const,
  quantity: 1,
  external_id: "shop:v1",
  title: "Solid brass hinge",
  seller_name: "Hinge Co",
  seller_id: "merchant.example",
  unit_price: 2400,
  continue_url: "https://merchant.example/checkout",
};

function enableMockShopPay() {
  process.env.SHOP_PAY_ENABLED = "true";
  process.env.SHOP_CATALOG_ENABLED = "false";
  delete process.env.SHOP_PAY_MODE;
  delete process.env.SHOP_ACCESS_TOKEN;
}

describe("Shop Pay", () => {
  useTempDb();

  it("refuses Shop lines while the flag is off", async () => {
    process.env.SHOP_PAY_ENABLED = "false";
    await expect(verifyShopLines([shopLine])).rejects.toMatchObject({ code: "shop_pay_disabled" });
  });

  it("links in mock mode without storing an access token", async () => {
    enableMockShopPay();
    const started = await startShopLink("usr_jp", "Mercavine");
    expect(started.user_code).toBe("MOCK");
    expect(started.verification_uri).toContain("/shop/link?code=MOCK");
    expect(started).not.toHaveProperty("access_token");
    expect(started).not.toHaveProperty("device_code");
    const linked = await pollShopLink("usr_jp");
    expect(linked.linked).toBe(true);
    expect(linked.email).toBe("shopper@shop.example");
    expect(JSON.stringify(shopLinkPublic("usr_jp"))).not.toMatch(/access_token|device_code/);
    const row = getDb().prepare(`SELECT access_token, device_code FROM shop_links WHERE user_id = ?`).get("usr_jp") as {
      access_token: string | null;
      device_code: string | null;
    };
    expect(row.access_token).toBeNull();
    expect(row.device_code).toBeNull();
  });

  it("rejects a Shop line the catalog says is unavailable", async () => {
    enableMockShopPay();
    process.env.SHOP_CATALOG_ENABLED = "true";
    setShopFetchForTests(async () =>
      new Response(
        JSON.stringify({
          result: {
            structuredContent: {
              products: [
                {
                  id: "v1",
                  title: "Solid brass hinge",
                  available: false,
                  price: 2400,
                  currency: "USD",
                  seller: { name: "Hinge Co" },
                  url: "https://merchant.example/p/hinge",
                },
              ],
            },
          },
        }),
        { status: 200 },
      ),
    );
    await expect(verifyShopLines([{ provider: "shop", quantity: 1, external_id: "shop:v1" }])).rejects.toMatchObject({ code: "unavailable" });
    setShopFetchForTests(null);
  });

  it("checks out through Shop Pay with a zero platform fee and no card material", async () => {
    enableMockShopPay();
    const lines = await verifyShopLines([shopLine]);
    expect(lines[0]?.verifiedByServer).toBe(true);
    const created = createCart({ bot: bot(), lines, shippingAddressId: "adr_home", idempotencyKey: key("shop-create") });
    const cart = created.body as { id: string; lane: string; platform_fee_applies: boolean; status: string };
    expect(cart.lane).toBe("shop_pay");
    expect(cart.platform_fee_applies).toBe(false);
    expect(cart.status).toBe("draft");

    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("shop-submit") });
    const pending = submitted.body as { status: string; approval_url: string; platform_fee_applies: boolean };
    expect(pending.status).toBe("pending_approval");
    expect(pending.platform_fee_applies).toBe(false);
    assertBotSafe(pending);
    const raw = pending.approval_url.split("/a/")[1];
    const review = loadApproval(raw, "usr_jp");
    expect(review.kind).toBe("review");
    if (review.kind !== "review") return;
    expect(review.cart.fee_bps).toBe(0);
    expect(review.cart.seller_fees[0].fee_cents).toBe(0);
    expect(review.cart.seller_fees[0].charge_cents).toBe(2400);

    const approved = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(approved.paid).toBe(false);
    if (approved.paid || approved.code !== "shop_pay_approval") {
      throw new Error(`expected Shop Pay approval, got ${approved.paid ? "paid" : approved.code}`);
    }
    expect(approved.shop_pay?.fee_cents).toBe(0);
    expect(approved.shop_pay?.continue_url).toContain("/shop-pay/mock/");
    expect(approved.shop_pay?.payment_provider).toBe("shop_pay");
    assertBotSafe(approved);

    const finished = await finishShopPayForUser(cart.id, "usr_jp");
    expect(finished.status).toBe("paid");
    expect(finished.fee_bps).toBe(0);
    expect(finished.platform_fee_applies).toBe(false);
    assertBotSafe(finished);
    const blob = JSON.stringify(finished);
    expect(blob.toLowerCase()).not.toContain("stripe");
    expect(blob).not.toMatch(/\bcvv\b|\bpan\b|credential/i);
    expect(blob).not.toMatch(/\b\d{13,19}\b/);

    const orders = listOrders(bot(), cart.id);
    expect(orders).toHaveLength(1);
    expect(orders[0]).toMatchObject({ payment_provider: "shop_pay", platform_fee_cents: 0, payment_status: "paid" });
    assertBotSafe(orders);
    expect(JSON.stringify(orders).toLowerCase()).not.toContain("stripe");

    const stored = getDb().prepare(`SELECT application_fee_cents, payment_provider, stripe_payment_intent_id FROM orders WHERE cart_id = ?`).all(cart.id) as {
      application_fee_cents: number;
      payment_provider: string;
      stripe_payment_intent_id: string | null;
    }[];
    expect(stored).toEqual([{ application_fee_cents: 0, payment_provider: "shop_pay", stripe_payment_intent_id: null }]);
    const request = getDb().prepare(`SELECT fee_cents, status, continue_url, checkout_url FROM shop_pay_requests WHERE cart_id = ?`).get(cart.id) as {
      fee_cents: number;
      status: string;
      continue_url: string;
      checkout_url: string;
    };
    expect(request.fee_cents).toBe(0);
    expect(request.status).toBe("paid");
    expect(JSON.stringify(request)).not.toMatch(/\b\d{13,19}\b/);
    const attempts = JSON.stringify(getDb().prepare(`SELECT provider_id, fee_cents FROM payment_attempts WHERE cart_id = ?`).all(cart.id));
    expect(attempts).not.toMatch(/\b\d{13,19}\b/);
    expect(attempts).toContain('"fee_cents":0');
  });

  it("keeps the 3% fee on a native cart in the same suite", () => {
    enableMockShopPay();
    const created = createCart({
      bot: bot(),
      lines: [{ offer_id: "ofr_brass_hinge", quantity: 1 }],
      shippingAddressId: "adr_home",
      idempotencyKey: key("native"),
    });
    const cart = created.body as { id: string; lane: string; platform_fee_applies: boolean };
    expect(cart.lane).toBe("native");
    expect(cart.platform_fee_applies).toBe(true);
    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("native-submit") });
    const pending = submitted.body as { approval_url: string };
    const raw = pending.approval_url.split("/a/")[1];
    const review = loadApproval(raw, "usr_jp");
    expect(review.kind).toBe("review");
    if (review.kind !== "review") return;
    expect(review.cart.fee_bps).toBe(300);
    expect(review.cart.seller_fees[0].fee_cents).toBe(applicationFee(review.cart.seller_fees[0].charge_cents, 300));
    expect(review.cart.seller_fees[0].fee_cents).toBeGreaterThan(0);
  });

  it("strips a client verified flag and still requires the https checkout URL", async () => {
    enableMockShopPay();
    const response = await handleApi(
      new Request("http://127.0.0.1:4317/api/v1/carts", {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEV_BOT_TOKEN}`,
          "content-type": "application/json",
          "idempotency-key": key("strip"),
        },
        body: JSON.stringify({
          lines: [{ ...shopLine, title: "", verifiedByServer: true, continue_url: "http://merchant.example/checkout" }],
          shipping_address_id: "adr_home",
        }),
      }),
    );
    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error.code).toBe("unavailable");
  });

  it("does not show a Shop Pay cart to another account", async () => {
    enableMockShopPay();
    const lines = await verifyShopLines([shopLine]);
    const created = createCart({ bot: bot(), lines, shippingAddressId: "adr_home", idempotencyKey: key("foreign") });
    const cart = created.body as { id: string };
    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("foreign-submit") });
    const raw = (submitted.body as { approval_url: string }).approval_url.split("/a/")[1];
    await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    const foreign = loadApproval(raw, "usr_sam");
    expect(foreign.kind).toBe("foreign");
    await expect(finishShopPayForUser(cart.id, "usr_sam")).rejects.toBeInstanceOf(ApiError);
  });
});
