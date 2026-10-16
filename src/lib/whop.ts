/* eslint-disable @typescript-eslint/no-explicit-any -- untyped Whop API JSON */
/**
 * Whop affiliate product source.
 *
 * Uses ONLY Whop's official REST API (https://api.whop.com/api/v1):
 *   GET /products            — with no account_id, searches the public marketplace (docs: beta "List Products").
 *   GET /products/{id}       — retrieves one product incl. variants[].purchase_url and global_affiliate_status.
 * Never scrape whop.com pages (ToS + robots.txt disallow /discover/search/*) and never automate checkout.
 *
 * Attribution: Whop affiliate links append `?a=<affiliate username>` (docs: developer/guides/affiliates).
 * Buyers pay on Whop's own checkout with their own Whop account. No Stripe, no Mercavine platform fee.
 */
import { ApiError } from "./errors";

export const WHOP_API_BASE = "https://api.whop.com/api/v1";
export const WHOP_API_VERSION = "2026-10-15-1";
export const WHOP_DISCLOSURE = "Mercavine may earn a commission from purchases made through this link.";
export const WHOP_LABEL =
  "Whop product. Sold and fulfilled by the Whop seller, not Mercavine. Payment happens on Whop's checkout with the buyer's own Whop account; Mercavine does not process payment, fulfill, refund, or support this item.";

const CACHE_TTL_MS = 10 * 60 * 1000;
const MAX_CACHE = 500;
const MAX_RETRIES = 2;

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;
let fetcher: Fetcher = (url, init) => fetch(url, init);
let sleeper: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms));
const cache = new Map<string, { at: number; value: unknown }>();
let cooldownUntil = 0;

export function setWhopFetchForTests(f: Fetcher | null, sleep?: (ms: number) => Promise<void>) {
  fetcher = f ?? ((url, init) => fetch(url, init));
  sleeper = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  cache.clear();
  cooldownUntil = 0;
}

export function whopConfig() {
  const apiKey = process.env.WHOP_API_KEY?.trim() || null;
  const affiliateCode = process.env.WHOP_AFFILIATE_CODE?.trim().replace(/^@/, "") || null;
  return { apiKey, affiliateCode, configured: Boolean(apiKey && affiliateCode) };
}

export function notConfigured() {
  return {
    source: "whop",
    configured: false,
    message: "Whop products are not available on Mercavine yet. Whop search is not configured.",
    results: [],
  };
}

export function affiliateUrl(url: string, code: string): string {
  const u = new URL(url);
  if (u.hostname !== "whop.com" && !u.hostname.endsWith(".whop.com")) throw new Error("not a whop url");
  u.searchParams.set("a", code);
  return u.toString();
}

async function whopGet(path: string, params: Record<string, string | number | string[] | undefined>, apiKey: string | null) {
  const url = new URL(WHOP_API_BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === "") continue;
    if (Array.isArray(v)) v.forEach((item) => url.searchParams.append(`${k}[]`, item));
    else url.searchParams.set(k, String(v));
  }
  const key = url.toString();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  if (Date.now() < cooldownUntil) throw new ApiError(503, "whop_rate_limited", "Whop is rate limiting requests. Try again shortly.", { retry_after_ms: cooldownUntil - Date.now() });

  const headers: Record<string, string> = { accept: "application/json", "Api-Version-Date": WHOP_API_VERSION };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetcher(key, { headers, signal: AbortSignal.timeout(8000) });
    } catch {
      if (attempt < MAX_RETRIES) { await sleeper(300 * 2 ** attempt); continue; }
      throw new ApiError(502, "whop_unavailable", "Whop did not respond.");
    }
    if (res.status === 429 || res.status >= 500) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 500 * 2 ** attempt;
      if (attempt < MAX_RETRIES && wait <= 5000) { await sleeper(wait); continue; }
      if (res.status === 429) {
        cooldownUntil = Date.now() + Math.min(Math.max(wait, 1000), 60_000);
        throw new ApiError(503, "whop_rate_limited", "Whop is rate limiting requests. Try again shortly.");
      }
      throw new ApiError(502, "whop_unavailable", "Whop returned an error.");
    }
    if (res.status === 404) return null;
    if (res.status === 401 || res.status === 403) throw new ApiError(502, "whop_auth_failed", "Whop rejected Mercavine's API credentials.");
    if (!res.ok) throw new ApiError(502, "whop_error", `Whop returned ${res.status}.`);
    const value = await res.json();
    if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value as string);
    cache.set(key, { at: Date.now(), value });
    return value;
  }
}

type Money = { amount?: string | number; currency?: string } | number | null | undefined;
function cents(m: Money): number | null {
  const raw = typeof m === "object" && m !== null ? m.amount : m;
  const n = typeof raw === "string" ? Number(raw) : raw;
  return typeof n === "number" && Number.isFinite(n) ? Math.round(n * 100) : null;
}

function priceOf(plan: Record<string, any> | null | undefined) {
  if (!plan) return null;
  const currency = (typeof plan.initial_price === "object" && plan.initial_price?.currency) || plan.currency || "usd";
  const initial = cents(plan.initial_price_due ?? plan.initial_price);
  const renewal = cents(plan.renewal_price);
  return {
    plan_type: plan.plan_type ?? null,
    billing_period_days: plan.billing_period ?? null,
    initial_cents: initial,
    renewal_cents: plan.plan_type === "renewal" ? renewal : null,
    currency: String(currency).toLowerCase(),
    display: plan.formatted_price ?? null,
  };
}

function trim(s: unknown, n: number): string | null {
  if (typeof s !== "string") return null;
  const t = s.trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t || null;
}

export function normalizeWhopProduct(p: Record<string, any>, code: string, detail?: Record<string, any> | null) {
  const d = detail ?? p;
  const variants: Record<string, any>[] = Array.isArray(d.variants) ? d.variants : [];
  const plan = variants.find((v) => v.id === p.default_plan?.id) ?? variants[0] ?? p.default_plan ?? null;
  const productUrl = p.route ? affiliateUrl(`https://whop.com/${encodeURIComponent(p.route)}/`, code) : null;
  const checkoutUrl = plan?.purchase_url ? affiliateUrl(plan.purchase_url, code) : null;
  const affiliateStatus = d.global_affiliate_status ?? null;
  return {
    id: `whop:${p.id}`,
    source: "whop",
    label: WHOP_LABEL,
    name: trim(p.title, 200),
    headline: trim(p.headline, 300),
    description: trim(p.description, detail ? 2000 : 400),
    seller: p.account ? { id: p.account.id ?? null, name: trim(p.account.title, 120) } : null,
    image_url: p.gallery_images?.[0]?.url ?? null,
    images: (p.gallery_images ?? []).map((g: any) => g.url).filter(Boolean).slice(0, 6),
    price: priceOf(plan),
    rating: { average: p.average_review_rating ?? 0, count: p.published_reviews_count ?? 0 },
    member_count: p.member_count ?? 0,
    affiliate_program: affiliateStatus,
    links: {
      product_page: productUrl ? { url: productUrl, disclosure: WHOP_DISCLOSURE } : null,
      checkout: checkoutUrl ? { url: checkoutUrl, disclosure: WHOP_DISCLOSURE } : null,
    },
    variants: detail
      ? variants
          .filter((v) => v.visibility !== "hidden" && v.purchase_url)
          .slice(0, 10)
          .map((v) => ({ id: v.id, title: v.title ?? null, price: priceOf(v), checkout: { url: affiliateUrl(v.purchase_url, code), disclosure: WHOP_DISCLOSURE } }))
      : undefined,
    disclosure: WHOP_DISCLOSURE,
    payment: "Buyer pays on Whop's own checkout with their own Whop account. Not a Mercavine order; no Mercavine cart or approval.",
  };
}

export async function searchWhopProducts(input: { query: string; limit?: number; maxPriceCents?: number; planType?: "one_time" | "renewal"; category?: string; affiliateOnly?: boolean }) {
  const cfg = whopConfig();
  if (!cfg.configured) return notConfigured();
  const limit = Math.min(Math.max(input.limit ?? 8, 1), 10);
  const body = (await whopGet(
    "/products",
    {
      query: input.query.slice(0, 200),
      first: limit,
      price_maximum: input.maxPriceCents != null ? input.maxPriceCents / 100 : undefined,
      plan_types: input.planType ? [input.planType] : undefined,
      marketplace_category_route: input.category,
    },
    cfg.apiKey,
  )) as { data?: Record<string, any>[] } | null;
  const items = (body?.data ?? []).filter((p) => p.default_plan);
  // Detail fetch gives purchase_url + affiliate status; cached, small N.
  const details = await Promise.all(items.map((p) => whopGet(`/products/${encodeURIComponent(p.id)}`, {}, cfg.apiKey).catch(() => null)));
  const affiliateOnly = input.affiliateOnly ?? true;
  const results = items
    .map((p, i) => normalizeWhopProduct(p, cfg.affiliateCode!, details[i] as Record<string, any> | null))
    .filter((r) => (affiliateOnly ? r.affiliate_program === "enabled" : true))
    .map((r) => ({ ...r, variants: undefined }));
  return { source: "whop", configured: true, label: WHOP_LABEL, disclosure: WHOP_DISCLOSURE, results };
}

export async function getWhopProduct(productId: string) {
  const cfg = whopConfig();
  if (!cfg.configured) return notConfigured();
  const id = productId.replace(/^whop:/, "");
  if (!/^prod_[A-Za-z0-9]+$/.test(id)) throw new ApiError(400, "invalid_id", "Whop product ids look like whop:prod_xxx.");
  const detail = (await whopGet(`/products/${id}`, {}, cfg.apiKey)) as Record<string, any> | null;
  if (!detail || detail.visibility === "hidden") throw new ApiError(404, "not_found", "Whop product not found.");
  return normalizeWhopProduct(detail, cfg.affiliateCode!, detail);
}
