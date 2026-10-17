# Mercavine seller/shopper separation: findings and plan (nothing has been run)

## Findings (from the code, read-only)
- **The CJ-supplied Mercavine Store seller (`sel_mercavine_store`) belongs to no user.** `ensureFirstPartySeller()` (src/lib/first-party.ts:39-45) inserts it with no `user_id`, no `contact_email`, `first_party=1` and `stripe_account_id='platform'`. Nothing in the code ever sets a `user_id` on it.
- **The store is controlled by config and the admin token, not by a user account.**
  - CJ sync, refresh and tracking, tax quotes and supplier orders all use the `FIRST_PARTY_SELLER_ID` constant (src/lib/cj-store.ts).
  - /admin/store and /api/v1/admin/* use `MERCAVINE_ADMIN_TOKEN` (src/lib/admin-auth.ts).
  - Visibility comes from `MERCAVINE_STORE_ENABLED`; charge routing comes from `MERCAVINE_STORE_STRIPE_ACCOUNT` (default: the platform account).
- **Shopper sign-up never creates a seller.** `createUser` only writes to `users`. A seller row gets a `user_id` only through the /sell form (`createSellerAccount`). Before PR A, that form reused the signed-in shopper account when the person was already signed in.
- **The sample sellers have no owner either.** `seedIfEmpty` (src/lib/seed.ts:364) adds the seeded sellers (Hinge & Timber, Benchline Toolworks, Northline Circuit, Ridge Lantern Co., …) with no `user_id`.
- **Why JP saw sellers on /sellers:** the page called `listSellerConnections()`, which ran `SELECT id FROM sellers` with no filter. Every signed-in shopper saw every seller, including the Mercavine Store and the samples, without being linked to any of them.
- **Amazon:** a row in `amazon_seller_links` exists only after someone clicks Connect on a specific seller. Nothing creates one for the store automatically.
- **Prod check not possible read-only.** No admin GET endpoint lists sellers or users, and I didn't SSH. The query to confirm is below.

## Read-only confirmation queries (to run later with read-only DB access)
```sql
SELECT id, name, user_id, contact_email, first_party, status FROM sellers ORDER BY created_at;
SELECT s.id, s.name, u.email FROM sellers s JOIN users u ON u.id = s.user_id;   -- expect 0 rows
SELECT id, email FROM users WHERE lower(trim(email)) = 'retroservices1121@gmail.com';
SELECT seller_id, status, selling_partner_id FROM amazon_seller_links;          -- expect 0 rows or demo rows only
SELECT COUNT(*) FROM products WHERE seller_id = 'sel_mercavine_store';
SELECT COUNT(*) FROM supplier_product_map;
SELECT status, COUNT(*) FROM orders WHERE seller_id = 'sel_mercavine_store' GROUP BY status;
SELECT status, COUNT(*) FROM supplier_orders GROUP BY status;
```

## Plan
- **If the second query returns 0 rows** (expected): no data moves. The fix is PR A only:
  - /sellers is scoped to the seller session's own seller (or admin), and shoppers are redirected to /sell.
  - Shopper and seller sessions are kept apart.
  - The store keeps running off its seller id and the admin token.
- **If JP wants a seller login for the store:** create a new seller-type user with a separate email, then set `sellers.user_id` on `sel_mercavine_store` to that user's id.
  - Backup first: take a fresh R2 backup and check that it decrypts.
  - Make the change as one transaction, then verify that /admin/store, `/api/v1/admin/jobs` and the catalog counts are unchanged.
  - Rollback: set `user_id` back to NULL, or restore the backup.
  - Effects: no downtime, listings stay live, in-flight orders and supplier orders are unaffected (they key off `seller_id`), and no Amazon re-auth is needed.
  - Because `sellerDashboard` would show the store's CJ products on /seller, this should be JP's call. Admin-only control may be enough.
- **If the query does return a self-serve seller tied to JP's shopper account:** use option (a) above. Create a new seller-type user with a new email, move `sellers.user_id` to it, and invalidate that seller's old sessions. Same backup, verification and rollback steps, plus an Amazon reconnect only if a link row exists.
