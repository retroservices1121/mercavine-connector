/**
 * CJdropshipping API 2.0 client. Server-only.
 * - Token: exchanges CJ_API_KEY for an access token (authentication/getAccessToken) and caches it in
 *   the settings table; refreshes ahead of expiry and once on a 401/expired-token response.
 * - Throttle: at most one request per second (CJ's documented limit), serialized across callers.
 * - Points: tracks CJ's per-endpoint point cost per UTC day in settings (cj_points:<date>) and refuses
 *   calls that would exceed CJ_DAILY_POINT_BUDGET (default 40,000 of CJ's 50,000/day).
 * The transport is injectable so tests never reach CJ.
 */
import { getDb } from "./db";
import { run, one } from "./sql";

export const CJ_BASE = "https://developers.cjdropshipping.com/api2.0/v1/";

/** Documented point cost per endpoint. Unknown endpoints are charged 10. */
export const CJ_POINTS: Record<string, number> = {
  "authentication/getAccessToken": 0,
  "authentication/refreshAccessToken": 0,
  "product/getCategory": 10,
  "product/list": 50,
  "product/query": 10,
  "product/stock/queryByVid": 10,
  "logistic/freightCalculate": 10,
  "shopping/order/createOrderV2": 10,
  "shopping/order/getOrderDetail": 10,
};

export type CjResponse<T = unknown> = { code: number; result?: boolean; message: string; data: T; requestId?: string };
export type CjTransport = (input: { method: "GET" | "POST"; path: string; query?: Record<string, string | number>; body?: unknown; token?: string }) => Promise<CjResponse>;

export class CjError extends Error {
  constructor(public code: number, message: string, public path: string) {
    super(`CJ ${path}: ${code} ${message}`);
  }
}

const fetchTransport: CjTransport = async ({ method, path, query, body, token }) => {
  const url = new URL(path, CJ_BASE);
  for (const [k, v] of Object.entries(query ?? {})) url.searchParams.set(k, String(v));
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers["CJ-Access-Token"] = token;
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = (await res.json().catch(() => ({ code: res.status, message: res.statusText, data: null }))) as CjResponse;
  return json;
};

let transport: CjTransport = fetchTransport;
let minIntervalMs = 1100;
let lastCallAt = 0;
let chain: Promise<unknown> = Promise.resolve();

/** Tests: swap the network layer and the throttle interval. */
export function setCjTransport(t: CjTransport | null, intervalMs?: number) {
  transport = t ?? fetchTransport;
  if (intervalMs !== undefined) minIntervalMs = intervalMs;
  lastCallAt = 0;
}

export function cjConfigured(): boolean {
  return Boolean(process.env.CJ_API_KEY?.trim());
}

function dailyBudget(): number {
  const n = Number(process.env.CJ_DAILY_POINT_BUDGET ?? 40_000);
  return Number.isFinite(n) && n > 0 ? n : 40_000;
}

function pointsKey(): string {
  return `cj_points:${new Date().toISOString().slice(0, 10)}`;
}

export function pointsUsedToday(): number {
  const row = one<{ value: string }>(getDb(), `SELECT value FROM settings WHERE key = ?`, pointsKey());
  return row ? Number(row.value) : 0;
}

function addPoints(n: number) {
  if (!n) return;
  run(getDb(), `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = CAST(value AS INTEGER) + ?`, pointsKey(), String(n), n);
}

async function throttled<T>(fn: () => Promise<T>): Promise<T> {
  const next = chain.then(async () => {
    const wait = lastCallAt + minIntervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  chain = next.catch(() => undefined);
  return next;
}

type TokenRow = { accessToken: string; accessTokenExpiryDate: string };

function cachedToken(): TokenRow | null {
  const row = one<{ value: string }>(getDb(), `SELECT value FROM settings WHERE key = 'cj_token'`);
  if (!row) return null;
  try {
    const t = JSON.parse(row.value) as TokenRow;
    // Refresh a day early.
    if (Date.parse(t.accessTokenExpiryDate) - Date.now() < 86_400_000) return null;
    return t;
  } catch {
    return null;
  }
}

async function fetchToken(): Promise<string> {
  const apiKey = process.env.CJ_API_KEY?.trim();
  if (!apiKey) throw new CjError(0, "CJ_API_KEY is not set", "authentication/getAccessToken");
  const res = await throttled(() => transport({ method: "POST", path: "authentication/getAccessToken", body: { apiKey } }));
  const data = res.data as TokenRow | null;
  if (res.code !== 200 || !data?.accessToken) throw new CjError(res.code, res.message, "authentication/getAccessToken");
  run(getDb(), `INSERT INTO settings (key, value) VALUES ('cj_token', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    JSON.stringify({ accessToken: data.accessToken, accessTokenExpiryDate: data.accessTokenExpiryDate }));
  return data.accessToken;
}

export function clearCjToken() {
  run(getDb(), `DELETE FROM settings WHERE key = 'cj_token'`);
}

/** One CJ call: budget check, throttle, token, one retry on an expired token. */
export async function cjCall<T = unknown>(method: "GET" | "POST", path: string, opts: { query?: Record<string, string | number>; body?: unknown } = {}): Promise<T> {
  const cost = CJ_POINTS[path] ?? 10;
  if (pointsUsedToday() + cost > dailyBudget()) throw new CjError(429, "daily CJ point budget reached", path);
  let token = cachedToken()?.accessToken ?? (await fetchToken());
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await throttled(() => transport({ method, path, query: opts.query, body: opts.body, token }));
    addPoints(cost);
    if (res.code === 200) return res.data as T;
    // 1600001 = invalid/expired token per CJ error codes; 401 for transport-level auth failures.
    if (attempt === 0 && (res.code === 1600001 || res.code === 401)) {
      clearCjToken();
      token = await fetchToken();
      continue;
    }
    throw new CjError(res.code, res.message, path);
  }
  throw new CjError(500, "unreachable", path);
}

// ---- Typed read endpoints ----
export type CjListItem = {
  pid: string; productNameEn: string; productSku: string; productImage: string; productWeight: string;
  productType: string; categoryName: string; categoryId: string; sellPrice: string; isFreeShipping?: boolean;
  supplierName?: string; shippingCountryCodes?: string[];
};
export type CjVariant = { vid: string; variantSku: string; variantSellPrice: number | string; variantNameEn?: string; variantWeight?: number };
export type CjProduct = { pid: string; productNameEn: string; description?: string; productImage: string; categoryName?: string; variants: CjVariant[] };
export type CjStock = { vid: string; countryCode: string; totalInventoryNum?: number; storageNum?: number };
export type CjFreight = { logisticName: string; logisticPrice: number | string; logisticAging?: string };

export const cj = {
  categories: () => cjCall<unknown[]>("GET", "product/getCategory"),
  listProducts: (q: { categoryId?: string; pageNum?: number; pageSize?: number; productNameEn?: string }) =>
    cjCall<{ total: number; list: CjListItem[] }>("GET", "product/list", { query: { countryCode: "US", pageNum: 1, pageSize: 100, ...q } }),
  product: (pid: string) => cjCall<CjProduct>("GET", "product/query", { query: { pid } }),
  stock: (vid: string) => cjCall<CjStock[]>("GET", "product/stock/queryByVid", { query: { vid } }),
  freight: (vid: string, quantity: number, zip: string) =>
    cjCall<CjFreight[]>("POST", "logistic/freightCalculate", { body: { startCountryCode: "US", endCountryCode: "US", zip, products: [{ vid, quantity }] } }),
  orderDetail: (orderId: string) =>
    cjCall<{ orderId: string; orderStatus: string; trackNumber?: string | null; trackingUrl?: string | null; logisticName?: string | null; trackingProvider?: string | null }>(
      "GET", "shopping/order/getOrderDetail", { query: { orderId } }),
  /** WRITE. Only called from placeSupplierOrder when CJ_ORDERS_LIVE=true and an admin approved. payType=3: create only, no payment. */
  createOrderV2: (body: Record<string, unknown>) => cjCall<{ orderId: string; orderStatus?: string }>("POST", "shopping/order/createOrderV2", { body }),
};

export function usStock(rows: CjStock[]): number {
  return rows.filter((r) => r.countryCode === "US").reduce((n, r) => n + Number(r.totalInventoryNum ?? r.storageNum ?? 0), 0);
}
