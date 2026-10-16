import { config } from "./config";
import { ApiError } from "./errors";
import { money, type Money } from "./money";

export const SPONSORED_LABEL = "Sponsored";
export const SPONSORED_DISCLOSURE = "Sponsored. We may earn a commission on purchases.";

/** Shopper-facing placement. The commission rate is never included. */
export type ShopifyPlacement = {
  type: string;
};

export type ShopifyOffer = {
  offer_id: string;
  seller: { id: string; name: string };
  price: Money;
  stock: number | null;
  /** Variant url exactly as Shopify sent it, including shclid and shcgid. */
  url: string | null;
  continue_url: string | null;
  checkout_url: string | null;
  placement: ShopifyPlacement | null;
  label?: typeof SPONSORED_LABEL;
  disclosure?: typeof SPONSORED_DISCLOSURE;
};

export type ShopifyProduct = {
  product_id: string;
  title: string;
  description: string;
  category: string;
  provider: "shopify";
  url?: string;
  offers: ShopifyOffer[];
  disclosure?: typeof SPONSORED_DISCLOSURE;
};

export type ShopifyLaneStatus = {
  status: "not_queried" | "disabled" | "ok" | "stub" | "error";
  reason?: string;
  in_bot_checkout: boolean;
  checkout: "continue_url_handoff" | "permission_pending";
  promoted?: "off" | "requested" | "included" | "organic_only";
  placement_message?: string;
  disclosure?: typeof SPONSORED_DISCLOSURE;
};

export type ShopifyCatalogMessage = { type?: string; code?: string; content: string };

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

function descriptionOf(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "object") {
    const record = value as { plain?: string; html?: string };
    return record.plain || record.html?.replace(/<[^>]+>/g, " ") || "";
  }
  return "";
}

/** Keep the catalog string. Do not parse or rebuild it; that can drop or reorder shclid and shcgid. */
export function exactUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function placementOf(value: unknown): ShopifyPlacement | null {
  if (!value || typeof value !== "object") return null;
  const placement = value as { type?: unknown };
  if (typeof placement.type !== "string" || !placement.type.trim()) return null;
  return { type: placement.type };
}

export function shopifyMessages(payload: unknown): ShopifyCatalogMessage[] {
  const root = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  const result = root.result && typeof root.result === "object" ? (root.result as Record<string, unknown>) : {};
  const structured = result.structuredContent && typeof result.structuredContent === "object" ? (result.structuredContent as Record<string, unknown>) : {};
  const lists = [root.messages, result.messages, structured.messages];
  const notes: ShopifyCatalogMessage[] = [];
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!item || typeof item !== "object") continue;
      const row = item as { type?: unknown; code?: unknown; content?: unknown };
      if (typeof row.content !== "string" || !row.content.trim()) continue;
      notes.push({
        type: typeof row.type === "string" ? row.type : undefined,
        code: typeof row.code === "string" ? row.code : undefined,
        content: row.content,
      });
    }
  }
  return notes;
}

export function organicOnlyMessage(messages: ShopifyCatalogMessage[]): ShopifyCatalogMessage | undefined {
  return messages.find((note) => note.code === "unauthorized" || /not authorized|aren't authorized|are not authorized/i.test(note.content));
}

export function normalizeShopifyProducts(payload: unknown): ShopifyProduct[] {
  const root = payload as { products?: unknown[]; result?: { structuredContent?: { products?: unknown[] } } };
  const products = root.products ?? root.result?.structuredContent?.products ?? [];
  return products.map((item) => {
    const product = item as {
      id?: string;
      title?: string;
      description?: unknown;
      url?: string;
      variants?: {
        id?: string;
        title?: string;
        price?: { amount?: number; currency?: string };
        url?: string;
        checkout_url?: string;
        availability?: { available?: boolean };
        seller?: { id?: string; name?: string };
        placement?: unknown;
      }[];
    };
    const offers = (product.variants ?? []).map((variant) => {
      const attributed = exactUrl(variant.url) ?? exactUrl(variant.checkout_url) ?? exactUrl(product.url);
      const placement = placementOf(variant.placement);
      const sponsored = placement != null;
      const offer: ShopifyOffer = {
        offer_id: variant.id || product.id || "shopify_unknown",
        seller: { id: variant.seller?.id || "shopify_seller", name: variant.seller?.name || "Shopify merchant" },
        price: money(variant.price?.amount ?? 0),
        stock: variant.availability?.available === false ? 0 : null,
        url: attributed,
        continue_url: attributed,
        checkout_url: exactUrl(variant.checkout_url) ?? attributed,
        placement,
      };
      if (sponsored) {
        offer.label = SPONSORED_LABEL;
        offer.disclosure = SPONSORED_DISCLOSURE;
      }
      return offer;
    });
    const sponsored = offers.some((offer) => offer.label === SPONSORED_LABEL);
    return {
      product_id: product.id || "shopify_unknown",
      title: product.title || "Shopify product",
      description: descriptionOf(product.description).trim(),
      category: "shopify",
      provider: "shopify" as const,
      url: exactUrl(product.url) ?? undefined,
      offers,
      ...(sponsored ? { disclosure: SPONSORED_DISCLOSURE } : {}),
    };
  });
}

export function shopifyLaneStatus(partial?: Partial<ShopifyLaneStatus>): ShopifyLaneStatus {
  const cfg = config();
  return {
    status: "not_queried",
    in_bot_checkout: false,
    checkout: cfg.shopifyInBotCheckout ? "permission_pending" : "continue_url_handoff",
    ...partial,
  };
}

export async function searchShopify(
  query: { q?: string; maxPrice?: number; limit?: number },
  fetchImpl: FetchLike = fetch,
): Promise<{ products: ShopifyProduct[]; status: ShopifyLaneStatus }> {
  const cfg = config();
  if (!cfg.shopifyCatalogEnabled) {
    return {
      products: [],
      status: shopifyLaneStatus({
        status: "disabled",
        reason: "Set SHOPIFY_CATALOG_ENABLED=true to query catalog.shopify.com. No Shopify credentials are configured.",
      }),
    };
  }
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "search_catalog",
      arguments: {
        meta: { "ucp-agent": { profile: cfg.shopifyAgentProfile } },
        catalog: {
          query: query.q ?? "",
          ...(cfg.shopifyCatalogId ? { catalog_id: cfg.shopifyCatalogId } : {}),
          filters: {
            available: true,
            ships_to: { country: "US" },
            ...(query.maxPrice != null ? { price: { max: query.maxPrice } } : {}),
          },
          context: { address_country: "US" },
          pagination: { limit: Math.min(query.limit ?? 10, 10) },
        },
      },
    },
  };
  try {
    const response = await fetchImpl(cfg.shopifyCatalogUrl, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const text = await response.text();
    if (!response.ok) {
      return { products: [], status: shopifyLaneStatus({ status: "error", reason: `Shopify catalog returned HTTP ${response.status}.` }) };
    }
    const parsed = parseMcpPayload(text);
    const products = normalizeShopifyProducts(parsed);
    const note = organicOnlyMessage(shopifyMessages(parsed));
    const sponsored = products.some((product) => product.disclosure);
    const promoted = note ? "organic_only" : cfg.shopifyCatalogId ? (sponsored ? "included" : "requested") : "off";
    return {
      products,
      status: shopifyLaneStatus({
        status: "ok",
        promoted,
        ...(note ? { placement_message: note.content } : {}),
        ...(sponsored ? { disclosure: SPONSORED_DISCLOSURE } : {}),
      }),
    };
  } catch (error) {
    return {
      products: [],
      status: shopifyLaneStatus({ status: "error", reason: error instanceof Error ? error.message : "Shopify catalog request failed." }),
    };
  }
}

export function parseMcpPayload(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed) as unknown;
  const dataLines = trimmed
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter((line) => line && line !== "[DONE]");
  const last = dataLines.at(-1);
  return last ? (JSON.parse(last) as unknown) : {};
}

export async function getShopifyProduct(id: string, fetchImpl: FetchLike = fetch): Promise<ShopifyProduct | undefined> {
  const cfg = config();
  if (!cfg.shopifyCatalogEnabled) return undefined;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "get_product",
      arguments: {
        meta: { "ucp-agent": { profile: cfg.shopifyAgentProfile } },
        catalog: { id },
      },
    },
  };
  const response = await fetchImpl(cfg.shopifyCatalogUrl, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const parsed = parseMcpPayload(await response.text()) as { result?: { structuredContent?: { product?: unknown } } };
  const product = parsed.result?.structuredContent?.product;
  if (!product) return undefined;
  return normalizeShopifyProducts({ products: [product] })[0];
}

export function shopifyHandoffMessage(): { code?: string; message: string; in_bot_checkout: false } {
  const cfg = config();
  if (cfg.shopifyInBotCheckout) {
    return {
      code: "shopify_permission_pending",
      in_bot_checkout: false,
      message: `${cfg.brandName} would call complete_checkout only after Shopify grants that permission. Until then the buyer finishes on the merchant's continue_url. No card data is sent.`,
    };
  }
  return {
    in_bot_checkout: false,
    message: "In-bot Shopify checkout is off. Open the merchant continue_url to pay. Mercavine does not charge Shopify orders.",
  };
}

export function refuseInBotShopifyCheckout(): never {
  throw new ApiError(403, "shopify_permission_pending", shopifyHandoffMessage().message);
}
