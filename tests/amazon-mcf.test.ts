import { describe, expect, it, vi } from "vitest";
import { amazonRefreshToken, completeAmazonOAuth, connectAmazonSeller, setPrimeEnrolled } from "../src/lib/amazon-mcf";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, submitCart, type LineInput } from "../src/lib/cart";
import { getNativeProduct } from "../src/lib/catalog";
import { addDays, now, setNow } from "../src/lib/clock";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { getOrder, listOrders } from "../src/lib/orders";
import { assertBotSafe } from "../src/lib/redact";
import { useTempDb } from "./db";

function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}

function key(label: string) {
  return `${label}-${Math.random().toString(36).slice(2, 10)}`;
}

function enableMock() {
  process.env.AMAZON_MCF_ENABLED = "true";
  process.env.AMAZON_MCF_MODE = "mock";
}

function enableLive() {
  process.env.AMAZON_MCF_ENABLED = "true";
  process.env.AMAZON_MCF_MODE = "live";
  process.env.AMAZON_LWA_CLIENT_ID = "amzn1.application-oa2-client.example";
  process.env.AMAZON_LWA_CLIENT_SECRET = "example-secret";
  process.env.AMAZON_SP_APP_ID = "amzn1.sp.solution.example";
}

async function pay(lines: LineInput[]) {
  const created = createCart({
    bot: bot(),
    lines,
    shippingAddressId: "adr_home",
    idempotencyKey: key("create"),
  });
  const cart = created.body as { id: string };
  const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("submit") });
  const pending = submitted.body as { approval_url: string; id: string };
  const raw = pending.approval_url.split("/a/")[1];
  await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
  return pending.id;
}

describe("amazon mcf", () => {
  useTempDb();

  it("stays off until the flag is set", () => {
    expect(() => connectAmazonSeller("sel_hinge")).toThrowError(
      expect.objectContaining({ status: 403, code: "amazon_mcf_disabled" }),
    );
    getDb().prepare(`UPDATE sellers SET prime_enrolled = 1 WHERE id = 'sel_hinge'`).run();
    const product = getNativeProduct("prd_brass_hinge");
    expect(product?.offers[0]).toMatchObject({ fulfillment: "fba", prime_delivery: false });
    const tape = getNativeProduct("prd_tape");
    expect(tape?.offers[0].fulfillment).toBe("merchant");
    expect(tape?.offers[0].prime_delivery).toBe(false);
  });

  it("stores a mock refresh token and keeps it out of the public payload", () => {
    enableMock();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const status = connectAmazonSeller("sel_hinge");
      expect(status).toMatchObject({
        seller_id: "sel_hinge",
        connected: true,
        mode: "mock",
        prime_enrolled: false,
        marketplace_id: "ATVPDKIKX0DER",
      });
      expect(status.selling_partner_id).toMatch(/^A1MOCK/);
      expect(status.authorize_url).toBeUndefined();
      const json = JSON.stringify(status);
      expect(json).not.toContain("refresh_token");
      expect(json).not.toContain("Atzr");
      assertBotSafe(status);
      const stored = getDb().prepare(`SELECT refresh_token FROM amazon_seller_links WHERE seller_id = ?`).get("sel_hinge") as {
        refresh_token: string;
      };
      expect(stored.refresh_token.startsWith("enc:v1:")).toBe(true);
      expect(stored.refresh_token).not.toContain("Atzr");
      expect(amazonRefreshToken("sel_hinge")?.startsWith("Atzr|mock|")).toBe(true);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("fulfills the FBA hinge after payment and leaves the 3% fee in place", async () => {
    setNow(new Date("2026-06-01T15:00:00.000Z"));
    enableMock();
    connectAmazonSeller("sel_hinge");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const cartId = await pay([
        { offer_id: "ofr_brass_hinge", quantity: 1 },
        { offer_id: "ofr_tape", quantity: 1 },
      ]);
      const orders = listOrders(bot(), cartId);
      expect(orders).toHaveLength(2);
      const hinge = orders.find((order) => order.seller.id === "sel_hinge");
      const tape = orders.find((order) => order.seller.id === "sel_bench");
      expect(hinge?.payment_status).toBe("paid");
      expect(hinge?.tracking).toEqual({
        carrier: "Amazon Logistics",
        number: expect.stringMatching(/^TBA\d{12}$/),
      });
      expect(hinge?.fulfillment).toMatchObject({
        provider: "amazon_mcf",
        status: "received",
        shipping_speed: "Standard",
        delivery_promise: { earliest: addDays(now(), 2), latest: addDays(now(), 5) },
      });
      expect(hinge?.fulfillment?.seller_fulfillment_order_id).toMatch(/^MCF[0-9a-f]{20}$/);
      expect(tape?.tracking).toBeNull();
      expect(tape).not.toHaveProperty("fulfillment");
      for (const order of orders) assertBotSafe(order);
      const dumped = JSON.stringify(orders);
      expect(dumped).not.toContain("refresh_token");
      expect(dumped).not.toContain("Atzr");
      expect(dumped).not.toContain("amazon.com");
      expect(getOrder(bot(), hinge!.id).tracking).toEqual(hinge?.tracking);

      const fees = getDb().prepare(`SELECT seller_id, application_fee_cents, payment_status FROM orders WHERE cart_id = ?`).all(cartId) as {
        seller_id: string;
        application_fee_cents: number;
        payment_status: string;
      }[];
      expect(fees.find((row) => row.seller_id === "sel_hinge")).toMatchObject({ application_fee_cents: 77, payment_status: "paid" });
      expect(fees.find((row) => row.seller_id === "sel_bench")).toMatchObject({ application_fee_cents: 71, payment_status: "paid" });
      const mcf = getDb().prepare(`SELECT COUNT(*) AS n FROM mcf_orders`).get() as { n: number };
      expect(mcf.n).toBe(1);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("shows Prime delivery only when the seller is enrolled and the flag is on", () => {
    enableMock();
    expect(getNativeProduct("prd_brass_hinge")?.offers[0].prime_delivery).toBe(false);
    const enrolled = setPrimeEnrolled("sel_hinge", true);
    expect(enrolled.prime_enrolled).toBe(true);
    expect(JSON.stringify(enrolled)).not.toContain("refresh_token");
    expect(getNativeProduct("prd_brass_hinge")?.offers[0].prime_delivery).toBe(true);
    process.env.AMAZON_MCF_ENABLED = "false";
    expect(getNativeProduct("prd_brass_hinge")?.offers[0].prime_delivery).toBe(false);
  });

  it("does not fulfill when the seller has not connected", async () => {
    enableMock();
    const cartId = await pay([{ offer_id: "ofr_brass_hinge", quantity: 1 }]);
    const orders = listOrders(bot(), cartId);
    expect(orders[0].tracking).toBeNull();
    expect(orders[0]).not.toHaveProperty("fulfillment");
    const fees = getDb().prepare(`SELECT application_fee_cents FROM orders WHERE cart_id = ?`).get(cartId) as { application_fee_cents: number };
    expect(fees.application_fee_cents).toBe(77);
  });

  it("builds a Seller Central consent URL and does not call Amazon", () => {
    enableLive();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const status = connectAmazonSeller("sel_hinge");
      expect(status.connected).toBe(false);
      expect(status.authorize_url).toContain("https://sellercentral.amazon.com/apps/authorize/consent");
      expect(status.authorize_url).toContain("application_id=amzn1.sp.solution.example");
      expect(status.authorize_url).toContain("version=beta");
      expect(status.authorize_url).not.toContain("example-secret");
      const state = new URL(status.authorize_url!).searchParams.get("state");
      const row = getDb().prepare(`SELECT oauth_state, refresh_token FROM amazon_seller_links WHERE seller_id = ?`).get("sel_hinge") as {
        oauth_state: string;
        refresh_token: string | null;
      };
      expect(row.oauth_state).toBe(state);
      expect(row.refresh_token).toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("exchanges an authorization code and still hides the refresh token", async () => {
    enableLive();
    const started = connectAmazonSeller("sel_hinge");
    const state = new URL(started.authorize_url!).searchParams.get("state") ?? "";
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ refresh_token: "Atzr|live-example", access_token: "Atza|access" }), { status: 200 }),
    );
    try {
      await expect(completeAmazonOAuth({ code: "spl_code", state: "nope", sellingPartnerId: "A1SELLER" })).rejects.toMatchObject({
        code: "invalid_state",
      });
      expect(fetchSpy).not.toHaveBeenCalled();
      const done = await completeAmazonOAuth({ code: "spl_code", state, sellingPartnerId: "A1SELLER" });
      expect(done).toMatchObject({ connected: true, selling_partner_id: "A1SELLER", mode: "live" });
      expect(JSON.stringify(done)).not.toContain("Atzr");
      expect(JSON.stringify(done)).not.toContain("refresh_token");
      const stored = getDb().prepare(`SELECT refresh_token, oauth_state FROM amazon_seller_links WHERE seller_id = ?`).get("sel_hinge") as {
        refresh_token: string;
        oauth_state: string | null;
      };
      expect(stored.refresh_token.startsWith("enc:v1:")).toBe(true);
      expect(amazonRefreshToken("sel_hinge")).toBe("Atzr|live-example");
      expect(stored.oauth_state).toBeNull();
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [url, init] = fetchSpy.mock.calls[0];
      expect(url).toBe("https://api.amazon.com/auth/o2/token");
      expect(String(init?.body)).toContain("grant_type=authorization_code");
      expect(String(init?.body)).toContain("code=spl_code");
      expect(String(init?.body)).not.toContain("Atzr");
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("leaves a paid order unsigned when live SigV4 is unavailable", async () => {
    enableMock();
    connectAmazonSeller("sel_hinge");
    enableLive();
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      const cartId = await pay([{ offer_id: "ofr_brass_hinge", quantity: 1 }]);
      const order = listOrders(bot(), cartId)[0];
      expect(order.payment_status).toBe("paid");
      expect(order.tracking).toBeNull();
      expect(order.fulfillment).toMatchObject({
        provider: "amazon_mcf",
        status: "signing_unavailable",
        note: "Fulfillment was not sent to Amazon. The Mercavine payment is unchanged.",
      });
      assertBotSafe(order);
      const row = getDb().prepare(`SELECT detail, application_fee_cents FROM mcf_orders m JOIN orders o ON o.id = m.order_id WHERE o.cart_id = ?`).get(cartId) as {
        detail: string;
        application_fee_cents: number;
      };
      expect(row.application_fee_cents).toBe(77);
      expect(row.detail).toContain("/fba/outbound/2020-07-01/fulfillmentOrders");
      expect(row.detail).toContain("SigV4");
      expect(row.detail).not.toContain("Atzr");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});
