import { config } from "./config";
import { parseMcpPayload } from "./shopify";

/**
 * Shop MCP catalog (https://mcp.shop.com/).
 * Product payloads are not cached. Merchant images are source URLs only.
 */

export type ShopOffer = {
  offer_id: string;
  seller: { id: string; name: string; domain: string | null };
  price: { amount: number; currency: string } | null;
  available: boolean | null;
  checkout_url: string | null;
  product_url: string | null;
  image_url: string | null;
  missing: string[];
  linkable: boolean;
};

export type ShopProduct = {
  source: "shop";
  product_id: string;
  title: string;
  description: string;
  url: string | null;
  image_urls: string[];
  offers: ShopOffer[];
  missing: string[];
  messages: string[];
};

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

let shopFetch: FetchLike = fetch;
let fetchCount = 0;
const fetchedUrls: string[] = [];

export function setShopFetchForTests(fn: FetchLike | null) {
  shopFetch = fn ?? fetch;
  fetchCount = 0;
  fetchedUrls.length = 0;
}

export function shopFetchCount() {
  return fetchCount;
}

export function shopFetchedUrls() {
  return [...fetchedUrls];
}

const PROTOCOL = "2026-07-28";
const PUBLIC_CLIENT_ID = "5c733ab2-1903-400a-891e-7ba20c09e2a3";

export const SHOP_OAUTH = {
  clientId: PUBLIC_CLIENT_ID,
  deviceEndpoint: "https://accounts.shop.app/oauth/device",
  tokenEndpoint: "https://accounts.shop.app/oauth/token",
  resource: "https://mcp.shop.com",
  scope: "openid email personal_agent",
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function text(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const rec = asRecord(value);
  if (!rec) return null;
  for (const key of ["plain", "text", "html"]) {
    if (typeof rec[key] === "string" && rec[key]) {
      return key === "html" ? String(rec[key]).replace(/<[^>]+>/g, " ").trim() : String(rec[key]).trim();
    }
  }
  return null;
}

/** Integer amounts are minor units. Decimal numbers and strings are major units. Missing stays null. */
export function minorUnits(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Number.isInteger(value) ? value : Math.round(value * 100);
  }
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    return value.includes(".") ? Math.round(n * 100) : n;
  }
  const rec = asRecord(value);
  if (!rec) return null;
  if ("amount" in rec) return minorUnits(rec.amount);
  if ("value" in rec) return minorUnits(rec.value);
  return null;
}

export function availabilityOf(value: unknown): boolean | null {
  if (typeof value === "boolean") return value;
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.available === "boolean") return rec.available;
  if (typeof rec.in_stock === "boolean") return rec.in_stock;
  return null;
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!/^https:\/\//i.test(trimmed)) return null;
  return trimmed;
}

function imageUrls(product: Record<string, unknown>, variant: Record<string, unknown> | null): string[] {
  const urls: string[] = [];
  const push = (value: unknown) => {
    const direct = httpsUrl(value);
    if (direct) {
      urls.push(direct);
      return;
    }
    const rec = asRecord(value);
    if (!rec) return;
    const nested = httpsUrl(rec.url) || httpsUrl(rec.src);
    if (nested) urls.push(nested);
  };
  for (const list of [variant?.image, variant?.images, product.image, product.images, product.media]) {
    if (Array.isArray(list)) list.forEach(push);
    else push(list);
  }
  return [...new Set(urls)];
}

function messagesOf(payload: unknown): string[] {
  const root = asRecord(payload);
  const content = asRecord(root?.structuredContent) ?? root;
  const list = content?.messages;
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (typeof item === "string" ? item : text(asRecord(item)?.content) || text(item)))
    .filter((item): item is string => Boolean(item))
    .slice(0, 8);
}

function productsFrom(payload: unknown): Record<string, unknown>[] {
  const root = asRecord(payload) ?? {};
  const content = asRecord(root.structuredContent) ?? asRecord(asRecord(root.result)?.structuredContent) ?? root;
  const list = content.products ?? (content.product ? [content.product] : root.products);
  if (!Array.isArray(list)) return [];
  return list.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item));
}

export function shopProductId(id: string): string {
  return id.startsWith("shop:") ? id : `shop:${id}`;
}

export function rawShopId(id: string): string {
  return id.startsWith("shop:") ? id.slice("shop:".length) : id;
}

function offerFrom(product: Record<string, unknown>, variant: Record<string, unknown> | null): ShopOffer {
  const missing: string[] = [];
  const seller = asRecord(variant?.seller) ?? asRecord(product.seller);
  const sellerName = text(seller?.name) || text(product.vendor);
  const domain = text(seller?.domain) || text(product.shop_domain);
  const sellerId = text(seller?.id) || domain;
  if (!sellerName) missing.push("seller");
  const price = minorUnits(variant?.price ?? product.price ?? product.price_range);
  const currency = (text(asRecord(variant?.price)?.currency) || text(asRecord(product.price)?.currency) || text(product.currency) || "").toUpperCase();
  if (price == null) missing.push("price");
  if (!currency) missing.push("currency");
  const available = availabilityOf(variant?.available ?? variant?.availability ?? product.available ?? product.availability);
  if (available == null) missing.push("availability");
  const id = text(variant?.id) || text(product.id);
  if (!id) missing.push("id");
  const productUrl = httpsUrl(product.url) || httpsUrl(product.online_store_url);
  const checkoutUrl = httpsUrl(variant?.checkout_url) || httpsUrl(product.checkout_url) || productUrl;
  if (!checkoutUrl) missing.push("url");
  const images = imageUrls(product, variant);
  const linkable = missing.length === 0 && available === true && (price ?? 0) > 0 && Boolean(sellerName);
  return {
    offer_id: id ? shopProductId(id) : "shop:unknown",
    seller: { id: sellerId || "shop_seller", name: sellerName || "Shop merchant", domain },
    price: price != null && currency ? { amount: price, currency } : null,
    available,
    checkout_url: checkoutUrl,
    product_url: productUrl,
    image_url: images[0] ?? null,
    missing,
    linkable,
  };
}

export function normalizeShopProducts(payload: unknown): ShopProduct[] {
  const notes = messagesOf(asRecord(payload)?.result ?? payload);
  return productsFrom(asRecord(payload)?.result ?? payload).map((product) => {
    const title = text(product.title) || "Untitled product";
    const missing: string[] = [];
    if (!text(product.title)) missing.push("title");
    const variants = Array.isArray(product.variants) ? product.variants.map(asRecord).filter((item): item is Record<string, unknown> => Boolean(item)) : [];
    const offers = (variants.length ? variants : [null]).map((variant) => offerFrom(product, variant));
    const images = imageUrls(product, variants[0] ?? null);
    return {
      source: "shop" as const,
      product_id: shopProductId(text(product.id) || "unknown"),
      title,
      description: text(product.description) || "",
      url: httpsUrl(product.url) || httpsUrl(product.online_store_url),
      image_urls: images,
      offers,
      missing,
      messages: notes,
    };
  });
}

export type ShopLaneStatus = {
  source: "shop";
  status: "disabled" | "ok" | "error";
  reason?: string;
  cached: false;
};

async function devToken(): Promise<string | null> {
  const cfg = config();
  if (!cfg.shopDevClientId || !cfg.shopDevClientSecret) return null;
  const response = await shopFetch("https://api.shopify.com/auth/access_token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_id: cfg.shopDevClientId,
      client_secret: cfg.shopDevClientSecret,
      grant_type: "client_credentials",
    }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) return null;
  const body = (await response.json()) as { access_token?: string };
  return body.access_token ?? null;
}

export async function callShopTool(
  name: string,
  args: unknown,
  token?: string | null,
  fetchImpl: FetchLike = shopFetch,
): Promise<{ ok: boolean; status: number; payload: unknown; error?: string }> {
  const cfg = config();
  fetchCount += 1;
  fetchedUrls.push(cfg.shopMcpUrl);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": PROTOCOL,
    "mcp-method": "tools/call",
    "mcp-name": name,
  };
  if (token) headers.authorization = `Bearer ${token}`;
  const body = {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name,
      arguments: args,
      _meta: {
        "io.modelcontextprotocol/protocolVersion": PROTOCOL,
        "io.modelcontextprotocol/clientInfo": { name: "mercavine", version: "0.1.0" },
        "io.modelcontextprotocol/clientCapabilities": {},
      },
    },
  };
  try {
    const response = await fetchImpl(cfg.shopMcpUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    const textBody = await response.text();
    const payload = textBody ? parseMcpPayload(textBody) : {};
    if (!response.ok) return { ok: false, status: response.status, payload, error: `Shop MCP returned HTTP ${response.status}.` };
    return { ok: true, status: response.status, payload };
  } catch (error) {
    return { ok: false, status: 0, payload: {}, error: error instanceof Error ? error.message : "Shop MCP request failed." };
  }
}

export async function searchShopCatalog(query: {
  q?: string;
  maxPrice?: number;
  limit?: number;
  token?: string | null;
}): Promise<{ products: ShopProduct[]; status: ShopLaneStatus }> {
  const cfg = config();
  if (!cfg.shopCatalogEnabled) {
    return { products: [], status: { source: "shop", status: "disabled", cached: false, reason: "SHOP_CATALOG_ENABLED is false." } };
  }
  const token = query.token || (await devToken());
  const result = await callShopTool(
    "search_catalog",
    {
      catalog: {
        query: query.q ?? "",
        context: { address_country: "US", currency: "USD" },
        filters: {
          ships_to: { country: "US" },
          ...(query.maxPrice != null ? { price: { max: query.maxPrice } } : {}),
        },
        pagination: { limit: Math.min(query.limit ?? 10, 10) },
      },
    },
    token,
  );
  if (!result.ok) return { products: [], status: { source: "shop", status: "error", cached: false, reason: result.error } };
  return { products: normalizeShopProducts(result.payload), status: { source: "shop", status: "ok", cached: false } };
}

export async function getShopProduct(id: string, token?: string | null): Promise<ShopProduct | undefined> {
  const cfg = config();
  if (!cfg.shopCatalogEnabled) return undefined;
  const auth = token || (await devToken());
  const result = await callShopTool(
    "get_product",
    { catalog: { id: rawShopId(id), context: { address_country: "US", currency: "USD" } } },
    auth,
  );
  if (!result.ok) return undefined;
  return normalizeShopProducts(result.payload)[0];
}
