# Marketplace submission text (ready to paste)

For the form at https://x.ai/bot/marketplace/submit-a-plugin. **It has not been submitted.** Publisher Terms: https://cursor.com/marketplace-publisher-terms.

## Form fields

| Field | Value |
| --- | --- |
| Organization name | Mobi Media Inc. (Mercavine) |
| Organization handle | `mercavine` (availability not verifiable from outside; the form says handles must be unique) |
| Website URL | https://mercavine.com |
| Work email | support@mercavine.com |
| First and last name | Entered by the person submitting the form. Not stored in this repo. |
| Logotype URL | https://mercavine.com/logo-1024.png (1024x1024 PNG, 1:1, opaque green plate). Fallback: https://raw.githubusercontent.com/retroservices1121/mercavine-connector/main/assets/logo-1024.png |
| Where to list | Grok Bot and Cursor (Grok is marked "coming soon") |
| MCP server URL or public repo | https://mercavine.com/mcp (public repo: https://github.com/retroservices1121/mercavine-connector) |
| Privacy / Terms | https://mercavine.com/privacy, https://mercavine.com/terms |

## Brief description

Search the Mercavine catalog, build a cart, and get a single-use approval link so you can review and pay on a secure Mercavine page. Free for shoppers: Mercavine adds no fee to your total, and sellers pay a 3% fee on their own sales. The bot never sees your card and cannot complete payment.

## Testing instructions

The hosted site uses real Stripe in live mode, so please stop at the approval page and do not enter a card. Nothing is charged and no supplier order is created unless a card is submitted. Supplier orders are held for admin approval and run as a dry run, so no real order is placed.

1. In Grok Bot (Connect apps) or Cursor (install the plugin), add Mercavine. It points at `https://mercavine.com/mcp`. The server answers `401` with OAuth metadata, the client registers itself (dynamic client registration, PKCE S256), and the Mercavine sign-in page opens.
2. Sign in, or create a shopper account at https://mercavine.com/signup (any email you control, password of at least 10 characters). Open the verification link emailed to you. Checkout returns `email_unverified` until you do.
3. Add a shipping address at https://mercavine.com/account/addresses. Checkout returns `address_required` without one.
4. On the consent page, review the scopes (`shop`, `checkout`, `track`) and approve. You return to the client, which now holds a 1-hour access token that refreshes automatically.
5. Ask the bot: "Search Mercavine for phone accessories" (or "tools"). It calls `search_products` and lists offers with price, seller and shipping.
6. Ask the bot to add one offer to a cart and check out. It calls `create_cart` and `request_checkout`, then shows you a single-use approval link. It never asks for a card.
7. Open the approval link while signed in. Confirm the item, address, tax and total. Stop here. Press **Decline** if you like; the bot is told and the reservation is released.
8. Ask the bot for the cart or order status (`get_cart`, `list_orders`). A declined cart reports `declined`. Revoke access in your client or at https://mercavine.com/account/bots.

To try the full approve-and-pay flow with no real money, run the repo locally in mock payment mode: `npm install`, `cp .env.example .env.local`, `npm run dev`, then follow the manual path in [TESTING.md](../TESTING.md). `npm test` covers the checkout, OAuth and fee logic.

## Listing notes

- The connector is free to install and use. The 3% platform fee is charged to sellers on their own Stripe charge and is never added to a shopper's total. Shop Pay orders carry no Mercavine fee.
- Publisher Terms 3.1 (no charges to users for the plugin) is met because shoppers pay nothing to Mercavine for access; they pay only the seller's price for goods.
- Data: Mercavine handles shopper accounts, addresses, carts and orders as described at https://mercavine.com/privacy, which states that it does not sell personal information. Publisher Terms 6.3 also bars using plugin data to train AI models; the privacy page does not say this yet, so confirm it (and consider adding it) before submitting.
- Operator: Mobi Media Inc., a Florida corporation. Support: support@mercavine.com.
