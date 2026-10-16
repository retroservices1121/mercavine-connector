import { searchNative, getNativeProduct } from "./catalog";
import { getShopProduct, searchShopCatalog, type ShopLaneStatus } from "./shop-mcp";
import { getShopifyProduct, searchShopify, shopifyLaneStatus, type ShopifyLaneStatus } from "./shopify";

export type Lane = "native" | "shopify" | "shop" | "all";

type ShopReport = ShopLaneStatus | { source: "shop"; status: "not_queried"; cached: false };

export async function searchAcross(lane: string, query: { q?: string; category?: string; maxPrice?: number; inStock?: boolean; limit?: number }) {
  const results: Record<string, unknown>[] = [];
  const useNative = lane !== "shopify" && lane !== "shop";
  const useShopify = lane === "shopify" || lane === "all";
  const useShop = lane === "shop" || lane === "all";
  if (useNative) {
    results.push(...searchNative(query).map((product) => ({ ...product, source: "native" as const })));
  }
  let shopify: ShopifyLaneStatus = shopifyLaneStatus();
  if (useShopify) {
    const remote = await searchShopify(query);
    shopify = remote.status;
    results.push(...remote.products.map((product) => ({ ...product, source: "shopify" as const })));
  }
  let shop: ShopReport = { source: "shop", status: "not_queried", cached: false };
  if (useShop) {
    const remote = await searchShopCatalog({ q: query.q, maxPrice: query.maxPrice, limit: query.limit });
    shop = remote.status;
    results.push(...remote.products);
  }
  return { results, shopify, shop };
}

export async function lookupProduct(id: string, source?: string) {
  const decoded = decodeURIComponent(id);
  if (source === "shop" || decoded.startsWith("shop:")) {
    return (await getShopProduct(decoded)) ?? null;
  }
  if (source === "shopify" || decoded.startsWith("gid:") || decoded.includes("shopify")) {
    const product = await getShopifyProduct(decoded);
    return product ? { ...product, source: "shopify" as const } : null;
  }
  const product = getNativeProduct(decoded);
  return product ? { ...product, source: "native" as const } : null;
}
