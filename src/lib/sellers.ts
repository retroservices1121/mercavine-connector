import type { DatabaseSync } from "node:sqlite";
import { createUser, signupRateLimit } from "./accounts";
import { categoryLabels } from "./catalog";
import { nowIso } from "./clock";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { ApiError } from "./errors";
import { newId, randomToken } from "./ids";
import { many, one, run } from "./sql";

export { signupRateLimit as sellerSignupRateLimit };

export const SELLER_FEE_COPY = "Mercavine takes a simple 3% fee, only when you sell. Stripe's processing fees apply.";

export const US_STATES = [
  "AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE",
  "NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY",
];

export type SellerRow = {
  id: string;
  user_id: string | null;
  name: string;
  status: string;
  contact_name: string | null;
  contact_email: string | null;
  phone: string | null;
  website: string | null;
  category: string | null;
  description: string | null;
  ships_from_region: string;
  stripe_account_id: string;
  stripe_charges_enabled: number;
  stripe_payouts_enabled: number;
  stripe_details_submitted: number;
};

// ---------- Stripe (Express accounts + Account Links), injectable so tests never call Stripe ----------

export type StripeAccountState = { id: string; charges_enabled: boolean; payouts_enabled: boolean; details_submitted: boolean };
export type StripeOnboardingClient = {
  createExpressAccount(input: { email: string; businessName: string; sellerId: string }): Promise<{ id: string }>;
  createAccountLink(input: { account: string; refreshUrl: string; returnUrl: string }): Promise<{ url: string }>;
  retrieveAccount(id: string): Promise<StripeAccountState>;
  /** POST /v1/payment_method_domains on the connected account so Apple Pay / Google Pay / Link show for direct charges. */
  registerPaymentMethodDomain(input: { account: string; domain: string }): Promise<{ id: string }>;
};

let override: StripeOnboardingClient | null = null;
export function setStripeOnboardingClient(client: StripeOnboardingClient | null) {
  override = client;
}

/** Mock mode (no STRIPE_SECRET_KEY): no network. The link returns straight to /seller and the account reads as enabled. */
function mockClient(): StripeOnboardingClient {
  return {
    async createExpressAccount() {
      return { id: `acct_mock_${randomToken(8).replace(/[^A-Za-z0-9]/g, "").slice(0, 12)}` };
    },
    async createAccountLink({ returnUrl }) {
      return { url: `${returnUrl}${returnUrl.includes("?") ? "&" : "?"}mock=1` };
    },
    async retrieveAccount(id) {
      return { id, charges_enabled: true, payouts_enabled: true, details_submitted: true };
    },
    async registerPaymentMethodDomain() {
      return { id: "pmd_mock" };
    },
  };
}

async function liveClient(key: string): Promise<StripeOnboardingClient> {
  const Stripe = (await import("stripe")).default;
  const stripe = new Stripe(key);
  return {
    async createExpressAccount({ email, businessName, sellerId }) {
      const account = await stripe.accounts.create({
        type: "express",
        country: "US",
        email,
        business_profile: { name: businessName },
        capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
        metadata: { mercavine_seller_id: sellerId },
      });
      return { id: account.id };
    },
    async createAccountLink({ account, refreshUrl, returnUrl }) {
      const link = await stripe.accountLinks.create({ account, refresh_url: refreshUrl, return_url: returnUrl, type: "account_onboarding" });
      return { url: link.url };
    },
    async retrieveAccount(id) {
      const a = await stripe.accounts.retrieve(id);
      return { id: a.id, charges_enabled: Boolean(a.charges_enabled), payouts_enabled: Boolean(a.payouts_enabled), details_submitted: Boolean(a.details_submitted) };
    },
    async registerPaymentMethodDomain({ account, domain }) {
      const pmd = await stripe.paymentMethodDomains.create({ domain_name: domain, enabled: true }, { stripeAccount: account });
      return { id: pmd.id };
    },
  };
}

async function stripeClient(): Promise<StripeOnboardingClient> {
  if (override) return override;
  const cfg = config();
  if (cfg.paymentMode === "mock") return mockClient();
  // Stripe mode: real client only. Fail closed if the key is missing.
  if (!cfg.stripeSecretKey) throw new ApiError(503, "payments_unavailable", "Payout setup is temporarily unavailable. Please try again later.");
  return liveClient(cfg.stripeSecretKey);
}

/** Wallet domains for direct charges are per connected account. Best effort and recorded once; never blocks onboarding. */
export function walletDomains(): string[] {
  const cfg = config();
  const set = new Set<string>();
  for (const raw of [cfg.publicBaseUrl, `https://${cfg.brandDomain}`, `https://www.${cfg.brandDomain}`]) {
    try {
      const host = new URL(raw).hostname;
      if (host && host !== "localhost" && !/^[\d.]+$/.test(host)) set.add(host);
    } catch {
      /* skip */
    }
  }
  return [...set];
}

async function ensurePaymentMethodDomain(client: StripeOnboardingClient, sellerId: string, account: string) {
  if (!account || account.startsWith("acct_mock")) return;
  const row = one<{ pm_domains: string | null }>(getDb(), `SELECT pm_domains FROM sellers WHERE id = ?`, sellerId);
  const done = new Set((row?.pm_domains ?? "").split(",").filter(Boolean));
  for (const domain of walletDomains()) {
    if (done.has(domain)) continue;
    try {
      await client.registerPaymentMethodDomain({ account, domain });
      done.add(domain);
    } catch {
      /* retried on the next refresh */
    }
  }
  run(getDb(), `UPDATE sellers SET pm_domains = ? WHERE id = ?`, [...done].join(","), sellerId);
}

// ---------- seller signup ----------

const URL_RE = /^https?:\/\/[^\s]+\.[^\s]+$/i;

function clean(value: unknown, max: number): string {
  return String(value ?? "").trim().slice(0, max);
}

function slugify(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "seller";
  return `${base}-${randomToken(4).replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 5)}`;
}

function validCategory(slug: string): boolean {
  return categoryLabels().some((c) => c.slug === slug);
}

export function sellerForUser(userId: string, db: DatabaseSync = getDb()): SellerRow | undefined {
  return one<SellerRow>(db, `SELECT * FROM sellers WHERE user_id = ? ORDER BY created_at LIMIT 1`, userId);
}

/**
 * Creates (or reuses) the user and a seller row linked to it with status 'onboarding'.
 * `signedInUserId` reuses the current account; otherwise email + password create one.
 */
export function createSellerAccount(input: Record<string, unknown>, signedInUserId?: string): { seller: SellerRow; userId: string; email: string; created: boolean } {
  const businessName = clean(input.business_name, 80);
  const contactName = clean(input.contact_name, 80);
  const phone = clean(input.phone, 30) || null;
  const website = clean(input.website, 200) || null;
  const category = clean(input.category, 40);
  const state = clean(input.state, 2).toUpperCase();
  const description = clean(input.description, 500);
  if (businessName.length < 2) throw new ApiError(422, "invalid_seller", "Enter your business name.");
  if (contactName.length < 2) throw new ApiError(422, "invalid_seller", "Enter a contact name.");
  if (!validCategory(category)) throw new ApiError(422, "invalid_seller", "Choose a product category.");
  if (!US_STATES.includes(state)) throw new ApiError(422, "invalid_seller", "Choose your state.");
  if (description.length < 10) throw new ApiError(422, "invalid_seller", "Tell shoppers a little about what you sell.");
  if (website && !URL_RE.test(website)) throw new ApiError(422, "invalid_seller", "Enter a full website address, like https://example.com.");
  if (phone && !/^[0-9+().\-\s]{7,30}$/.test(phone)) throw new ApiError(422, "invalid_seller", "Enter a valid phone number.");
  if (input.agree_terms !== true) throw new ApiError(422, "invalid_seller", "Please agree to the seller terms.");

  let userId = signedInUserId;
  let email: string;
  let created = false;
  if (userId) {
    const user = one<{ email: string }>(getDb(), `SELECT email FROM users WHERE id = ?`, userId);
    if (!user) throw new ApiError(401, "unauthorized", "Sign in again.");
    email = user.email;
  } else {
    const made = createUser({ email: input.contact_email, password: input.password, name: contactName });
    userId = made.id;
    email = made.email;
    created = true;
  }
  const uid = userId;
  const seller = transaction((db) => {
    // One seller per account. Generic message, same as sign-up.
    if (sellerForUser(uid, db)) throw new ApiError(422, "signup_failed", "Could not create a seller account with those details.");
    const id = newId("sel");
    run(
      db,
      `INSERT INTO sellers (
        id, name, slug, rating, rating_count, stripe_account_id, statement_descriptor, return_window_days, restocking_fee_pct,
        ships_from_city, ships_from_region, user_id, status, contact_name, contact_email, phone, website, category, description,
        terms_accepted_at, created_at
      ) VALUES (?, ?, ?, 0, 0, '', ?, 30, 0, '', ?, ?, 'onboarding', ?, ?, ?, ?, ?, ?, ?, ?)`,
      id, businessName, slugify(businessName),
      businessName.toUpperCase().replace(/[^A-Z0-9 .-]/g, "").slice(0, 22) || "MERCAVINE SELLER",
      state, uid, contactName, email, phone, website, category, description, nowIso(), nowIso(),
    );
    return one<SellerRow>(db, `SELECT * FROM sellers WHERE id = ?`, id)!;
  });
  return { seller, userId: uid, email, created };
}

export function requireSeller(userId: string): SellerRow {
  const seller = sellerForUser(userId);
  if (!seller) throw new ApiError(404, "not_a_seller", "This account doesn't have a seller profile yet.");
  return seller;
}

/** Seller-owned rows may only be changed by their owner. Legacy catalog sellers (no owner) keep prior behavior. */
export function assertSellerAccess(sellerId: string, userId: string) {
  const row = one<{ user_id: string | null }>(getDb(), `SELECT user_id FROM sellers WHERE id = ?`, sellerId);
  if (row?.user_id && row.user_id !== userId) throw new ApiError(404, "not_found", "Seller not found.");
}

// ---------- Stripe onboarding ----------

export async function startStripeOnboarding(userId: string): Promise<{ url: string }> {
  const seller = requireSeller(userId);
  const client = await stripeClient();
  let account = seller.stripe_account_id;
  // A mock account id from before the switch to live Stripe is discarded.
  if (account.startsWith("acct_mock") && config().paymentMode !== "mock") {
    account = "";
    run(getDb(), `UPDATE sellers SET stripe_account_id = '', stripe_charges_enabled = 0, stripe_payouts_enabled = 0, stripe_details_submitted = 0, status = 'onboarding' WHERE id = ?`, seller.id);
  }
  if (!account) {
    try {
      account = (await client.createExpressAccount({ email: seller.contact_email ?? "", businessName: seller.name, sellerId: seller.id })).id;
    } catch {
      throw new ApiError(502, "stripe_unavailable", "We couldn't reach Stripe. Please try again in a minute.");
    }
    run(getDb(), `UPDATE sellers SET stripe_account_id = ? WHERE id = ?`, account, seller.id);
  }
  await ensurePaymentMethodDomain(client, seller.id, account);
  const base = config().publicBaseUrl;
  try {
    return await client.createAccountLink({ account, refreshUrl: `${base}/seller?stripe=refresh`, returnUrl: `${base}/seller?stripe=return` });
  } catch {
    throw new ApiError(502, "stripe_unavailable", "We couldn't reach Stripe. Please try again in a minute.");
  }
}

/** Pulls charges/payouts state from Stripe and activates listings once charges are enabled. */
/** Applies an account state from Stripe (refresh or account.updated webhook). */
export function applyStripeAccountState(state: StripeAccountState): boolean {
  const row = one<{ id: string }>(getDb(), `SELECT id FROM sellers WHERE stripe_account_id = ? AND user_id IS NOT NULL`, state.id);
  if (!row) return false;
  run(
    getDb(),
    `UPDATE sellers SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ?, status = ? WHERE id = ?`,
    state.charges_enabled ? 1 : 0, state.payouts_enabled ? 1 : 0, state.details_submitted ? 1 : 0, state.charges_enabled ? "active" : "onboarding", row.id,
  );
  return true;
}

export async function refreshStripeStatus(userId: string): Promise<SellerRow> {
  const seller = requireSeller(userId);
  if (!seller.stripe_account_id) return seller;
  if (seller.stripe_account_id.startsWith("acct_mock") && config().paymentMode !== "mock") return seller;
  let state: StripeAccountState;
  try {
    state = await (await stripeClient()).retrieveAccount(seller.stripe_account_id);
  } catch {
    return seller;
  }
  const status = state.charges_enabled ? "active" : "onboarding";
  await ensurePaymentMethodDomain(await stripeClient(), seller.id, seller.stripe_account_id);
  run(
    getDb(),
    `UPDATE sellers SET stripe_charges_enabled = ?, stripe_payouts_enabled = ?, stripe_details_submitted = ?, status = ? WHERE id = ?`,
    state.charges_enabled ? 1 : 0, state.payouts_enabled ? 1 : 0, state.details_submitted ? 1 : 0, status, seller.id,
  );
  return requireSeller(userId);
}

// ---------- dashboard ----------

export type StripeCardState = "not_started" | "in_progress" | "pending_review" | "active";

export type SellerDashboard = {
  seller: { id: string; name: string; status: string; category: string | null; state: string };
  stripe: { connected: boolean; state: StripeCardState; charges_enabled: boolean; payouts_enabled: boolean };
  amazon: { connected: boolean };
  listings_visible: boolean;
  checklist: { key: string; label: string; done: boolean; optional?: boolean }[];
  products: SellerProduct[];
};

export function stripeCardState(s: Pick<SellerRow, "stripe_account_id" | "stripe_charges_enabled" | "stripe_details_submitted">): StripeCardState {
  if (!s.stripe_account_id) return "not_started";
  if (s.stripe_charges_enabled) return "active";
  if (s.stripe_details_submitted) return "pending_review";
  return "in_progress";
}

export function sellerDashboard(userId: string): SellerDashboard {
  const seller = requireSeller(userId);
  const db = getDb();
  const amazon = one<{ status: string }>(db, `SELECT status FROM amazon_seller_links WHERE seller_id = ?`, seller.id);
  const products = listSellerProducts(userId);
  const state = stripeCardState(seller);
  const visible = seller.status === "active" && seller.stripe_charges_enabled === 1;
  return {
    seller: { id: seller.id, name: seller.name, status: seller.status, category: seller.category, state: seller.ships_from_region },
    stripe: { connected: Boolean(seller.stripe_account_id), state, charges_enabled: seller.stripe_charges_enabled === 1, payouts_enabled: seller.stripe_payouts_enabled === 1 },
    amazon: { connected: amazon?.status === "connected" },
    listings_visible: visible,
    checklist: [
      { key: "profile", label: "Create your seller profile", done: true },
      { key: "stripe", label: "Set up payouts with Stripe", done: state === "active" },
      { key: "amazon", label: "Connect Amazon fulfillment", done: amazon?.status === "connected", optional: true },
      { key: "product", label: "Add your first product", done: products.length > 0 },
      { key: "live", label: "Go live to AI shoppers", done: visible && products.length > 0 },
    ],
    products,
  };
}

// ---------- products ----------

export type SellerProduct = {
  product_id: string;
  offer_id: string;
  title: string;
  description: string;
  category: string;
  price_cents: number;
  stock: number;
  image_url: string | null;
  fulfillment_type: FulfillmentType;
};

export type FulfillmentType = "physical" | "digital";

/** Defaults written to an offer for its fulfillment type. Digital: no shipping, instant, returns per seller. */
export function fulfillmentDefaults(type: FulfillmentType) {
  return type === "digital"
    ? { shipping_cents: 0, eta_min_days: 0, eta_max_days: 0, return_window_days: 0 }
    : { shipping_cents: 0, eta_min_days: 3, eta_max_days: 7, return_window_days: 30 };
}

function productInput(input: Record<string, unknown>) {
  const title = clean(input.title, 120);
  const description = clean(input.description, 2000);
  const category = clean(input.category, 40);
  const imageUrl = clean(input.image_url, 500) || null;
  const priceRaw = String(input.price ?? "").replace(/[$,\s]/g, "");
  const price = Math.round(Number(priceRaw) * 100);
  const stock = Number(input.stock);
  if (title.length < 2) throw new ApiError(422, "invalid_product", "Enter a product name.");
  if (description.length < 5) throw new ApiError(422, "invalid_product", "Add a short description.");
  if (!validCategory(category)) throw new ApiError(422, "invalid_product", "Choose a category.");
  if (!priceRaw || !Number.isFinite(price) || price < 50 || price > 10_000_000) throw new ApiError(422, "invalid_product", "Enter a price between $0.50 and $100,000.");
  if (!Number.isInteger(stock) || stock < 0 || stock > 1_000_000) throw new ApiError(422, "invalid_product", "Enter how many you have in stock.");
  if (imageUrl && !/^https:\/\/[^\s]+$/i.test(imageUrl)) throw new ApiError(422, "invalid_product", "Image links must start with https://.");
  const rawType = input.fulfillment_type ?? "physical";
  if (rawType !== "physical" && rawType !== "digital") throw new ApiError(422, "invalid_product", "Fulfillment type must be physical or digital.");
  const fulfillmentType = rawType as FulfillmentType;
  return { title, description, category, imageUrl, price, stock, fulfillmentType };
}

export function listSellerProducts(userId: string): SellerProduct[] {
  const seller = requireSeller(userId);
  return many<SellerProduct>(
    getDb(),
    `SELECT p.id AS product_id, o.id AS offer_id, p.title, p.description, p.category, o.price_cents, o.stock, p.image_url, o.fulfillment_type
     FROM products p JOIN offers o ON o.product_id = p.id WHERE p.seller_id = ? ORDER BY p.created_at DESC`,
    seller.id,
  ).map((row) => ({ ...row }));
}

export function createSellerProduct(userId: string, input: Record<string, unknown>): SellerProduct {
  const seller = requireSeller(userId);
  const v = productInput(input);
  const d = fulfillmentDefaults(v.fulfillmentType);
  const productId = newId("prd");
  const offerId = newId("ofr");
  transaction((db) => {
    run(db, `INSERT INTO products (id, seller_id, title, description, category, created_at, image_url) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      productId, seller.id, v.title, v.description, v.category, nowIso(), v.imageUrl);
    run(
      db,
      `INSERT INTO offers (id, product_id, seller_id, sku, price_cents, stock, shipping_cents, eta_min_days, eta_max_days, return_window_days, fulfillment_type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      offerId, productId, seller.id, `MV-${offerId.slice(-8).toUpperCase()}`, v.price, v.stock,
      d.shipping_cents, d.eta_min_days, d.eta_max_days, d.return_window_days, v.fulfillmentType,
    );
  });
  return listSellerProducts(userId).find((p) => p.product_id === productId)!;
}

export function updateSellerProduct(userId: string, productId: string, input: Record<string, unknown>): SellerProduct {
  const seller = requireSeller(userId);
  const owned = one<{ id: string }>(getDb(), `SELECT id FROM products WHERE id = ? AND seller_id = ?`, productId, seller.id);
  // Same response whether it doesn't exist or belongs to someone else.
  if (!owned) throw new ApiError(404, "not_found", "Product not found.");
  const v = productInput(input);
  transaction((db) => {
    run(db, `UPDATE products SET title = ?, description = ?, category = ?, image_url = ? WHERE id = ? AND seller_id = ?`,
      v.title, v.description, v.category, v.imageUrl, productId, seller.id);
    const before = one<{ fulfillment_type: string }>(db, `SELECT fulfillment_type FROM offers WHERE product_id = ? AND seller_id = ?`, productId, seller.id);
    run(db, `UPDATE offers SET price_cents = ?, stock = ? WHERE product_id = ? AND seller_id = ?`, v.price, v.stock, productId, seller.id);
    if (input.fulfillment_type !== undefined && before?.fulfillment_type !== v.fulfillmentType) {
      const d = fulfillmentDefaults(v.fulfillmentType);
      run(db, `UPDATE offers SET fulfillment_type = ?, shipping_cents = ?, eta_min_days = ?, eta_max_days = ?, return_window_days = ? WHERE product_id = ? AND seller_id = ?`,
        v.fulfillmentType, d.shipping_cents, d.eta_min_days, d.eta_max_days, d.return_window_days, productId, seller.id);
    }
  });
  return listSellerProducts(userId).find((p) => p.product_id === productId)!;
}
