# Marketplace submission draft

This folder is a filled-out draft for the xAI Grok Bot marketplace form (and the Cursor listing that shares the plugin). **It has not been submitted.**

Operated by Mobi Media Inc. Contact: support@mercavine.com. Website: https://mercavine.com. Privacy: https://mercavine.com/privacy. Terms: https://mercavine.com/terms.

The logotype to submit is `assets/logo-1024.png` (also served at `https://mercavine.com/logo-1024.png`): a 1024x1024 PNG, 1:1, on a fully opaque green plate with no transparent corners. `assets/logo-square.svg` is the matching SVG. The older `logo.svg` has rounded, transparent corners.

MCP URL: `https://mercavine.com/mcp` (locally `http://127.0.0.1:4317/mcp`).

Auth: OAuth 2.1 (discovery, dynamic client registration, PKCE S256, consent page), so clients only need the server URL. A static bot token is also supported: a shopper signs up at `/signup`, then creates a token at `/account/bots` (shown once, stored as SHA-256 only) and sends it as `Authorization: Bearer <bot token>`. Scopes:

| Scope group | API scopes | Allows |
| --- | --- | --- |
| shop | `search` | catalog search, product details |
| checkout | `cart`, `buy`, `addresses:read` | carts, submit for human approval, cancel |
| track | `track`, `returns` | `list_orders`, `get_order_status`, events, webhooks, returns |

Optional: register an Ed25519 public key on the bot to require signed requests.

Domain note: mercavine.com DNS CNAMEs to Railway. If the custom domain is not yet attached to the Railway service, use `https://mercavine-web-production.up.railway.app` until it is.

The platform fee in every field is 3% (`PLATFORM_FEE_BPS=300`). The connector is free.

`shopify-checkout-permission-request.md` is a draft to Shopify support. It has not been sent.

The ready-to-paste form text is in [../docs/marketplace-submission.md](../docs/marketplace-submission.md).
