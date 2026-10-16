import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { addDays, now, nowIso } from "./clock";
import { config } from "./config";
import { transaction } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken } from "./ids";
import { assertBotSafe } from "./redact";
import { many, one, run } from "./sql";

/** Fulfillment Outbound API v2020-07-01. Live calls are not signed. */
export const FULFILLMENT_OUTBOUND = {
  preview: "/fba/outbound/2020-07-01/fulfillmentOrders/preview",
  create: "/fba/outbound/2020-07-01/fulfillmentOrders",
  get: (sellerFulfillmentOrderId: string) =>
    `/fba/outbound/2020-07-01/fulfillmentOrders/${encodeURIComponent(sellerFulfillmentOrderId)}`,
} as const;

export type AmazonSellerPublic = {
  seller_id: string;
  seller_name: string;
  connected: boolean;
  selling_partner_id: string | null;
  marketplace_id: string;
  mode: "off" | "mock" | "live";
  prime_enrolled: boolean;
  authorize_url?: string;
};

type SellerRow = { id: string; name: string; prime_enrolled: number };
type LinkPublicRow = { status: string; selling_partner_id: string | null; marketplace_id: string | null };

const SIGNING_NOTE = "Fulfillment was not sent to Amazon. The Mercavine payment is unchanged.";

function assertEnabled(): void {
  if (!config().amazonMcfEnabled) {
    throw new ApiError(403, "amazon_mcf_disabled", "Amazon MCF is off. Set AMAZON_MCF_ENABLED=true to connect a seller account.");
  }
}

function mustSeller(db: DatabaseSync, sellerId: string): SellerRow {
  const seller = one<SellerRow>(db, `SELECT id, name, prime_enrolled FROM sellers WHERE id = ?`, sellerId);
  if (!seller) throw new ApiError(404, "not_found", "Seller not found.");
  return seller;
}

function toPublic(db: DatabaseSync, sellerId: string): AmazonSellerPublic {
  const seller = mustSeller(db, sellerId);
  const link = one<LinkPublicRow>(
    db,
    `SELECT status, selling_partner_id, marketplace_id FROM amazon_seller_links WHERE seller_id = ?`,
    sellerId,
  );
  const cfg = config();
  const body: AmazonSellerPublic = {
    seller_id: seller.id,
    seller_name: seller.name,
    connected: link?.status === "connected",
    selling_partner_id: link?.selling_partner_id ?? null,
    marketplace_id: link?.marketplace_id || cfg.amazonMarketplaceId,
    mode: cfg.amazonMcfMode,
    prime_enrolled: seller.prime_enrolled === 1,
  };
  if (process.env.NODE_ENV !== "production") assertBotSafe(body);
  return body;
}

export function listSellerConnections(): Array<AmazonSellerPublic & { enabled: boolean; live_fallback: boolean }> {
  return transaction((db) => {
    const cfg = config();
    const rows = many<{ id: string }>(db, `SELECT id FROM sellers ORDER BY name`);
    return rows.map((row) => ({
      ...toPublic(db, row.id),
      enabled: cfg.amazonMcfEnabled,
      live_fallback: cfg.amazonMcfLiveRequested && cfg.amazonMcfMode !== "live",
    }));
  });
}

export function amazonSellerPublic(sellerId: string): AmazonSellerPublic {
  assertEnabled();
  return transaction((db) => toPublic(db, sellerId));
}

function mockPartner(sellerId: string): string {
  return `A1MOCK${sellerId.replace(/[^A-Za-z0-9]/g, "").toUpperCase()}`.slice(0, 20);
}

function rememberLink(
  db: DatabaseSync,
  sellerId: string,
  fields: { status: string; sellingPartnerId: string | null; refreshToken: string | null; oauthState: string | null },
): void {
  const cfg = config();
  const at = nowIso();
  const existing = one<{ seller_id: string }>(db, `SELECT seller_id FROM amazon_seller_links WHERE seller_id = ?`, sellerId);
  if (!existing) {
    run(
      db,
      `INSERT INTO amazon_seller_links (
        seller_id, status, selling_partner_id, refresh_token, marketplace_id, oauth_state, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      sellerId,
      fields.status,
      fields.sellingPartnerId,
      fields.refreshToken,
      cfg.amazonMarketplaceId,
      fields.oauthState,
      at,
      at,
    );
    return;
  }
  run(
    db,
    `UPDATE amazon_seller_links
     SET status = ?, selling_partner_id = ?, refresh_token = ?, marketplace_id = ?, oauth_state = ?, updated_at = ?
     WHERE seller_id = ?`,
    fields.status,
    fields.sellingPartnerId,
    fields.refreshToken,
    cfg.amazonMarketplaceId,
    fields.oauthState,
    at,
    sellerId,
  );
}

function authorizeUrl(state: string): string {
  const cfg = config();
  const url = new URL(cfg.amazonSellerCentralAuthorize);
  url.searchParams.set("application_id", cfg.amazonSpAppId ?? "");
  url.searchParams.set("state", state);
  if (cfg.amazonSpAppDraft) url.searchParams.set("version", "beta");
  return url.toString();
}

/** Website authorization workflow. Mock stores a refresh token without leaving the server. */
export function connectAmazonSeller(sellerId: string): AmazonSellerPublic {
  assertEnabled();
  return transaction((db) => {
    mustSeller(db, sellerId);
    const cfg = config();
    if (cfg.amazonMcfMode === "mock") {
      rememberLink(db, sellerId, {
        status: "connected",
        sellingPartnerId: mockPartner(sellerId),
        refreshToken: `Atzr|mock|${randomToken(24)}`,
        oauthState: null,
      });
      return toPublic(db, sellerId);
    }
    const state = randomToken(24);
    const current = one<{ refresh_token: string | null; selling_partner_id: string | null; status: string }>(
      db,
      `SELECT refresh_token, selling_partner_id, status FROM amazon_seller_links WHERE seller_id = ?`,
      sellerId,
    );
    rememberLink(db, sellerId, {
      status: current?.status === "connected" ? "connected" : "pending",
      sellingPartnerId: current?.selling_partner_id ?? null,
      refreshToken: current?.refresh_token ?? null,
      oauthState: state,
    });
    return { ...toPublic(db, sellerId), authorize_url: authorizeUrl(state) };
  });
}

async function exchangeAuthorizationCode(code: string): Promise<string> {
  const cfg = config();
  if (!cfg.amazonLwaClientId || !cfg.amazonLwaClientSecret) {
    throw new ApiError(502, "amazon_oauth_failed", "Amazon did not return a refresh token. The seller account was not connected.");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${cfg.publicBaseUrl}/amazon/callback`,
    client_id: cfg.amazonLwaClientId,
    client_secret: cfg.amazonLwaClientSecret,
  });
  let response: Response;
  try {
    response = await fetch(cfg.amazonLwaTokenUrl, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
  } catch {
    throw new ApiError(502, "amazon_oauth_failed", "Amazon did not return a refresh token. The seller account was not connected.");
  }
  if (!response.ok) {
    throw new ApiError(502, "amazon_oauth_failed", "Amazon did not return a refresh token. The seller account was not connected.");
  }
  const json = (await response.json()) as { refresh_token?: unknown };
  if (typeof json.refresh_token !== "string" || !json.refresh_token) {
    throw new ApiError(502, "amazon_oauth_failed", "Amazon did not return a refresh token. The seller account was not connected.");
  }
  return json.refresh_token;
}

export async function completeAmazonOAuth(input: {
  code: string;
  state: string;
  sellingPartnerId: string;
}): Promise<AmazonSellerPublic> {
  assertEnabled();
  const pending = transaction((db) =>
    one<{ seller_id: string }>(db, `SELECT seller_id FROM amazon_seller_links WHERE oauth_state = ?`, input.state),
  );
  if (!input.state || !pending) {
    throw new ApiError(400, "invalid_state", "This Amazon authorization session is unknown or already used.");
  }
  const cfg = config();
  let refreshToken: string;
  let sellingPartnerId = input.sellingPartnerId.trim();
  if (cfg.amazonMcfMode === "live") {
    if (!input.code) {
      throw new ApiError(400, "amazon_oauth_failed", "Amazon did not return an authorization code.");
    }
    refreshToken = await exchangeAuthorizationCode(input.code);
  } else {
    refreshToken = `Atzr|mock|${randomToken(24)}`;
    if (!sellingPartnerId) sellingPartnerId = mockPartner(pending.seller_id);
  }
  if (!sellingPartnerId) {
    throw new ApiError(400, "amazon_oauth_failed", "Amazon did not return a selling partner id.");
  }
  return transaction((db) => {
    const still = one<{ seller_id: string }>(db, `SELECT seller_id FROM amazon_seller_links WHERE seller_id = ? AND oauth_state = ?`, pending.seller_id, input.state);
    if (!still) throw new ApiError(400, "invalid_state", "This Amazon authorization session is unknown or already used.");
    rememberLink(db, pending.seller_id, {
      status: "connected",
      sellingPartnerId,
      refreshToken,
      oauthState: null,
    });
    return toPublic(db, pending.seller_id);
  });
}

export function setPrimeEnrolled(sellerId: string, enrolled: boolean): AmazonSellerPublic {
  if (!config().devTools) throw new ApiError(404, "not_found", "Dev tools are off.");
  assertEnabled();
  return transaction((db) => {
    mustSeller(db, sellerId);
    run(db, `UPDATE sellers SET prime_enrolled = ? WHERE id = ?`, enrolled ? 1 : 0, sellerId);
    return toPublic(db, sellerId);
  });
}

export function primeDeliveryBadge(fbaBacked: boolean, primeEnrolled: boolean): boolean {
  return config().amazonMcfEnabled && fbaBacked && primeEnrolled;
}

type FulfillLine = { offerId: string | null; quantity: number };

function sellerFulfillmentOrderId(orderId: string): string {
  return `MCF${createHash("sha256").update(orderId).digest("hex").slice(0, 20)}`;
}

function trackingDigits(orderId: string): string {
  const hex = createHash("sha256").update(orderId).digest("hex");
  let out = "";
  for (const ch of hex) {
    out += String(parseInt(ch, 16) % 10);
    if (out.length === 12) break;
  }
  return out;
}

function mockPreview(): { earliest: string; latest: string } {
  const today = now();
  return { earliest: addDays(today, 2), latest: addDays(today, 5) };
}

/**
 * After a native order is paid. Mock writes a local fulfillment order and copies tracking
 * onto the Mercavine order. Live mode records that SigV4 is not implemented and does not
 * call SP-API. Failures here must not change the payment.
 */
export function fulfillNativeOrder(
  db: DatabaseSync,
  input: { orderId: string; sellerId: string; lines: FulfillLine[] },
): void {
  try {
    const cfg = config();
    if (cfg.amazonMcfMode === "off") return;
    const offerIds = input.lines.map((line) => line.offerId).filter((id): id is string => Boolean(id));
    if (!offerIds.length) return;
    const placeholders = offerIds.map(() => "?").join(", ");
    const fba = many<{ id: string; sku: string }>(
      db,
      `SELECT id, sku FROM offers WHERE fba_backed = 1 AND id IN (${placeholders})`,
      ...offerIds,
    );
    if (!fba.length) return;
    const link = one<{ status: string; refresh_token: string | null }>(
      db,
      `SELECT status, refresh_token FROM amazon_seller_links WHERE seller_id = ?`,
      input.sellerId,
    );
    if (!link || link.status !== "connected" || !link.refresh_token) return;

    const sfoId = sellerFulfillmentOrderId(input.orderId);
    const at = nowIso();
    if (cfg.amazonMcfMode === "live") {
      const qty = new Map<string, number>();
      for (const line of input.lines) {
        if (!line.offerId || !fba.some((offer) => offer.id === line.offerId)) continue;
        qty.set(line.offerId, (qty.get(line.offerId) ?? 0) + line.quantity);
      }
      const itemCount = [...qty.values()].reduce((sum, count) => sum + count, 0);
      const detail = `Not sent. AWS SigV4 is not implemented. Would call POST ${cfg.amazonSpApiEndpoint}${FULFILLMENT_OUTBOUND.preview} and POST ${cfg.amazonSpApiEndpoint}${FULFILLMENT_OUTBOUND.create} with ${itemCount} item(s), then GET ${cfg.amazonSpApiEndpoint}${FULFILLMENT_OUTBOUND.get(sfoId)}.`;
      run(
        db,
        `INSERT INTO mcf_orders (
          id, order_id, seller_id, seller_fulfillment_order_id, status, shipping_speed,
          earliest_arrival, latest_arrival, carrier, tracking_number, detail, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'signing_unavailable', 'Standard', NULL, NULL, NULL, NULL, ?, ?, ?)`,
        newId("mcf"),
        input.orderId,
        input.sellerId,
        sfoId,
        detail,
        at,
        at,
      );
      return;
    }
    const preview = mockPreview();
    const carrier = "Amazon Logistics";
    const tracking = `TBA${trackingDigits(input.orderId)}`;
    run(
      db,
      `INSERT INTO mcf_orders (
        id, order_id, seller_id, seller_fulfillment_order_id, status, shipping_speed,
        earliest_arrival, latest_arrival, carrier, tracking_number, detail, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'received', 'Standard', ?, ?, ?, ?, NULL, ?, ?)`,
      newId("mcf"),
      input.orderId,
      input.sellerId,
      sfoId,
      preview.earliest,
      preview.latest,
      carrier,
      tracking,
      at,
      at,
    );
    run(
      db,
      `UPDATE orders SET tracking_carrier = ?, tracking_number = ?, updated_at = ? WHERE id = ?`,
      carrier,
      tracking,
      at,
      input.orderId,
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "mcf skipped");
  }
}

export { SIGNING_NOTE };
