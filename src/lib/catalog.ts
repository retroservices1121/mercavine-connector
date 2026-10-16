import { primeDeliveryBadge } from "./amazon-mcf";
import { addDays, now } from "./clock";
import { config } from "./config";
import { getDb } from "./db";
import { money, type Money } from "./money";
import { many, one } from "./sql";

export type OfferView = {
  offer_id: string;
  seller: { id: string; name: string; rating: number; rating_count: number };
  price: Money;
  stock: number;
  shipping_est: { amount: number; currency: "usd"; eta: [string, string] };
  return_policy: { window_days: number; restocking_fee_pct: number; note?: string };
  fulfillment: "fba" | "merchant";
  /** 'digital' offers need no shipping address, ship free, and deliver instantly. */
  fulfillment_type: "physical" | "digital";
  delivery_label?: "Instant";
  prime_delivery: boolean;
};

export type ProductView = {
  product_id: string;
  title: string;
  description: string;
  category: string;
  provider: "native";
  offers: OfferView[];
};

type SearchRow = {
  product_id: string;
  title: string;
  description: string;
  category: string;
  offer_id: string;
  seller_id: string;
  seller_name: string;
  rating: number;
  rating_count: number;
  price_cents: number;
  stock: number;
  shipping_cents: number;
  eta_min_days: number;
  eta_max_days: number;
  return_window_days: number;
  restocking_fee_pct: number;
  fba_backed: number;
  prime_enrolled: number;
  held: number;
  fulfillment_type: string | null;
};

/** SQL predicate for sellers whose offers shoppers may see and buy. */
export function sellerVisibleSql(alias = "s"): string {
  const base = `${alias}.status = 'active'`;
  if (config().sampleCatalog) return base;
  return `${base} AND ${alias}.user_id IS NOT NULL AND ${alias}.stripe_charges_enabled = 1 AND ${alias}.stripe_account_id LIKE 'acct_%' AND ${alias}.stripe_account_id NOT LIKE 'acct_mock%'`;
}

function heldSql() {
  return `COALESCE((SELECT SUM(qty) FROM inventory_reservations r WHERE r.offer_id = o.id AND r.status = 'held' AND r.expires_at > ?), 0)`;
}

function toProduct(rows: SearchRow[]): ProductView[] {
  const map = new Map<string, ProductView>();
  const today = now();
  for (const row of rows) {
    let product = map.get(row.product_id);
    if (!product) {
      product = {
        product_id: row.product_id,
        title: row.title,
        description: row.description,
        category: row.category,
        provider: "native",
        offers: [],
      };
      map.set(row.product_id, product);
    }
    const sellable = Math.max(0, row.stock - row.held);
    const fba = row.fba_backed === 1;
    const digital = row.fulfillment_type === "digital";
    if (digital) {
      product.offers.push({
        offer_id: row.offer_id,
        seller: { id: row.seller_id, name: row.seller_name, rating: row.rating, rating_count: row.rating_count },
        price: money(row.price_cents),
        stock: sellable,
        shipping_est: { amount: 0, currency: "usd", eta: [addDays(today, 0), addDays(today, 0)] },
        return_policy: { window_days: 0, restocking_fee_pct: 0, note: "Digital item: see seller's terms. No returns once downloaded." },
        fulfillment: "merchant",
        prime_delivery: false,
        fulfillment_type: "digital",
        delivery_label: "Instant",
      });
      continue;
    }
    product.offers.push({
      fulfillment_type: "physical",
      offer_id: row.offer_id,
      seller: { id: row.seller_id, name: row.seller_name, rating: row.rating, rating_count: row.rating_count },
      price: money(row.price_cents),
      stock: sellable,
      shipping_est: {
        amount: row.shipping_cents,
        currency: "usd",
        eta: [addDays(today, row.eta_min_days), addDays(today, row.eta_max_days)],
      },
      return_policy: { window_days: row.return_window_days, restocking_fee_pct: row.restocking_fee_pct },
      fulfillment: fba ? "fba" : "merchant",
      prime_delivery: primeDeliveryBadge(fba, row.prime_enrolled === 1),
    });
  }
  return [...map.values()];
}

const SELECT = `
  SELECT p.id AS product_id, p.title, p.description, p.category,
         o.id AS offer_id, s.id AS seller_id, s.name AS seller_name, s.rating, s.rating_count,
         o.price_cents, o.stock, o.shipping_cents, o.eta_min_days, o.eta_max_days,
         o.return_window_days, o.restocking_fee_pct, o.fba_backed, s.prime_enrolled, o.fulfillment_type,
         ${heldSql()} AS held
  FROM products p
  JOIN offers o ON o.product_id = p.id
  JOIN sellers s ON s.id = o.seller_id
`;

export function searchNative(query: {
  q?: string;
  category?: string;
  maxPrice?: number;
  inStock?: boolean;
  limit?: number;
}): ProductView[] {
  const db = getDb();
  const at = now().toISOString();
  const clauses = [sellerVisibleSql()];
  const params: (string | number)[] = [at];
  if (query.q?.trim()) {
    const like = `%${query.q.trim().toLowerCase()}%`;
    clauses.push("(lower(p.title) LIKE ? OR lower(p.description) LIKE ? OR lower(p.category) LIKE ? OR lower(s.name) LIKE ?)");
    params.push(like, like, like, like);
  }
  if (query.category) {
    clauses.push("p.category = ?");
    params.push(query.category);
  }
  if (query.maxPrice != null) {
    clauses.push("o.price_cents <= ?");
    params.push(query.maxPrice);
  }
  if (query.inStock !== false) clauses.push(`(o.stock - ${heldSql()}) > 0`);
  if (query.inStock !== false) params.push(at);
  const limit = Math.min(Math.max(query.limit ?? 10, 1), 20);
  const rows = many<SearchRow>(db, `${SELECT} WHERE ${clauses.join(" AND ")} ORDER BY p.title LIMIT ?`, ...params, limit);
  return toProduct(rows);
}

export function getNativeProduct(productId: string): ProductView | undefined {
  const at = now().toISOString();
  const rows = many<SearchRow>(getDb(), `${SELECT} WHERE p.id = ? AND ${sellerVisibleSql()}`, at, productId);
  return toProduct(rows)[0];
}

export function categoryLabels() {
  return [
    { slug: "home-improvement", label: "Home improvement", secondary: false },
    { slug: "tools", label: "Tools", secondary: false },
    { slug: "electronics-accessories", label: "Electronics accessories", secondary: false },
    { slug: "outdoor", label: "Camping & outdoor", secondary: true },
  ];
}

export function brandSnapshot() {
  const cfg = config();
  return {
    name: cfg.brandName,
    handle: cfg.brandHandle,
    domain: cfg.brandDomain,
    fee_bps: cfg.platformFeeBps,
    contact: { name: cfg.contactName, role: cfg.contactRole, email: cfg.contactEmail },
    website_url: cfg.websiteUrl || null,
  };
}
