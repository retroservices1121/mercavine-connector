import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { listSellerConnections } from "@/lib/amazon-mcf";
import { sellerUserFromSessionToken } from "@/lib/auth";
import { ADMIN_COOKIE, adminTokenMatches } from "@/lib/admin-auth";
import { config } from "@/lib/config";
import { SellerConnect } from "./seller-connect";

export const dynamic = "force-dynamic";

export default async function SellersPage() {
  const jar = await cookies();
  const user = sellerUserFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/sellers");
  const cfg = config();
  const isAdmin = adminTokenMatches(jar.get(ADMIN_COOKIE)?.value);
  // Only the signed-in user's own seller(s); the full list is admin-only (mv_admin cookie from /admin/store).
  const sellers = listSellerConnections(isAdmin ? { all: true } : { userId: user.id });
  if (!sellers.length && !isAdmin) redirect("/sell");
  return (
    <main>
      <SiteHeader signedIn seller />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="text-4xl">Amazon seller accounts</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Already sell on Amazon? Connect your Amazon seller account and we can ship your orders from the stock you keep there.
        </p>
        {!cfg.amazonMcfEnabled ? (
          <p className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3 text-sm">Amazon shipping is coming soon.</p>
        ) : null}
        <ul className="mt-6 space-y-3">
          {sellers.map((seller) => (
            <li key={seller.seller_id} className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
              <h2 className="text-2xl">{seller.seller_name}</h2>
              <p className="mt-1 text-sm text-[var(--muted)]">
                {seller.connected ? `Connected${seller.selling_partner_id ? ` · ${seller.selling_partner_id}` : ""}` : "Not connected"}
                {" · "}
                {seller.prime_enrolled ? "Prime delivery badge on" : "Prime delivery badge off"}
                {" · "}
                {seller.marketplace_id}
              </p>
              <SellerConnect
                sellerId={seller.seller_id}
                connected={seller.connected}
                primeEnrolled={seller.prime_enrolled}
                disabled={!cfg.amazonMcfEnabled}
                devTools={isAdmin && cfg.devTools && cfg.amazonMcfEnabled}
              />
            </li>
          ))}
        </ul>
        <Link href="/seller" className="mt-6 inline-flex h-11 items-center rounded-full bg-[var(--vine)] px-6 text-[#f4efe4]">Back to seller dashboard</Link>
      </section>
    </main>
  );
}
