# Marketplace submission draft

This folder is a filled-out draft for the xAI Grok Bot marketplace form (and the Cursor listing that shares the plugin). **It has not been submitted.**

Contact: Joe Perez, CEO, support@mercavine.com. Website: https://mercavine.com. Privacy: https://mercavine.com/privacy. Terms: https://mercavine.com/terms.

The logotype file is `logo.svg` (also served at `/logo.svg`). It is a 1:1 SVG on a green background plate.

MCP URL: `https://mercavine.com/mcp` (locally `http://127.0.0.1:4317/mcp`).

Auth: every MCP and bot API call sends `Authorization: Bearer <bot token>`. A shopper signs up at `/signup`, then creates a token at `/account/bots` (shown once, stored as SHA-256 only) and picks scopes:

| Scope group | API scopes | Allows |
| --- | --- | --- |
| shop | `search` | catalog search, product details |
| checkout | `cart`, `buy`, `addresses:read` | carts, submit for human approval, cancel |
| track | `track`, `returns` | `list_orders`, `get_order_status`, events, webhooks, returns |

Optional: register an Ed25519 public key on the bot to require signed requests.

Domain note: mercavine.com DNS CNAMEs to Railway. If the custom domain is not yet attached to the Railway service, use `https://mercavine-web-production.up.railway.app` until it is.

The platform fee in every field is 3% (`PLATFORM_FEE_BPS=300`). The connector is free.

`shopify-checkout-permission-request.md` is a draft to Shopify support. It has not been sent.
