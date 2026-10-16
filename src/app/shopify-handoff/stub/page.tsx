import { SiteHeader } from "@/components/site-header";
import { config } from "@/lib/config";

export default function ShopifyStubPage() {
  const cfg = config();
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-xl px-5 py-12">
        <h1 className="text-4xl">Merchant checkout handoff</h1>
        <p className="mt-4 text-sm leading-relaxed text-[var(--muted)]">
          This is a local stub. A real Shopify variant returns the merchant&apos;s continue_url.
          {cfg.brandName} does not charge the card here, and in-bot complete_checkout stays off until Shopify grants permission.
        </p>
      </section>
    </main>
  );
}
