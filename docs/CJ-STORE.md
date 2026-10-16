# Mercavine Store (CJdropshipping, US warehouses)

The store is Mercavine's own first-party seller. CJdropshipping supplies the products and ships them from US warehouses.

## Environment
| Var | Default | Purpose |
|---|---|---|
| `MERCAVINE_STORE_ENABLED` | `false` | Shows Mercavine Store listings to shoppers. |
| `CJ_API_KEY` | (none) | CJ API key. The access token it's exchanged for is cached in `settings.cj_token`. |
| `CJ_MARGIN_BPS` | `2000` | Margin over CJ cost + freight (2000 = 20%). |
| `CJ_MIN_PRICE_CENTS` | `1500` | Minimum shopper price ($15). |
| `CJ_MIN_US_STOCK` | `5` | Items with less US stock than this aren't listed, and listed items are paused. |
| `CJ_REFERENCE_ZIP` | `27601` | Destination zip used for freight quotes during sync. |
| `CJ_CATEGORY_IDS` | tools/lighting/storage leaves | Comma-separated CJ category IDs to sync. |
| `CJ_EXCLUDE_KEYWORDS` | (none) | Extra comma-separated keywords to exclude. |
| `CJ_SYNC_MAX_PAGES` | `2` | Pages of 100 per category on each sync (50 points per page). |
| `CJ_DAILY_POINT_BUDGET` | `40000` | Hard cap. CJ allows 50,000 points/day. |
| `CJ_ORDERS_LIVE` | `false` | Leave false for dry-run: the createOrderV2 body is stored and never sent. |
| `MERCAVINE_STORE_STRIPE_ACCOUNT` | (none) | Set to an `acct_...` to route store charges to a Connect account. If unset, charges go to the platform account. Either way there's no application fee. |
| `MERCAVINE_ADMIN_TOKEN` | (none) | Bearer token for `/api/v1/admin/*` (24+ chars). If unset, the admin API returns 404. |

## Flow
1. `POST /api/v1/admin/cj/sync` with `{max_new}`: lists products with countryCode=US, filters out auto parts, brand names, keywords, and items with stock under 5, picks the cheapest US→US freight, and upserts listings.
2. `POST /api/v1/admin/cj/refresh`: re-reads cost and stock, reprices, or pauses items that fall below the stock floor.
3. Checkout: before a PaymentIntent exists, live CJ stock and price are re-checked. If stock is short (409 `insufficient_stock`) or the price went up (409 `price_changed`), nothing is charged.
4. Payment authorizes with manual capture. The cart is then held as a `supplier_orders` row with status `pending_approval`.
5. `POST /api/v1/admin/supplier-orders/:id/approve`: re-checks stock, captures, finalizes the order, then calls createOrderV2. In dry-run it only stores the request. The dedupe key is `mv-<cart_id>`, sent as the CJ `orderNumber`. Live orders use `payType=3`, which creates the CJ order without paying for it. Paying CJ is still manual.
6. `POST /api/v1/admin/supplier-orders/:id/reject`: voids the authorization.
7. `POST /api/v1/admin/cj/tracking`: polls getOrderDetail and marks orders shipped with the tracking number.

The returns policy is at `/returns`: resend or refund for damaged, defective, or wrong items reported within 30 days.
