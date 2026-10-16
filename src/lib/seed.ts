import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { DEV_BOT_PUBLIC_KEY, DEV_BOT_TOKEN, DEV_OTHER_SHOPPER, DEV_SHOPPER } from "./dev-keys";
import { sha256 } from "./ids";
import { hashPassword } from "./password";

type Seller = {
  id: string;
  name: string;
  slug: string;
  rating: number;
  ratingCount: number;
  stripeAccountId: string;
  statement: string;
  returns: number;
  city: string;
  region: string;
};

type Item = {
  sellerId: string;
  productId: string;
  offerId: string;
  sku: string;
  title: string;
  description: string;
  category: string;
  variant: string;
  price: number;
  stock: number;
  shipping: number;
  eta: [number, number];
  returns: number;
};

const SELLERS: Seller[] = [
  {
    id: "sel_hinge",
    name: "Hinge & Timber",
    slug: "hinge-and-timber",
    rating: 4.8,
    ratingCount: 126,
    stripeAccountId: "acct_mock_hinge",
    statement: "HINGE AND TIMBER",
    returns: 30,
    city: "Savannah",
    region: "GA",
  },
  {
    id: "sel_bench",
    name: "Benchline Toolworks",
    slug: "benchline-toolworks",
    rating: 4.7,
    ratingCount: 89,
    stripeAccountId: "acct_mock_bench",
    statement: "BENCHLINE TOOLS",
    returns: 30,
    city: "Dayton",
    region: "OH",
  },
  {
    id: "sel_north",
    name: "Northline Circuit",
    slug: "northline-circuit",
    rating: 4.6,
    ratingCount: 204,
    stripeAccountId: "acct_mock_north",
    statement: "NORTHLINE CIRCUIT",
    returns: 30,
    city: "Austin",
    region: "TX",
  },
  {
    id: "sel_ridge",
    name: "Ridge Lantern Co.",
    slug: "ridge-lantern",
    rating: 4.9,
    ratingCount: 57,
    stripeAccountId: "acct_mock_ridge",
    statement: "RIDGE LANTERN",
    returns: 30,
    city: "Bend",
    region: "OR",
  },
];

const ITEMS: Item[] = [
  {
    sellerId: "sel_hinge",
    productId: "prd_brass_hinge",
    offerId: "ofr_brass_hinge",
    sku: "HT-HNG-35-6",
    title: "Solid brass door hinges, 3.5 inch, 6-pack",
    description:
      "Ball-bearing hinges with a squared corner and a satin brass finish. A six-pack covers three interior doors.",
    category: "home-improvement",
    variant: "Satin brass",
    price: 2400,
    stock: 40,
    shipping: 0,
    eta: [3, 5],
    returns: 30,
  },
  {
    sellerId: "sel_hinge",
    productId: "prd_mineral_wool",
    offerId: "ofr_mineral_wool",
    sku: "HT-MW-R15-8",
    title: "Mineral wool insulation batts, R-15, 8-pack",
    description:
      "Unfaced stone-wool batts for 2x4 walls. They hold shape when cut and do not itch the way fiberglass does.",
    category: "home-improvement",
    variant: "R-15, unfaced",
    price: 6800,
    stock: 15,
    shipping: 1200,
    eta: [4, 7],
    returns: 30,
  },
  {
    sellerId: "sel_hinge",
    productId: "prd_wood_stain",
    offerId: "ofr_wood_stain",
    sku: "HT-STN-CDR-1",
    title: "Exterior wood stain, cedar, 1 gallon",
    description:
      "Oil-based stain for decks, fences, and siding. One gallon covers about 150 square feet on bare cedar.",
    category: "home-improvement",
    variant: "Cedar",
    price: 4200,
    stock: 22,
    shipping: 800,
    eta: [3, 6],
    returns: 30,
  },
  {
    sellerId: "sel_hinge",
    productId: "prd_recessed_led",
    offerId: "ofr_recessed_led",
    sku: "HT-LED-6-4",
    title: "LED recessed retrofit kit, 6 inch, 4-pack",
    description:
      "Canless-style retrofit trims that screw into existing 6-inch housings. 2700K, dimmable, IC rated.",
    category: "home-improvement",
    variant: "2700K",
    price: 5400,
    stock: 18,
    shipping: 0,
    eta: [3, 5],
    returns: 30,
  },
  {
    sellerId: "sel_bench",
    productId: "prd_drill_kit",
    offerId: "ofr_drill_kit",
    sku: "BL-DRL-18-2",
    title: "18V brushless drill/driver kit",
    description:
      "Brushless drill with two 2.0Ah batteries, a charger, and a belt clip. The clutch has 18 settings plus drill mode.",
    category: "tools",
    variant: "Kit with 2 batteries",
    price: 14900,
    stock: 8,
    shipping: 0,
    eta: [2, 4],
    returns: 30,
  },
  {
    sellerId: "sel_bench",
    productId: "prd_tape",
    offerId: "ofr_tape",
    sku: "BL-TAPE-25",
    title: "25 ft magnetic tape measure",
    description:
      "A 25-foot blade with a magnetic hook and a nylon coat that stands out about 8 feet. The case is overmolded.",
    category: "tools",
    variant: "25 ft",
    price: 2200,
    stock: 50,
    shipping: 0,
    eta: [2, 4],
    returns: 30,
  },
  {
    sellerId: "sel_bench",
    productId: "prd_bit_set",
    offerId: "ofr_bit_set",
    sku: "BL-BIT-40",
    title: "Torx and hex driver bit set, 40 piece",
    description:
      "S2 steel bits in a hinged case: Torx T10–T40 and metric plus SAE hex. Includes a magnetic bit holder.",
    category: "tools",
    variant: "40 piece",
    price: 1850,
    stock: 30,
    shipping: 0,
    eta: [2, 4],
    returns: 30,
  },
  {
    sellerId: "sel_bench",
    productId: "prd_wrench_set",
    offerId: "ofr_wrench_set",
    sku: "BL-WR-3",
    title: "Adjustable wrench set, 3 piece",
    description:
      "6, 8, and 10 inch chrome-vanadium adjustable wrenches with a laser-etched scale. Stock is intentionally thin for tests.",
    category: "tools",
    variant: "6 / 8 / 10 in",
    price: 3600,
    stock: 1,
    shipping: 0,
    eta: [2, 5],
    returns: 30,
  },
  {
    sellerId: "sel_north",
    productId: "prd_gan_charger",
    offerId: "ofr_gan_charger",
    sku: "NC-GAN-100",
    title: "USB-C 100W GaN charger, 3 port",
    description:
      "A compact gallium-nitride brick with two USB-C ports and one USB-A port. 100W on USB-C1, shared when all three are used.",
    category: "electronics-accessories",
    variant: "Black",
    price: 4800,
    stock: 25,
    shipping: 0,
    eta: [2, 4],
    returns: 30,
  },
  {
    sellerId: "sel_north",
    productId: "prd_usbc_cable",
    offerId: "ofr_usbc_cable",
    sku: "NC-CBL-6-2",
    title: "Braided USB-C cable, 6 ft, 2-pack",
    description:
      "240W-rated braided cables with an aluminum shell. Two 6-foot cables, USB-IF color on the inner mold.",
    category: "electronics-accessories",
    variant: "6 ft, 2-pack",
    price: 1600,
    stock: 80,
    shipping: 0,
    eta: [2, 4],
    returns: 30,
  },
  {
    sellerId: "sel_north",
    productId: "prd_battery",
    offerId: "ofr_battery",
    sku: "NC-PWR-10",
    title: "10,000 mAh magnetic battery",
    description:
      "A slim pack with a magnetic ring for phones that support it, plus a USB-C port for everything else. 20W output.",
    category: "electronics-accessories",
    variant: "10,000 mAh",
    price: 3900,
    stock: 20,
    shipping: 500,
    eta: [3, 5],
    returns: 30,
  },
  {
    sellerId: "sel_north",
    productId: "prd_cable_tray",
    offerId: "ofr_cable_tray",
    sku: "NC-TRAY-16",
    title: "Under-desk cable tray, 16 inch",
    description:
      "A powder-coated steel tray that clamps to the back of a desk and hides a power strip. Mounting hardware is in the box.",
    category: "electronics-accessories",
    variant: "16 in, black",
    price: 2800,
    stock: 12,
    shipping: 700,
    eta: [3, 6],
    returns: 30,
  },
  {
    sellerId: "sel_ridge",
    productId: "prd_tent",
    offerId: "ofr_tent",
    sku: "RL-TENT-2",
    title: "Two-person backpacking tent",
    description:
      "A freestanding two-person tent with a full-coverage rainfly. Trail weight is about 3.4 lb. Secondary outdoor listing.",
    category: "outdoor",
    variant: "2-person",
    price: 18900,
    stock: 6,
    shipping: 0,
    eta: [4, 7],
    returns: 30,
  },
  {
    sellerId: "sel_ridge",
    productId: "prd_stove",
    offerId: "ofr_stove",
    sku: "RL-STV-1",
    title: "Compact canister camp stove",
    description:
      "A folding stove for screw-on isobutane canisters. Piezo igniter, simmer control, and a pot support that packs flat.",
    category: "outdoor",
    variant: "Canister",
    price: 5400,
    stock: 11,
    shipping: 0,
    eta: [3, 6],
    returns: 30,
  },
];

export function seedIfEmpty(db: DatabaseSync): void {
  const existing = db.prepare("SELECT COUNT(*) AS n FROM sellers").get() as { n: number } | undefined;
  if (existing && existing.n > 0) return;
  const at = nowIso();
  const password = hashPassword(DEV_SHOPPER.password, "mercavine-dev-salt");

  const insertUser = db.prepare(
    `INSERT INTO users (id, email, name, display_name, password_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insertUser.run("usr_jp", DEV_SHOPPER.email, DEV_SHOPPER.name, DEV_SHOPPER.displayName, password, at);
  insertUser.run(
    "usr_sam",
    DEV_OTHER_SHOPPER.email,
    DEV_OTHER_SHOPPER.name,
    DEV_OTHER_SHOPPER.displayName,
    password,
    at,
  );

  const insertAddress = db.prepare(
    `INSERT INTO addresses (id, user_id, label, recipient, line1, line2, city, region, postal_code, country, is_default)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'US', ?)`,
  );
  insertAddress.run("adr_home", "usr_jp", "Home", "Jordan Pike", "18 Oak Street", null, "Jacksonville", "FL", "32202", 1);
  insertAddress.run("adr_shop", "usr_jp", "Shop", "Jordan Pike", "400 River Road", "Unit B", "Blue Ridge", "GA", "30513", 0);
  insertAddress.run("adr_sam", "usr_sam", "Home", "Sam Okonkwo", "9 King Street", null, "Charleston", "SC", "29401", 1);

  db.prepare(
    `INSERT INTO bots (
      id, user_id, name, token_hash, public_key_pem, scopes,
      per_order_limit_cents, per_day_limit_cents, per_month_limit_cents, approval_threshold_cents,
      allowed_categories, revoked_at, created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    "bot_grok_jp",
    "usr_jp",
    "JP's Grok Bot",
    sha256(DEV_BOT_TOKEN),
    DEV_BOT_PUBLIC_KEY,
    JSON.stringify(["search", "cart", "buy", "track", "returns", "addresses:read"]),
    25000,
    80000,
    200000,
    10000,
    JSON.stringify(["home-improvement", "tools", "electronics-accessories", "outdoor"]),
    at,
  );

  const insertSeller = db.prepare(
    `INSERT INTO sellers (
      id, name, slug, rating, rating_count, stripe_account_id, statement_descriptor,
      return_window_days, restocking_fee_pct, ships_from_city, ships_from_region
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
  );
  for (const seller of SELLERS) {
    insertSeller.run(
      seller.id,
      seller.name,
      seller.slug,
      seller.rating,
      seller.ratingCount,
      seller.stripeAccountId,
      seller.statement,
      seller.returns,
      seller.city,
      seller.region,
    );
  }

  const insertProduct = db.prepare(
    `INSERT INTO products (id, seller_id, title, description, category, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const insertOffer = db.prepare(
    `INSERT INTO offers (
      id, product_id, seller_id, sku, variant_label, price_cents, currency, stock, shipping_cents,
      eta_min_days, eta_max_days, lock_ttl_minutes, return_window_days, restocking_fee_pct
    ) VALUES (?, ?, ?, ?, ?, ?, 'usd', ?, ?, ?, ?, 30, ?, 0)`,
  );
  for (const item of ITEMS) {
    insertProduct.run(item.productId, item.sellerId, item.title, item.description, item.category, at);
    insertOffer.run(
      item.offerId,
      item.productId,
      item.sellerId,
      item.sku,
      item.variant,
      item.price,
      item.stock,
      item.shipping,
      item.eta[0],
      item.eta[1],
      item.returns,
    );
  }
  db.prepare(`UPDATE offers SET fba_backed = 1 WHERE id = 'ofr_brass_hinge'`).run();
}

export const LAUNCH_CATEGORIES = [
  { slug: "home-improvement", label: "Home improvement" },
  { slug: "tools", label: "Tools" },
  { slug: "electronics-accessories", label: "Electronics accessories" },
  { slug: "outdoor", label: "Camping & outdoor", secondary: true },
] as const;
