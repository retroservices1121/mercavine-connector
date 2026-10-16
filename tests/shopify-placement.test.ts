import { describe, expect, it } from "vitest";
import { botByToken } from "../src/lib/auth";
import { createCart, submitCart } from "../src/lib/cart";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import {
  getShopifyProduct,
  normalizeShopifyProducts,
  searchShopify,
  SPONSORED_DISCLOSURE,
  SPONSORED_LABEL,
} from "../src/lib/shopify";
import { useTempDb } from "./db";

const promotedUrl =
  "https://runworld.example/products/trail-runner-pro?variant=45012&utm_source=shopify&utm_medium=catalog&shclid=clk_3b9f2a&shcgid=01arz3ndektsv4rrffq69g5fav";
const organicUrl =
  "https://peakgear.example/products/summit-trail-shoe?variant=91823&utm_source=shopify&utm_medium=catalog&shclid=clk_3b9f2a&shcgid=01arz3ndektsv4rrffq69g5fav";

const authorized = {
  products: [
    {
      id: "gid://shopify/Product/1",
      title: "Trail Runner Pro",
      variants: [
        {
          id: "gid://shopify/ProductVariant/45012",
          url: promotedUrl,
          price: { amount: 12000, currency: "usd" },
          seller: { id: "runworld", name: "Run World" },
          placement: { type: "affiliate", commission: { percentage: { value: 1.5 } } },
        },
      ],
    },
    {
      id: "gid://shopify/Product/2",
      title: "Summit Trail Shoe",
      variants: [{ id: "gid://shopify/ProductVariant/91823", url: organicUrl, seller: { id: "peak", name: "Peak Gear" } }],
    },
  ],
};

function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}

describe("Shopify promoted placements", () => {
  useTempDb();

  it("keeps attributed urls intact and labels only promoted variants", () => {
    const products = normalizeShopifyProducts(authorized);
    const promoted = products[0].offers[0];
    const organic = products[1].offers[0];
    expect(promoted.url).toBe(promotedUrl);
    expect(promoted.continue_url).toBe(promotedUrl);
    expect(promoted.url).toContain("shclid=clk_3b9f2a");
    expect(promoted.url).toContain("shcgid=01arz3ndektsv4rrffq69g5fav");
    expect(promoted.placement).toEqual({ type: "affiliate" });
    expect(promoted.placement).not.toHaveProperty("commission");
    expect(JSON.stringify(products)).not.toContain("1.5");
    expect(promoted.label).toBe(SPONSORED_LABEL);
    expect(promoted.disclosure).toBe(SPONSORED_DISCLOSURE);
    expect(products[0].disclosure).toBe(SPONSORED_DISCLOSURE);
    expect(organic.url).toBe(organicUrl);
    expect(organic.label).toBeUndefined();
    expect(organic.placement).toBeNull();
    expect(JSON.stringify(products)).toContain(promotedUrl);
    expect(JSON.stringify(products)).not.toContain(promotedUrl.replace(/&shclid=[^&]+/, ""));
  });

  it("sends catalog.catalog_id and returns organic results when Shopify says the caller is not authorized", async () => {
    process.env.SHOPIFY_CATALOG_ENABLED = "true";
    process.env.SHOPIFY_CATALOG_ID = "01arz3ndektsv4rrffq69g5fav";
    let sent = "";
    const unauthorized = {
      result: {
        structuredContent: {
          products: [
            {
              title: "Summit Trail Shoe",
              variants: [
                {
                  id: "gid://shopify/ProductVariant/91823",
                  url: "https://peakgear.example/products/summit-trail-shoe?variant=91823&utm_source=shopify&utm_medium=catalog",
                },
              ],
            },
          ],
          messages: [
            { type: "info", code: "unauthorized", content: "You aren't authorized for promoted placements. Returning organic variants." },
          ],
        },
      },
    };
    const found = await searchShopify({ q: "trail running shoes" }, async (_url, init) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify(unauthorized), { status: 200, headers: { "content-type": "application/json" } });
    });
    const catalog = JSON.parse(sent).params.arguments.catalog;
    expect(catalog.catalog_id).toBe("01arz3ndektsv4rrffq69g5fav");
    expect(found.status.status).toBe("ok");
    expect(found.status.promoted).toBe("organic_only");
    expect(found.status.placement_message).toMatch(/aren't authorized/);
    expect(found.products[0].offers[0].label).toBeUndefined();
    expect(found.products[0].offers[0].url).toBe(
      "https://peakgear.example/products/summit-trail-shoe?variant=91823&utm_source=shopify&utm_medium=catalog",
    );
  });

  it("omits catalog_id when SHOPIFY_CATALOG_ID is unset", async () => {
    process.env.SHOPIFY_CATALOG_ENABLED = "true";
    delete process.env.SHOPIFY_CATALOG_ID;
    let sent = "";
    await searchShopify({ q: "hinge" }, async (_url, init) => {
      sent = String(init?.body ?? "");
      return new Response(JSON.stringify({ products: [] }), { status: 200 });
    });
    expect(JSON.parse(sent).params.arguments.catalog.catalog_id).toBeUndefined();
  });

  it("passes the attributed url through get_product and the handoff link", async () => {
    process.env.SHOPIFY_CATALOG_ENABLED = "true";
    const product = await getShopifyProduct("gid://shopify/ProductVariant/45012", async () => {
      return new Response(
        JSON.stringify({ result: { structuredContent: { product: authorized.products[0] } } }),
        { status: 200 },
      );
    });
    expect(product?.offers[0].continue_url).toBe(promotedUrl);
    expect(product?.offers[0].label).toBe("Sponsored");

    const created = createCart({
      bot: bot(),
      shippingAddressId: "adr_home",
      idempotencyKey: `place-${Math.random().toString(36).slice(2, 10)}`,
      lines: [
        {
          provider: "shopify",
          external_id: product!.offers[0].offer_id,
          title: product!.title,
          seller_name: product!.offers[0].seller.name,
          seller_id: product!.offers[0].seller.id,
          unit_price: product!.offers[0].price.amount,
          quantity: 1,
          continue_url: product!.offers[0].continue_url!,
          placement: product!.offers[0].placement,
        },
      ],
    });
    const cart = created.body as { id: string };
    const handed = submitCart({
      bot: bot(),
      cartId: cart.id,
      idempotencyKey: `handoff-${Math.random().toString(36).slice(2, 10)}`,
    }).body as { continue_urls: { url: string; label?: string; disclosure?: string }[]; disclosure?: string };
    expect(handed.continue_urls[0].url).toBe(promotedUrl);
    expect(handed.continue_urls[0].url).toContain("shclid=clk_3b9f2a&shcgid=01arz3ndektsv4rrffq69g5fav");
    expect(handed.continue_urls[0].label).toBe("Sponsored");
    expect(handed.disclosure).toBe(SPONSORED_DISCLOSURE);
    expect(JSON.stringify(handed)).not.toContain("1.5");
    expect(JSON.stringify(handed)).not.toContain("percentage");
  });
});
