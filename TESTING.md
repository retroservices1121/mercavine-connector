# Testing Mercavine

The connector is free. Sellers pay the platform fee. The default is **3%** (`PLATFORM_FEE_BPS=300`), taken as Stripe `application_fee_amount` from each seller charge. It is not added to the shopper total. A $100.00 charge carries a **$3.00** fee.

Payments run in **mock mode** when `STRIPE_SECRET_KEY` is unset or does not start with `sk_`. No card is required.

## Accounts

| Who | Credential |
| --- | --- |
| Shopper | `jp@mercavine.test` / value of `MERCAVINE_DEV_PASSWORD` (random per process if unset; demo seed is off in production unless `MERCAVINE_SEED_DEMO=1`) (Jordan Pike) |
| Other shopper (foreign-link check) | `sam@mercavine.test` / same as above |
| Bot token | `mv_test_jp_9f3c1a7b` |
| Bot id | `bot_grok_jp` |

Addresses on the test shopper: `adr_home` (Jacksonville, FL) and `adr_shop` (Blue Ridge, GA).

Useful offers: `ofr_brass_hinge` ($24.00, Hinge & Timber), `ofr_tape` ($22.00, Benchline), `ofr_wrench_set` (stock 1), `ofr_drill_kit` ($149.00, above the $100 approval threshold).

## Automated

```bash
npm test
```

Vitest covers search through paid orders, the 3% fee on the two-seller fixture (Hinge & Timber $25.80 charge / $0.77 fee, Benchline $23.65 / $0.71, Florida 7.5% estimate), idempotency, decline, a declined seller that voids the other authorization, price and stock conflicts, a foreign viewer, expiry, bot revoke, Shopify handoff, webhook signatures, HTTP, and one MCP `tools/call`.

Shop Pay tests (`tests/shop-pay.test.ts`, `tests/shop-catalog.test.ts`, `tests/money.test.ts`) cover the flag defaulting off, mock Sign in with Shop without an access token, unavailable catalog lines, a paid Shop Pay order with `application_fee_cents` 0 and `payment_provider` `shop_pay`, no card number in the bot payload or `shop_pay_requests`, and a native cart in the same file that still charges 3%. `platformFeeCents("shop_pay", 10000, 300)` is 0. Shop catalog tests require a fresh fetch per search and do not request merchant image URLs.

Amazon MCF tests (`tests/amazon-mcf.test.ts`) run in mock mode. The flag defaults off, so connect returns 403 and `prime_delivery` stays false. With the flag on, connect stores a refresh token that is absent from the public JSON. A paid two-seller cart fulfills only the FBA brass hinge, copies Amazon Logistics tracking onto `get_order_status`, and still records a 77 cent fee on the hinge and 71 cents on the tape. The mock path does not call `fetch`. Live mode with credentials records `signing_unavailable` and also does not call `fetch`. The LWA code exchange is covered with a mocked token response. See [docs/amazon-mcf.md](docs/amazon-mcf.md) for developer registration, the Amazon Fulfillment and Inventory and Order Tracking roles, and the SigV4 gap.

`tests/shopify-placement.test.ts` checks that `shclid` and `shcgid` survive normalization, `get_product`, and the handoff `continue_url` without being stripped or rebuilt. Promoted variants are labeled `Sponsored` from `placement.type`. The commission rate is absent from those payloads. An unauthorized catalog message stays `organic_only` with the products still returned. `SHOPIFY_CATALOG_ID` is sent as `catalog.catalog_id` only when it is set.

## Manual path

1. `npm run dev` and open http://127.0.0.1:4317.
2. Search:

```bash
curl -s -H "Authorization: Bearer mv_test_jp_9f3c1a7b" \
  "http://127.0.0.1:4317/api/v1/products/search?q=hinge"
```

3. Create a cart (new Idempotency-Key each time you change the body):

```bash
curl -s -X POST http://127.0.0.1:4317/api/v1/carts \
  -H "Authorization: Bearer mv_test_jp_9f3c1a7b" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: demo-cart-0001" \
  -d '{"lines":[{"offer_id":"ofr_brass_hinge","quantity":1},{"offer_id":"ofr_tape","quantity":1}],"shipping_address_id":"adr_home"}'
```

4. Submit `POST /api/v1/carts/{id}/submit` with a new idempotency key and `{}`. The JSON includes `approval_url`. The raw token is not stored; only its SHA-256 is.
5. Open that URL. Sign in as `jp@mercavine.test`. Confirm two seller blocks, the total, and the 3% seller fees. Click **Approve & pay**. Without a passkey this is the dev step-up (`MERCAVINE_ALLOW_DEV_STEP_UP` is true unless set to `false`).
6. The page becomes a receipt. `GET /api/v1/orders/{id}` with the bot token returns `payment_status: "paid"` and no Stripe id, last4, or street address.
7. Decline path: submit another cart and choose **Decline**. Stock reservations release.
8. Mock decline of one seller: on the approval page, pick a seller in the test dropdown, then approve. That cart returns to waiting for approval and no order is created.
9. Sign in as `sam@mercavine.test` and open JP's link. The page says the request belongs to another account and shows no items.
10. MCP is `POST http://127.0.0.1:4317/mcp` with `Accept: application/json, text/event-stream` and the same bearer token. Tools: `search_products`, `get_product`, `create_cart`, `update_cart`, `get_cart`, `request_checkout`, `cancel_cart`, `connect_shop_pay`, `shop_pay_status`, `list_orders`, `get_order_status`, `cancel_order`, `request_return`.
11. Shop Pay mock, with the dev server started under `SHOP_PAY_ENABLED=true` (leave `SHOP_ACCESS_TOKEN` unset):

```bash
curl -s -X POST http://127.0.0.1:4317/api/v1/carts \
  -H "Authorization: Bearer mv_test_jp_9f3c1a7b" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: shop-pay-demo-1" \
  -d '{"lines":[{"provider":"shop","external_id":"shop:demo-hinge","title":"Solid brass hinge","seller_name":"Hinge Co","unit_price":2400,"quantity":1,"continue_url":"https://merchant.example/checkout"}],"shipping_address_id":"adr_home"}'
```

Submit that cart, open the approval URL, and choose **Approve for Shop Pay**. The receipt copy says the 3% fee does not apply. Continue to `/shop-pay/mock/<id>` and approve there. The order is `shop_pay` with a $0.00 platform fee. Sign in with Shop from `/account` first if you want the linked state; mock mode does not require it to finish checkout. Shop search is `lane=shop` on `search_products`. It calls Shop MCP live unless `SHOP_CATALOG_ENABLED=false`.

Passkeys: after sign-in, **Enroll a passkey** on `/account`. Later approvals prompt for it. Dev step-up is skipped once a passkey exists.

Contact for this listing: Mobi Media Inc. (operator of Mercavine), support@mercavine.com. Website: https://mercavine.com.

## Hosted review flow (https://mercavine.com)

The hosted site runs real Stripe in live mode. **Any card entered on an approval page is charged for real, so reviewers should stop at the approval page and not enter a card.** Nothing is charged, and no supplier order is created, unless a card is submitted. Even then, supplier (CJ) orders are held for an admin and run as a dry run (`CJ_ORDERS_LIVE` is off), so no real supplier order is placed. To exercise the full approve-and-pay path without any real money, use the local mock-mode path above (steps 1-6 of the manual path, `npm run dev`).

Reviewer steps, from a fresh account:

1. In Grok Bot (Connect apps) or Cursor (plugin install), add Mercavine. The client uses the server URL `https://mercavine.com/mcp`, receives a `401` with OAuth metadata, registers itself, and opens the Mercavine sign-in page.
2. Sign in, or create a shopper account at https://mercavine.com/signup (any email you control, password of at least 10 characters). Open the verification link emailed to you; checkout returns `email_unverified` until you do.
3. Add a shipping address at https://mercavine.com/account/addresses (checkout returns `address_required` without one).
4. On the consent page, review the scopes (`shop`, `checkout`, `track`) and approve. You are sent back to the client, which now holds an OAuth access token (1 hour, refreshed automatically).
5. Ask the bot to search, for example "search Mercavine for phone accessories" or "tools". It calls `search_products` and returns offers with prices, sellers and shipping.
6. Ask the bot to add one offer to a cart and request checkout. It calls `create_cart` and `request_checkout`, and returns a single-use approval link that is shown to you. The bot never asks for a card and cannot complete payment.
7. Open the approval link while signed in. Confirm it lists the item, the shipping address, tax and the total. Stop here. You can press **Decline**, which tells the bot and releases the reservation.
8. Back in the client, ask for the cart or order status (`get_cart`, `list_orders`, `get_order_status`). A declined cart reports `declined`. To undo access, revoke the connection in your client or at https://mercavine.com/account/bots.

A static-token alternative to OAuth: create a bot token at `/account/bots` and send it as `Authorization: Bearer <token>` to `https://mercavine.com/mcp`.
