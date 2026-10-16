import { afterEach, describe, expect, it } from "vitest";
import { availabilityOf, minorUnits, normalizeShopProducts, searchShopCatalog, setShopFetchForTests, shopFetchCount, shopFetchedUrls } from "../src/lib/shop-mcp";
import { useTempDb } from "./db";

const image = "https://cdn.merchant.example/hinge.jpg";

function productPayload(product: Record<string, unknown>) {
  return {
    result: {
      structuredContent: {
        products: [product],
      },
    },
  };
}

describe("Shop catalog", () => {
  useTempDb();
  afterEach(() => setShopFetchForTests(null));

  it("treats integers as minor units and decimals as major units", () => {
    expect(minorUnits(2400)).toBe(2400);
    expect(minorUnits(24.5)).toBe(2450);
    expect(minorUnits("24.00")).toBe(2400);
    expect(minorUnits("nope")).toBeNull();
    expect(availabilityOf("yes")).toBeNull();
  });

  it("marks missing or unavailable inferred fields as not linkable and keeps image URLs", () => {
    const [ready] = normalizeShopProducts(
      productPayload({
        id: "v1",
        title: "Solid brass hinge",
        url: "https://merchant.example/p/hinge",
        image,
        seller: { id: "m1", name: "Hinge Co", domain: "merchant.example" },
        currency: "USD",
        variants: [{ id: "v1", price: 2400, available: true, checkout_url: "https://merchant.example/checkout" }],
      }),
    );
    expect(ready.source).toBe("shop");
    expect(ready.offers[0].linkable).toBe(true);
    expect(ready.offers[0].price?.amount).toBe(2400);
    expect(ready.image_urls).toEqual([image]);

    const [broken] = normalizeShopProducts(productPayload({ id: "v2", price: { note: "inferred" }, available: "yes" }));
    expect(broken.title).toBe("Untitled product");
    expect(broken.missing).toContain("title");
    expect(broken.offers[0].linkable).toBe(false);
    expect(broken.offers[0].missing).toEqual(expect.arrayContaining(["price", "seller", "currency", "availability"]));

    const [gone] = normalizeShopProducts(
      productPayload({
        id: "v3",
        title: "Tape",
        seller: { name: "Bench" },
        currency: "USD",
        price: 2200,
        available: false,
        url: "https://merchant.example/p/tape",
      }),
    );
    expect(gone.offers[0].available).toBe(false);
    expect(gone.offers[0].linkable).toBe(false);
  });

  it("fetches Shop MCP on every search and does not fetch merchant images", async () => {
    process.env.SHOP_CATALOG_ENABLED = "true";
    const body = JSON.stringify(
      productPayload({
        id: "v1",
        title: "Solid brass hinge",
        image,
        seller: { name: "Hinge Co" },
        currency: "USD",
        price: 2400,
        available: true,
        url: "https://merchant.example/p/hinge",
      }),
    );
    setShopFetchForTests(async () => new Response(body, { status: 200, headers: { "content-type": "application/json" } }));
    const first = await searchShopCatalog({ q: "hinge" });
    const second = await searchShopCatalog({ q: "hinge" });
    expect(first.status).toMatchObject({ source: "shop", status: "ok", cached: false });
    expect(second.products[0].source).toBe("shop");
    expect(shopFetchCount()).toBe(2);
    expect(shopFetchedUrls()).toEqual(["https://mcp.shop.com/", "https://mcp.shop.com/"]);
    expect(shopFetchedUrls().join(" ")).not.toContain("cdn.merchant.example");
  });
});
