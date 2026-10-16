# Whop affiliate product source

MCP tools: `search_whop_products`, `get_whop_product` (scope `search`).

- Search: `GET https://api.whop.com/api/v1/products` **without `account_id`** searches the public marketplace (docs.whop.com → API reference → Products (beta) → List Products). Public reads work without auth; a bearer key is sent when set.
- Details: `GET /products/{id}` returns `variants[].purchase_url` and `global_affiliate_status`.
- Attribution: Whop affiliate links append `?a=<affiliate username>` (docs.whop.com/developer/guides/affiliates). We add it to the product page and `purchase_url`.
- Default: only products with `global_affiliate_status = enabled` are returned.
- Caching: 10 min in-memory. Rate limits: retries 429/5xx (honours Retry-After, max 2), then a short cooldown returning `whop_rate_limited`.
- No scraping of whop.com, no automated checkout, no Stripe, no platform fee. Every link carries the disclosure "Mercavine may earn a commission from purchases made through this link."

Env: `WHOP_API_KEY`, `WHOP_AFFILIATE_CODE` (your Whop username). If either is unset the tools return `configured: false`.
