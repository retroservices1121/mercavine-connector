# Mercavine

Bot-first marketplace connector. A shopper's agent searches the catalog and builds a server-side cart. The human opens one short-lived approval link and pays. Each seller is charged on their own Stripe connected account. Mercavine never holds the sale.

The connector is free. The platform fee is **3%** of each seller charge (`PLATFORM_FEE_BPS=300`), collected as Stripe `application_fee_amount` before the seller's payout. It is not added to the shopper total. A $100.00 charge carries a $3.00 fee.

Contact: Joe Perez, CEO, mercavine-outreach@mail.grokbot.com. Website: https://mercavine.com (MCP at https://mercavine.com/mcp, privacy at https://mercavine.com/privacy).

## Run

```bash
npm install
cp .env.example .env.local
npm run dev
```

App, REST API, and MCP server: http://127.0.0.1:4317

- Health: `GET /api/health`
- Bot API: `/api/v1/...` with `Authorization: Bearer <token>`
- Shopper accounts: `/signup` (`POST /api/v1/users`), addresses at `/account/addresses` (`/api/v1/addresses`), bot tokens at `/account/bots` (`POST /api/v1/bots`, scope groups `shop`, `checkout`, `track`)
- Email verification: sign-up emails a 24h single-use link to `/verify`. Checkout (bot cart create/submit and web approval) returns `email_unverified` until verified. Resend: `POST /api/v1/users/verify/resend`.
- Password reset: `/forgot-password` (`POST /api/v1/password/forgot`, always a generic 200) and `/reset-password` (`POST /api/v1/password/reset`, 1h single-use token; signs out all sessions; bot tokens stay active).
- Email delivery needs `RESEND_API_KEY` (from `no-reply@mercavine.com`, reply-to `privacy@mercavine.com`). Without it, production logs a warning and sends nothing.
- MCP: `POST /mcp` (streamable HTTP, stateless, JSON responses)
- Approval page: `/a/<token>`
- Seller Amazon connection: `/sellers` (off unless `AMAZON_MCF_ENABLED=true`)
- Terms: `/terms` · Privacy: `/privacy` · Logo: `/logo.svg`

```bash
npm test
npm run typecheck
```

Manual steps and the test account are in [TESTING.md](TESTING.md).

Production:

```bash
npm run build
npm start
```

`Dockerfile` runs the same build. Set `PUBLIC_BASE_URL` to the public origin so approval links and passkeys use it. SQLite is the local database (`MERCAVINE_DB_PATH`). Point that file at a volume. Postgres is the production target; the SQL is written to move, and it is not wired yet.

## What the bot can call

`search_products`, `get_product`, `create_cart`, `update_cart`, `get_cart`, `request_checkout`, `cancel_cart`, `connect_shop_pay`, `shop_pay_status`, `list_orders`, `get_order_status`, `cancel_order`, `request_return`.

`request_checkout` returns a single-use approval URL. The bot must show it to the human. The bot never collects a card and never completes payment. Mutating calls need an idempotency key of at least 8 characters. The same key and body replay. A different body returns `422 idempotency_key_reuse`.

## Decisions

1. Brand strings come from the environment (`BRAND_NAME`, `BRAND_HANDLE`, `BRAND_DOMAIN`, `BRAND_LEGAL_NAME`, `PUBLIC_BASE_URL`).
2. One Next.js process serves the site, `/api/v1`, and `/mcp`.
3. SQLite via `node:sqlite` for local development. Search is SQL `LIKE`, not a separate search service.
4. Mock payments unless `STRIPE_SECRET_KEY` starts with `sk_`. The Stripe path creates a direct charge on the seller's connected account (`capture_method: manual`, `application_fee_amount` = 3% of that PaymentIntent). Seeded accounts are `acct_mock_*`. Override with `STRIPE_ACCOUNT_SEL_HINGE` and the same pattern for other seller ids. Authorize every seller, then capture. A failure voids the authorizations already made.
5. Dev password login plus passkey enrollment. Approving without a passkey uses a dev step-up while `MERCAVINE_ALLOW_DEV_STEP_UP` is not `false`. Set that to `false` once passkeys are required.
6. Bot auth is a bearer token with scopes. A full OAuth 2.1 consent server is not in this build. The seeded token is the dev credential.
7. RFC 9421 covers `@method`, `@target-uri`, `content-digest`, and `idempotency-key`. Signatures are checked when present. They are required on every call only when `MERCAVINE_REQUIRE_SIGNATURES=true`.
8. Shopify Catalog is off unless `SHOPIFY_CATALOG_ENABLED=true`. Checkout is a `continue_url` handoff. `SHOPIFY_IN_BOT_CHECKOUT=true` still refuses `complete_checkout` with `shopify_permission_pending`. Mixed native, Shopify, and Shop Pay carts return `422 mixed_checkout_lanes`. `SHOPIFY_CATALOG_ID` is the saved catalog id from Dev Dashboard org 241084154 and stays unset until promoted placements are enabled. When set, `search_catalog` sends `catalog.catalog_id`. Each variant `url` is kept exactly, including `shclid` and `shcgid`, on search, `get_product`, and the handoff link. Promoted variants are labeled `Sponsored` from `placement.type`. The commission rate is not included in search results, `get_product`, or the handoff. The disclosure is “We may earn a commission on purchases.” A not-authorized catalog message returns organic variants and does not fail the search.
9. Shop's global catalog (`search_catalog` / `get_product` on `https://mcp.shop.com/`) is an extra search source, on unless `SHOP_CATALOG_ENABLED=false`. Pass `lane=shop` or `lane=all`. Results are labeled `source: "shop"`. No API key is required. `SHOP_DEV_CLIENT_ID` and `SHOP_DEV_CLIENT_SECRET` are optional Dev Dashboard credentials for higher limits and are exchanged per call. Shop results are not cached. Merchant images are source URLs only and are not downloaded or re-hosted. Missing or wrong inferred fields stay unlinkable, and availability is checked again before a line is added.
10. Shop Pay is off unless `SHOP_PAY_ENABLED=true`. With the flag on and no buyer token (and no `SHOP_ACCESS_TOKEN`), checkout is mock and still requires the shopper's approval. The shopper links Shop Pay with Sign in with Shop, approves on the Mercavine page, then approves in Shop Pay. The server may hold a single-use credential in memory for one https POST to the merchant checkout, then discards it. Card numbers are not stored, logged, or returned to the bot. That live POST is a JSON body. If the merchant expects an HTML card form, the attempt fails and the credential is dropped. Shopify `complete_checkout` is not used for this lane. Shop Pay orders are not Stripe charges: `platformFeeCents("shop_pay", …)` is 0, and the 3% fee does not apply. Details are in [docs/shop-pay.md](docs/shop-pay.md).
11. Tax is a flat estimate by US region (Florida 7.5%). It is not a tax engine. Shop Pay quotes tax at 0 because the merchant checkout is authoritative.
12. Webhooks use a Standard Webhooks-style signature (`webhook-id`, `webhook-timestamp`, `webhook-signature` v1, Ed25519). Public key: `/.well-known/mercavine-webhook-keys.json`. Delivery retries in-process and disables an endpoint after three days of failure. `memory:` URLs stay inside the process for tests.
13. Auto-approve rules can complete only in mock mode, and never for Shop Pay. In Stripe mode the cart still returns an approval link.
14. Email, SMS, and push are recorded as notices. They are not sent.
15. Amazon Multi-Channel Fulfillment is off unless `AMAZON_MCF_ENABLED=true`. With the flag on and no live LWA credentials, connect and fulfillment stay in mock mode. A connected seller with an FBA-backed listing (the seeded brass hinge) gets a local fulfillment order after Mercavine checkout. Tracking shows up on `get_order_status`. `prime_delivery` is false unless that seller is enrolled. The shopper still pays on Mercavine, and the 3% fee is unchanged. Live Login with Amazon is implemented. Live Fulfillment Outbound calls are not sent, because AWS SigV4 is not implemented. Mercavine does not scrape or order on amazon.com. Details are in [docs/amazon-mcf.md](docs/amazon-mcf.md).

Launch categories: home improvement, tools, electronics accessories. Camping and outdoor is seeded as a secondary lane.
