# Draft — not sent

To: Shopify support / Catalog and UCP access
From: Joe Perez, CEO, Mercavine
Email: mercavine-outreach@mail.grokbot.com

Subject: Request complete_checkout permission for the Mercavine agent connector

Hello,

I run Mercavine, a bot-first shopping connector for Grok and Cursor. Shoppers' agents search a catalog and build a cart. The human approves before any charge. We are not asking to skip that review.

Today Mercavine can speak to Shopify Catalog (`https://catalog.shopify.com/api/ucp/mcp`) only when we turn `SHOPIFY_CATALOG_ENABLED` on. Checkout is a handoff: we return the merchant `continue_url` and the buyer pays on the merchant's site. We do not call `complete_checkout`.

Please grant Mercavine permission to use in-bot `complete_checkout` for Catalog listings in these categories: home improvement, tools, and electronics accessories, with camping and outdoor as a secondary lane. Until that permission is on the account, our server keeps `SHOPIFY_IN_BOT_CHECKOUT` defaulted off and answers `shopify_permission_pending` if the flag is enabled without the grant. We will not bypass the buyer's review step.

The connector is free to users. Our own sellers, separate from Shopify, pay a 3% application fee via Stripe Connect direct charges. That fee does not apply to Shopify handoff orders.

There is no public website yet. mercavine.com is the intended domain and has not been purchased. Please reply to mercavine-outreach@mail.grokbot.com.

Thank you,
Joe Perez
CEO, Mercavine
