# Shop Pay

Shop Pay is a separate checkout lane from Mercavine's Stripe direct charges and from the Shopify Catalog handoff. It uses [Shop MCP](https://shop.dev/) (`https://mcp.shop.com/`). The merchant does not install anything. Card details never land in Mercavine's database, logs, or bot payloads.

## Flags

| Variable | Default | Meaning |
| --- | --- | --- |
| `SHOP_PAY_ENABLED` | `false` | Shop Pay tools and checkout. Off returns `shop_pay_disabled`. |
| `SHOP_PAY_MODE` | empty | `mock` forces mock. `live` is live only when a buyer token or `SHOP_ACCESS_TOKEN` exists. Otherwise the runtime falls back to mock. |
| `SHOP_ACCESS_TOKEN` | empty | Optional buyer token for live spend requests. A linked shopper token is preferred and is not returned by the API. |
| `SHOP_CATALOG_ENABLED` | on, unless `false` | Shop global search inside `search_products` / `get_product`. |
| `SHOP_MCP_URL` | `https://mcp.shop.com/` | Shop MCP endpoint. |
| `SHOP_DEV_CLIENT_ID` / `SHOP_DEV_CLIENT_SECRET` | empty | Optional Dev Dashboard client-credentials for higher catalog limits. Exchanged on each catalog call. Not a product cache. |

`SHOP_PAY_ENABLED=true` with no token is mock mode. Mock still requires the shopper to approve on `/a/<token>` and then on `/shop-pay/mock/<id>`.

## Shopper flow

1. The shopper signs in with Shop (`connect_shop_pay` or **Sign in with Shop** on `/account`). The device code stays on the server and is cleared after the token exchange. The bot sees the user code and verification URL only.
2. The bot adds a `provider: "shop"` line. The server strips any client `verifiedByServer` flag. With the catalog on, it calls `get_product` and replaces title, seller, price, and checkout URL with the listing. Missing title, price, seller, currency, availability, or https URL, or `available: false`, returns `409 unavailable` and the line is not saved. With the catalog off (mock), the same fields are required on the request and must be https.
3. `request_checkout` returns a Mercavine approval URL. It does not charge Stripe and does not auto-approve.
4. The shopper approves on `/a/<token>`. That opens a Shop spend request (`create_spend_request`) or, in mock mode, a local continue URL.
5. The shopper approves in Shop Pay. `get_spend_request` can return a single-use credential. That object lives only in memory for one JSON POST to the merchant `https` checkout URL, then the number, CVV, and name are cleared. `complete_spend_request` reports success or a generic failure and never includes the credential.
6. The order is stored with `payment_provider = shop_pay` and `application_fee_cents = 0`.

A cart is one lane. Mixing Mercavine, Shopify, and Shop Pay lines returns `422 mixed_checkout_lanes`. Shop Pay is one merchant per cart.

## Fee

`platformFeeCents("shop_pay", amount, PLATFORM_FEE_BPS)` returns 0. Native and mock Stripe charges still use `applicationFee` (default 3%, so $100.00 carries a $3.00 fee). The approval page says the fee does not apply when `platform_fee_applies` is false. `assertShopPayFee` throws `fee_invariant` if a Shop Pay amount would be charged a fee.

## Search

`search_products` with `lane: "shop"` or `lane: "all"` calls `search_catalog`. `get_product` with an id starting `shop:` calls Shop `get_product`. Every result has `source: "shop" | "native" | "shopify"`. Default lane stays `native`, so existing bots do not call Shop unless they ask.

Shop MCP usage rules enforced here:

- No cache of catalog responses. Each search is a new HTTP call. `cached` is always false.
- Merchant images are the `https` URLs Shop returned. This server does not fetch or store the bytes.
- AI-inferred fields can be missing or wrong. Integers are minor units. Decimals are major units. Anything else becomes a missing field and the offer is not linkable.
- Availability on a search hit is not enough. The line is checked again before it is saved.

## What is stubbed

Live merchant completion posts JSON `{ "shop_pay_credential": ... }` to the https checkout URL from the verified line. A merchant that only accepts an HTML card form gets `merchant_checkout_failed`. The response body is not copied into the error. The credential is discarded. This server does not fill HTML forms and does not call Shopify `complete_checkout` for this lane.

Mock mode never contacts Shop and never stores a credential. The mock sign-in email is `shopper@shop.example` and the access token column stays null, so the runtime remains mock.
