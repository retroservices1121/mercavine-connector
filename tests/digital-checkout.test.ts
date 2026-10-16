import { describe, expect, it } from "vitest";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, loadApproval, setApprovalBillingRegion, submitCart, updateCart, linesNeedAddress, type LineInput } from "../src/lib/cart";
import { approvalDisplay } from "../src/lib/approval-view";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { listOrders, markDigitalFulfilled } from "../src/lib/orders";
import { saveDigitalAsset } from "../src/lib/digital";
import { useTempDb } from "./db";

function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}
const key = (l: string) => `${l}-${Math.random().toString(36).slice(2, 10)}`;
type Body = {
  id: string;
  approval_url?: string;
  digital_only: boolean;
  requires_shipping_address: boolean;
  shipping_address: unknown;
  tax_region: { region: string | null; source: string };
  totals: { shipping: number; tax: number; subtotal: number };
  seller_groups: { shipping: number; lines: { fulfillment_type: string; shipping_est: { amount: number; label?: string } }[] }[];
};

function makeDigital(offerId = "ofr_tape") {
  getDb().prepare(`UPDATE offers SET fulfillment_type = 'digital', shipping_cents = 0, eta_min_days = 0, eta_max_days = 0 WHERE id = ?`).run(offerId);
  const offer = getDb().prepare(`SELECT product_id, seller_id FROM offers WHERE id = ?`).get(offerId) as { product_id: string; seller_id: string };
  saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "guide.pdf", bytes: new TextEncoder().encode("%PDF-1.4 test") });
}
function dropAddresses() {
  getDb().prepare(`DELETE FROM addresses WHERE user_id = 'usr_jp'`).run();
}
function create(lines: LineInput[], shippingAddressId?: string) {
  return createCart({ bot: bot(), lines, shippingAddressId, idempotencyKey: key("c") }).body as Body;
}

describe("digital checkout", () => {
  useTempDb();

  it("physical-only cart still requires an address", () => {
    dropAddresses();
    expect(() => create([{ offer_id: "ofr_brass_hinge", quantity: 1 }])).toThrowError(expect.objectContaining({ code: "address_required" }));
  });

  it("digital-only cart skips the address, ships free, and is marked digital", () => {
    makeDigital();
    dropAddresses();
    const cart = create([{ offer_id: "ofr_tape", quantity: 2 }]);
    expect(cart.shipping_address).toBeNull();
    expect(cart.digital_only).toBe(true);
    expect(cart.requires_shipping_address).toBe(false);
    expect(cart.totals.shipping).toBe(0);
    expect(cart.seller_groups[0].lines[0]).toMatchObject({ fulfillment_type: "digital", shipping_est: { amount: 0, label: "Instant" } });
    const row = getDb().prepare(`SELECT shipping_address_id FROM carts WHERE id = ?`).get(cart.id) as { shipping_address_id: string | null };
    expect(row.shipping_address_id).toBeNull();
  });

  it("forces shipping to 0 for digital lines even if the offer row has a shipping charge", () => {
    makeDigital();
    getDb().prepare(`UPDATE offers SET shipping_cents = 999 WHERE id = 'ofr_tape'`).run();
    const cart = create([{ offer_id: "ofr_tape", quantity: 1 }], "adr_home");
    expect(cart.totals.shipping).toBe(0);
  });

  it("mixed cart requires an address", () => {
    makeDigital();
    dropAddresses();
    expect(() => create([{ offer_id: "ofr_tape", quantity: 1 }, { offer_id: "ofr_brass_hinge", quantity: 1 }])).toThrowError(
      expect.objectContaining({ code: "address_required" }),
    );
  });

  it("adding a physical line to an address-less digital cart is rejected", () => {
    makeDigital();
    dropAddresses();
    const cart = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    expect(() =>
      updateCart({ bot: bot(), cartId: cart.id, lines: [{ offer_id: "ofr_tape", quantity: 1 }, { offer_id: "ofr_brass_hinge", quantity: 1 }], idempotencyKey: key("u") }),
    ).toThrowError(expect.objectContaining({ code: "address_required" }));
  });

  it("taxes a digital-only cart on the billing region, and blocks payment until one is set", async () => {
    makeDigital();
    dropAddresses();
    const cart = create([{ offer_id: "ofr_tape", quantity: 1 }]);
    expect(cart.tax_region.source).toBe("none");
    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("s") }).body as Body;
    const raw = submitted.approval_url!.split("/a/")[1];
    await expect(approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" })).rejects.toMatchObject({ code: "billing_region_required" });

    const updated = setApprovalBillingRegion(raw, "usr_jp", "wa") as unknown as Body;
    expect(updated.tax_region).toEqual({ region: "WA", source: "billing_region" });
    expect(updated.totals.tax).toBe(Math.round((updated.totals.subtotal * 1020) / 10_000));
    expect(() => setApprovalBillingRegion(raw, "usr_jp", "ZZ")).toThrowError(expect.objectContaining({ code: "invalid_region" }));

    const view = loadApproval(raw, "usr_jp");
    expect(view.kind).toBe("review");
    const paid = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
    expect(paid.paid).toBe(true);
    const [order] = listOrders(bot(), cart.id);
    expect(order).toMatchObject({ fulfillment_type: "digital", requires_tracking: false, ship_eta: null, tracking: null });
    expect(markDigitalFulfilled(order.id)).toMatchObject({ status: "fulfilled" });
  });

  it("uses the shipping address region over the billing region when an address exists", () => {
    makeDigital();
    getDb().prepare(`UPDATE users SET billing_region = 'WA' WHERE id = 'usr_jp'`).run();
    const cart = create([{ offer_id: "ofr_tape", quantity: 1 }], "adr_home");
    expect(cart.tax_region.source).toBe("shipping_address");
  });

  it("physical orders cannot use the no-tracking path", async () => {
    const cart = create([{ offer_id: "ofr_brass_hinge", quantity: 1 }], "adr_home");
    const submitted = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("s") }).body as Body;
    await approveCart({ rawToken: submitted.approval_url!.split("/a/")[1], userId: "usr_jp", method: "dev_step_up" });
    const [order] = listOrders(bot(), cart.id);
    expect(order.requires_tracking).toBe(true);
    expect(() => markDigitalFulfilled(order.id)).toThrowError(expect.objectContaining({ code: "tracking_required" }));
  });

  it("linesNeedAddress and approval display rules", () => {
    expect(linesNeedAddress([{ fulfillment_type: "digital" }])).toBe(false);
    expect(linesNeedAddress([{ fulfillment_type: "digital" }, { fulfillment_type: "physical" }])).toBe(true);
    expect(linesNeedAddress([{ fulfillment_type: "digital" }, { fulfillment_type: "physical", status: "unavailable" }])).toBe(false);
    expect(linesNeedAddress([{}])).toBe(true);
    expect(approvalDisplay({ digital_only: true, lane: "native", tax_region: { region: null, source: "none" } })).toEqual({
      showShipTo: false, showShipping: false, needsBillingRegion: true, showBillingRegion: true,
    });
    expect(approvalDisplay({ digital_only: false, lane: "native", tax_region: { region: "GA", source: "shipping_address" } })).toMatchObject({
      showShipTo: true, showShipping: true, needsBillingRegion: false,
    });
  });
});
