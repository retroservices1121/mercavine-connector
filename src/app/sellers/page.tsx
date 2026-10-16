import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { listSellerConnections } from "@/lib/amazon-mcf";
import { userFromSessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { SellerConnect } from "./seller-connect";

export const dynamic = "force-dynamic";

export default async function SellersPage() {
  const jar = await cookies();
  const user = userFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/sellers");
  const cfg = config();
  const sellers = listSellerConnections();
  const fallback = cfg.amazonMcfLiveRequested && cfg.amazonMcfMode !== "live";
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="text-4xl">Amazon seller accounts</h1>
        <p className="mt-2 text-sm text-[var(--muted)]">
          Connect a seller so FBA listings can ship through Amazon Multi-Channel Fulfillment. Checkout stays on {cfg.brandName}, and the 3% fee stays on the seller charge. This page does not order on amazon.com.
        </p>
        {!cfg.amazonMcfEnabled ? (
          <p className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] px-4 py-3 text-sm">
            Amazon MCF is off. Set <span className="font-medium">AMAZON_MCF_ENABLED=true</span> to connect a seller. With the flag on and no live credentials, the server stays in mock mode.
          </p>
        ) : (
          <p className="mt-4 text-sm text-[var(--muted)]">
            Mode: {cfg.amazonMcfMode}.
            {cfg.amazonMcfMode === "mock"
              ? " Connect stores a refresh token on this server and does not open Amazon."
              : " Connect continues to Seller Central so the seller can approve the app."}
          </p>
        )}
        {fallback ? (
          <p className="mt-3 text-sm">
            Live mode was requested, but the LWA client id, client secret, or application id is missing, so this server is using mock mode.
          </p>
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
                devTools={cfg.devTools && cfg.amazonMcfEnabled}
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
