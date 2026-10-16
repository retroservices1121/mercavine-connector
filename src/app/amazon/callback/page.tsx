import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { completeAmazonOAuth } from "@/lib/amazon-mcf";
import { config } from "@/lib/config";
import { ApiError } from "@/lib/errors";

export const dynamic = "force-dynamic";

function first(value: string | string[] | undefined): string {
  return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

export default async function AmazonCallbackPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const cfg = config();
  let title = "Amazon seller account";
  let body = "The seller account was not connected.";
  let partner: string | null = null;
  try {
    const status = await completeAmazonOAuth({
      code: first(params.spapi_oauth_code),
      state: first(params.state),
      sellingPartnerId: first(params.selling_partner_id),
    });
    title = "Amazon seller account connected";
    body = `${status.seller_name} is connected. The refresh token stays on this server.`;
    partner = status.selling_partner_id;
  } catch (error) {
    if (error instanceof ApiError) body = error.message;
  }
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-xl px-5 py-16">
        <h1 className="text-4xl">{title}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">{body}</p>
        {partner ? <p className="mt-2 text-sm">Selling partner {partner}.</p> : null}
        <p className="mt-3 text-sm text-[var(--muted)]">
          {cfg.brandName} still checks the shopper out. This callback does not place an order on amazon.com.
        </p>
        <p className="mt-6 text-sm">
          <Link href="/sellers" className="underline">Back to seller accounts</Link>
        </p>
      </section>
    </main>
  );
}
