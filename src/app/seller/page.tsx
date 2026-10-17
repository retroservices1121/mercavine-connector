import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import { SellerConnect } from "@/app/sellers/seller-connect";
import { sellerUserFromSessionToken } from "@/lib/auth";
import { categoryLabels } from "@/lib/catalog";
import { config } from "@/lib/config";
import { SELLER_FEE_COPY, sellerDashboard, sellerForUser, type StripeCardState } from "@/lib/sellers";
import { ProductForm, ProductRow, StripeButton, StripeRefresher } from "./seller-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Seller dashboard" };

const stripeCopy: Record<StripeCardState, [string, string]> = {
  not_started: ["Not set up", "Set up payouts so shoppers can pay you."],
  in_progress: ["Setup started", "Finish a few details with Stripe to start getting paid."],
  pending_review: ["Under review", "Stripe is checking your details. This usually doesn't take long."],
  active: ["Ready", "You can accept payments."],
};

function Card({ title, status, good, children }: { title: string; status: string; good: boolean; children: React.ReactNode }) {
  return (
    <section className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
      <div className="flex items-center justify-between gap-2">
        <h2 className="display text-2xl">{title}</h2>
        <span className={`rounded-full px-3 py-1 text-xs ${good ? "bg-[var(--vine)] text-[#f4efe4]" : "bg-[#efe3cf] text-[var(--ink)]"}`}>{status}</span>
      </div>
      <div className="mt-3 space-y-3 text-sm text-[var(--muted)]">{children}</div>
    </section>
  );
}

export default async function SellerPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const jar = await cookies();
  const user = sellerUserFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login?next=/seller");
  if (!sellerForUser(user.id)) redirect("/sell");
  const params = await searchParams;
  const cfg = config();
  const d = sellerDashboard(user.id);
  const categories = categoryLabels().map(({ slug, label }) => ({ slug, label }));
  const [stripeStatus, stripeText] = stripeCopy[d.stripe.state];
  const shouldRefresh = d.stripe.connected && (d.stripe.state !== "active" || Boolean(params.stripe));
  return (
    <>
      <SiteHeader signedIn />
      <StripeRefresher enabled={shouldRefresh} />
      <main className="mx-auto max-w-5xl space-y-8 px-5 py-10 md:px-10">
        <div>
          <p className="text-xs uppercase tracking-[0.18em] text-[var(--copper)]">Seller dashboard</p>
          <h1 className="mt-2 text-4xl">{d.seller.name}</h1>
          <p className="mt-2 text-sm text-[var(--muted)]">{SELLER_FEE_COPY}</p>
          {params.stripe === "refresh" ? <p role="status" className="mt-3 text-sm">Your Stripe link expired. Click the button below to pick up where you left off.</p> : null}
        </div>

        <section aria-labelledby="steps-title" className="rounded-3xl bg-[var(--vine)] p-6 text-[#f4efe4]">
          <h2 id="steps-title" className="text-2xl">Next steps</h2>
          <ol className="mt-4 space-y-2">
            {d.checklist.map((item) => (
              <li key={item.key} className="flex items-center gap-3">
                <span aria-hidden className={`flex h-6 w-6 items-center justify-center rounded-full text-xs ${item.done ? "bg-[#f4efe4] text-[var(--vine)]" : "ring-1 ring-[#d7e7d4]"}`}>{item.done ? "✓" : ""}</span>
                <span className={item.done ? "line-through opacity-70" : ""}>{item.label}{item.optional ? " (optional)" : ""}</span>
                <span className="sr-only">{item.done ? "done" : "to do"}</span>
              </li>
            ))}
          </ol>
        </section>

        <div className="grid gap-5 md:grid-cols-2">
          <Card title="1. Payouts with Stripe" status={stripeStatus} good={d.stripe.state === "active"}>
            <p>{stripeText}</p>
            {d.stripe.connected ? (
              <ul className="space-y-1">
                <li>Accepting payments: <strong className="text-[var(--ink)]">{d.stripe.charges_enabled ? "Yes" : "Not yet"}</strong></li>
                <li>Payouts to your bank: <strong className="text-[var(--ink)]">{d.stripe.payouts_enabled ? "Yes" : "Not yet"}</strong></li>
              </ul>
            ) : null}
            {d.stripe.state !== "active" ? <StripeButton connected={d.stripe.connected} /> : null}
          </Card>
          <Card title="2. Amazon shipping" status={d.amazon.connected ? "Connected" : "Optional"} good={d.amazon.connected}>
            <p>Already sell on Amazon? Connect your account and we can ship orders from your Amazon stock.</p>
            {cfg.amazonMcfEnabled ? (
              <SellerConnect sellerId={d.seller.id} connected={d.amazon.connected} primeEnrolled={false} disabled={false} devTools={false} />
            ) : (
              <p className="italic">Amazon shipping is coming soon.</p>
            )}
          </Card>
        </div>

        <section aria-labelledby="products-title" className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-6">
          <h2 id="products-title" className="display text-2xl">3. Your products</h2>
          {!d.listings_visible ? (
            <p className="mt-2 text-sm text-[var(--muted)]">You can add products now. Shoppers will see them once Stripe confirms you can accept payments.</p>
          ) : (
            <p className="mt-2 text-sm text-[var(--muted)]">Your products are live for AI shoppers.</p>
          )}
          {d.products.length ? (
            <ul className="mt-4 space-y-3">
              {d.products.map((p) => <ProductRow key={p.product_id} product={p} categories={categories} visible={d.listings_visible} />)}
            </ul>
          ) : null}
          <h3 className="mt-6 font-medium">{d.products.length ? "Add another product" : "Add your first product"}</h3>
          <div className="mt-3"><ProductForm categories={categories} /></div>
        </section>
      </main>
      <SiteFooter />
    </>
  );
}
