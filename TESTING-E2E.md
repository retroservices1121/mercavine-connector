# Mercavine pre-submission E2E checklist

Run before submitting to the Grok Bot Marketplace. Automated part: `scripts/e2e.mjs` (fetch + MCP over HTTP, Node 22).

```bash
# Production, read-only (no accounts, carts, or charges are created)
E2E_BASE_URL=https://mercavine.com npx -y node@22 scripts/e2e.mjs

# Local build of main, full flow (creates test users/carts in a throwaway DB, mock payments)
npm ci && npx -y node@22 node_modules/.bin/next build
MERCAVINE_DB_PATH=/tmp/e2e/m.sqlite PAYMENT_MODE=mock npx -y node@22 node_modules/.bin/next start -p 4317 &
E2E_BASE_URL=http://127.0.0.1:4317 E2E_MODE=full E2E_DB_PATH=/tmp/e2e/m.sqlite npx -y node@22 --no-warnings scripts/e2e.mjs
rm -rf /tmp/e2e   # cleanup
```

Rules: never confirm a payment, never run full mode against production, never print secrets. `E2E_DB_PATH` is used only to mark the throwaway shopper verified. Sign-up is rate limited per IP, so restart the local server between full runs.

## Checklist

| # | Area | Check | How |
|---|------|-------|-----|
| 1 | Pages | `/`, `/signup`, `/login`, `/sell`, `/privacy`, `/terms`, `/forgot-password`, `/developers` return 200 | script |
| 2 | Pages | Homepage "Featured products" shows at least one priced product | script |
| 3 | Pages | Product detail pages | n/a: no product route; products are served by `get_product` |
| 4 | Health | `/api/health` reports `payment_mode`, `stripe_webhook`, `shop_pay` | script |
| 5 | Legal | `/terms` and `/privacy` contain no draft, placeholder, or "legal review" text | script |
| 6 | Legal | Privacy covers account deletion via privacy@mercavine.com, 30 days; terms state 18+ and Mobi Media Inc. | script |
| 7 | MCP | `tools/list` lists search_products, get_product, create_cart, request_checkout, get_order_status, list_orders | script |
| 8 | Search | MCP `search_products` and REST `/api/v1/products/search` reject a missing token and work with a bot token | script |
| 9 | Cart | create_cart, get_cart, cancel_cart (needs a verified shopper with an address) | script, full |
| 10 | Checkout | `request_checkout` returns a single-use `/a/<token>` approval URL that loads | script, full |
| 11 | Checkout | **PENDING**: real card form (card-form PR). Test up to PaymentIntent / Payment Link creation only; never confirm | manual after PR |
| 12 | Stripe | Webhook secret set (`stripe_webhook: true`); unsigned webhook rejected with 4xx | script |
| 13 | Orders | list_orders works; get_order_status on an unknown id errors | script, full |
| 14 | Shop Pay | Switch state from `/api/health`; `connect_shop_pay` returns `shop_pay_disabled` while off | script |
| 15 | Seller | `/api/v1/sellers/signup` → `/seller` dashboard → `stripe/onboard` returns a URL (not followed) | script, full |
| 16 | Auth | Sign-up returns 201 unverified; resend verification; bad verify/reset tokens rejected; forgot-password is generic | script, full |
| 17 | Auth | 18+ age gate in the sign-up UI and enforced by the API | script |
| 18 | Bots | Connect your bot (`POST /api/v1/bots`) returns a token once, and that token works on MCP | script, full |
| 19 | Account | Account deletion: privacy@mercavine.com forwards to the ops inbox; optional self-serve endpoint | manual + script |
| 20 | Email | privacy@ and support@ forwarders deliver to mercavine-outreach@mail.grokbot.com | manual: send from an outside test mailbox and check the inbox |
