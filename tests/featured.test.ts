import { describe, expect, it } from "vitest";
import type { ProductView } from "@/lib/catalog";
import { curatedFeatured, featuredItems } from "@/lib/featured";

const launch = ["home-improvement", "tools", "electronics-accessories"];

describe("homepage featured products", () => {
  it("falls back to curated real products when no listings are in stock", () => {
    const items = featuredItems(() => []);
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.kind === "curated")).toBe(true);
  });
  it("curated entries are launch-category, sourced, and carry no seller/rating/stock", () => {
    for (const p of curatedFeatured) {
      expect(launch).toContain(p.category);
      expect(p.sourceUrl).toMatch(/^https:\/\//);
      expect(p.listPriceCents).toBeGreaterThan(0);
      expect(p).not.toHaveProperty("seller");
      expect(p).not.toHaveProperty("rating");
      expect(p).not.toHaveProperty("stock");
    }
  });
  it("prefers real in-stock listings over curated entries", () => {
    const listing = { category: "tools", title: "Drill", offers: [{ offer_id: "o1" }] } as unknown as ProductView;
    const noOffer = { category: "tools", title: "X", offers: [] } as unknown as ProductView;
    const items = featuredItems(() => [listing, noOffer]);
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("listing");
  });
  it("is empty (section hidden) when there is nothing to show", () => {
    expect(featuredItems(() => [], [])).toEqual([]);
  });
});
