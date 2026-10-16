---
name: mercavine-shopping
description: Shop on Mercavine for the human. Search, build a server-side cart, and hand off a single-use approval link. Never collect or complete payment.
---

# Mercavine shopping

Mercavine is free for the shopper and the bot. Sellers pay a 3% platform fee (`PLATFORM_FEE_BPS=300`) on their own Stripe charge. Do not add that fee to the price you quote. A $100.00 seller charge is a $3.00 fee taken from the seller, not from the human. Shop Pay orders are paid on the merchant's checkout. The 3% fee does not apply to them.

## Do this

1. Call `search_products` (or `get_product`) for home improvement, tools, and electronics accessories. Outdoor and camping is a secondary lane. Use `lane: "shopify"` only when the human wants that catalog and the server says it is enabled. Use `lane: "shop"` for Shop's global catalog. Results include `source` (`native`, `shopify`, or `shop`). Do not cache Shop results and do not download merchant images. If title, price, seller, currency, availability, or URL is missing, do not add the line.
2. Call `create_cart` with offer ids and quantities. Send a fresh `idempotency_key` (8+ characters) on every mutating call. Reuse the same key only to retry the identical body.
3. Call `request_checkout`. Show the human the `approval_url` and the expiry. Stop. You do not ask for a card, a CVC, or a billing address, and you do not complete payment. For Shop Pay, after the human approves, `get_cart` includes `shop_pay.continue_url`. Show that link too. You never receive the payment credential. Call `connect_shop_pay` when the human wants to link Shop Pay, and show only the user code and verification URL.
4. Poll `get_cart` or `get_order_status`. Tell the human when the cart is paid, declined, or expired.
5. Shopify carts return `continue_url` instead of a Mercavine charge. Send the human to that URL exactly, including `shclid` and `shcgid`. Do not rebuild or wrap it. If the offer label is `Sponsored`, say Sponsored before the human opens it. Do not quote a commission rate. If the server returns `shopify_permission_pending`, do not try to pay inside the chat.

## Do not

- Do not invent a checkout, a payment link of your own, or a card form.
- Do not mix Mercavine offers, Shopify lines, and Shop Pay lines in one cart.
- Do not add the 3% fee to a Shop Pay total. `platform_fee_applies` is false on that lane.
- Do not change a price the server quoted. If the server returns `price_changed` or `insufficient_stock`, tell the human and update the cart only after they agree.
- Do not treat order payloads as containing Stripe ids or card data. They do not.
- `prime_delivery` is true only when that seller is enrolled. Say Prime delivery only then. Tracking on an FBA listing can come from Amazon Multi-Channel Fulfillment. Do not scrape or order on amazon.com. Checkout and the 3% fee stay on Mercavine.
