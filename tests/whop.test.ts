/* eslint-disable @typescript-eslint/no-explicit-any -- untyped Whop API JSON */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { affiliateUrl, getWhopProduct, searchWhopProducts, setWhopFetchForTests, WHOP_DISCLOSURE } from "../src/lib/whop";

const listItem = {
  id: "prod_abc123",
  title: "Options Course",
  headline: "Learn options",
  description: "A course.",
  route: "options-course",
  account: { id: "biz_1", title: "Acme Trading" },
  gallery_images: [{ url: "https://assets-2-prod.whop.com/x.png" }],
  default_plan: { id: "plan_1", plan_type: "one_time", initial_price: { currency: "usd", amount: "49.00" } },
  average_review_rating: 4.5,
  published_reviews_count: 10,
  member_count: 100,
};
const detail = {
  ...listItem,
  visibility: "visible",
  global_affiliate_status: "enabled",
  variants: [{ id: "plan_1", plan_type: "one_time", visibility: "visible", purchase_url: "https://whop.com/checkout/plan_1", initial_price: 49, formatted_price: "$49.00" }],
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

describe("Whop affiliate source", () => {
  const urls: string[] = [];
  beforeEach(() => {
    process.env.WHOP_API_KEY = "test_key";
    process.env.WHOP_AFFILIATE_CODE = "mercavine";
    urls.length = 0;
  });
  afterEach(() => {
    delete process.env.WHOP_API_KEY;
    delete process.env.WHOP_AFFILIATE_CODE;
    setWhopFetchForTests(null);
  });

  it("returns not configured when env vars are missing, without calling Whop", async () => {
    delete process.env.WHOP_AFFILIATE_CODE;
    setWhopFetchForTests(async (u) => { urls.push(u); return json({}); });
    const r = await searchWhopProducts({ query: "x" });
    expect(r.configured).toBe(false);
    expect(urls).toHaveLength(0);
  });

  it("searches the public marketplace (no account_id) and attaches ?a= links with disclosures", async () => {
    setWhopFetchForTests(async (u) => { urls.push(u); return u.includes("/products/prod_") ? json(detail) : json({ data: [listItem], page_info: {} }); });
    const r = (await searchWhopProducts({ query: "options", maxPriceCents: 10000 })) as any;
    expect(urls[0]).toContain("https://api.whop.com/api/v1/products?");
    expect(urls[0]).not.toContain("account_id");
    expect(urls[0]).toContain("price_maximum=100");
    const p = r.results[0];
    expect(p.id).toBe("whop:prod_abc123");
    expect(p.seller.name).toBe("Acme Trading");
    expect(p.price.initial_cents).toBe(4900);
    expect(p.links.checkout.url).toBe("https://whop.com/checkout/plan_1?a=mercavine");
    expect(p.links.product_page.url).toBe("https://whop.com/options-course/?a=mercavine");
    expect(p.links.checkout.disclosure).toBe(WHOP_DISCLOSURE);
    expect(p.label).toMatch(/not Mercavine/);
  });

  it("filters out products not in the global affiliate program", async () => {
    setWhopFetchForTests(async (u) => (u.includes("/products/prod_") ? json({ ...detail, global_affiliate_status: "disabled" }) : json({ data: [listItem] })));
    const r = (await searchWhopProducts({ query: "options" })) as any;
    expect(r.results).toHaveLength(0);
  });

  it("caches responses", async () => {
    setWhopFetchForTests(async (u) => { urls.push(u); return json(detail); });
    await getWhopProduct("whop:prod_abc123");
    await getWhopProduct("whop:prod_abc123");
    expect(urls).toHaveLength(1);
  });

  it("retries on 429 then surfaces a rate-limit error", async () => {
    let n = 0;
    setWhopFetchForTests(async () => { n++; return json({}, 429, { "retry-after": "1" }); }, async () => {});
    await expect(getWhopProduct("whop:prod_abc123")).rejects.toMatchObject({ code: "whop_rate_limited" });
    expect(n).toBe(3);
  });

  it("rejects non-Whop URLs and bad ids", async () => {
    expect(() => affiliateUrl("https://evil.example/x", "m")).toThrow();
    await expect(getWhopProduct("prod_../../x")).rejects.toMatchObject({ code: "invalid_id" });
  });
});
