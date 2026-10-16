# Amazon Multi-Channel Fulfillment

Sellers can connect an Amazon seller account so FBA-backed listings ship through Amazon's Fulfillment Outbound API. The shopper still checks out on Mercavine. The 3% Stripe fee is unchanged. Mercavine does not scrape amazon.com and does not place a retail order there.

`AMAZON_MCF_ENABLED` defaults to false. With the flag on, the server is in **mock** mode unless `AMAZON_MCF_MODE=live` and all three of `AMAZON_LWA_CLIENT_ID`, `AMAZON_LWA_CLIENT_SECRET`, and `AMAZON_SP_APP_ID` are set. If live is requested without those values, the server stays in mock and says so on `/sellers`.

## What works in mock

- `/sellers` lists seeded sellers. **Connect Amazon seller account** stores a refresh token for that seller without leaving the site.
- Public connect and status JSON include the selling partner id, marketplace, mode, and Prime enrollment. They do not include the refresh token.
- The seeded brass hinge (`ofr_brass_hinge`, Hinge & Timber) is FBA-backed. Cloth tape is not.
- After the seller is connected, a paid Mercavine order for that hinge creates a local fulfillment order: `getFulfillmentPreview` (Standard, 2–5 days), `createFulfillmentOrder`, and `getFulfillmentOrder`. Tracking (`Amazon Logistics`, a `TBA…` number) is copied onto the order so `get_order_status` returns it.
- Offers include `fulfillment` (`fba` or `merchant`) and `prime_delivery`. The badge is false unless the flag is on, the offer is FBA-backed, and `sellers.prime_enrolled` is 1. Dev tools can flip that column from `/sellers`. That switch is local. It does not call Amazon.
- A failure to build the fulfillment row does not void the payment or change `application_fee_cents`.

## What is stubbed for live

Login with Amazon, website authorization workflow:

1. Register as a developer in the [Solution Provider Portal](https://solutionproviderportal.amazon.com/) (Selling Partner API).
2. Create a seller app and note the LWA client id, LWA client secret, and application id.
3. Set the app's OAuth redirect URI to `{PUBLIC_BASE_URL}/amazon/callback`.
4. Request these roles and wait for Amazon to approve the app:
   - **Amazon Fulfillment** (Fulfillment Outbound: preview, create, and get fulfillment orders)
   - **Inventory and Order Tracking**
5. Draft apps use `version=beta` on the consent URL. Set `AMAZON_SP_APP_DRAFT=false` after the app is approved and published.
6. The seller opens Seller Central from `/sellers` and approves the app. Amazon redirects back with `spapi_oauth_code`, `state`, and `selling_partner_id`.
7. The callback exchanges the code at `https://api.amazon.com/auth/o2/token` (`grant_type=authorization_code`) and stores the refresh token on that seller. The token is not returned to the bot.

Until those credentials exist, leave the flag off or use mock mode. Sandbox host placeholder: `https://sandbox.sellingpartnerapi-na.amazon.com`. Production host, when you are approved: `https://sellingpartnerapi-na.amazon.com`. Default marketplace: `ATVPDKIKX0DER`.

**AWS SigV4 is not implemented.** SP-API calls also need an AWS access key, secret, and IAM role ARN. Live mode does not send `createFulfillmentOrder`, `getFulfillmentPreview`, or `getFulfillmentOrder`. The paid order is marked `signing_unavailable` and the Mercavine charge stays paid. There is no access token header and no signed request.

Prime enrollment is not read from Amazon. Set `prime_enrolled` only after you know the seller is enrolled.

Self-authorization (the seller authorizing their own draft app) is enough to develop. Other sellers require Amazon to approve the app and the roles above.

## Credential encryption at rest

Amazon LWA refresh tokens (and Shop access tokens / device codes) are encrypted
with AES-256-GCM before they are written to SQLite (`src/lib/token-crypto.ts`).

- Set `TOKEN_ENCRYPTION_KEY` to 32 random bytes: `openssl rand -base64 32`.
- Without the key, storing a new token fails closed with HTTP 503.
- On startup, any legacy plaintext tokens are encrypted in place.
- Losing the key makes stored tokens unreadable; sellers would need to reconnect.
  Keep a copy in a password manager, separate from database backups.
