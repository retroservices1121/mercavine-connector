import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { userFromSessionToken } from "@/lib/auth";
import { config } from "@/lib/config";
import { formatUsd } from "@/lib/money";
import { readShopPayById } from "@/lib/shop-pay";
import { MockApprove } from "./approve";

export const dynamic = "force-dynamic";

export default async function MockShopPayPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const jar = await cookies();
  const user = userFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/shop-pay/mock/${id}`)}`);
  const cfg = config();
  const row = readShopPayById(id);
  if (!row || row.user_id !== user.id) {
    return (
      <main>
        <SiteHeader signedIn />
        <section className="mx-auto max-w-xl px-5 py-16">
          <h1 className="text-4xl">This Shop Pay request is not on your account.</h1>
        </section>
      </main>
    );
  }
  const paid = row.status === "paid";
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-xl px-5 py-16">
        <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Shop Pay · mock</p>
        <h1 className="mt-2 text-4xl">{paid ? "Shop Pay approved this purchase" : "Approve this purchase in Shop Pay"}</h1>
        <p className="mt-3 text-sm text-[var(--muted)]">
          {row.merchant_name} · {formatUsd(row.amount_cents)}. Paid with Shop Pay on the merchant checkout.
          {cfg.brandName}&apos;s 3% fee does not apply. No card number is shown or stored.
        </p>
        {paid ? (
          <Link href="/account" className="mt-6 inline-block text-sm underline">Back to your account</Link>
        ) : (
          <MockApprove cartId={row.cart_id} />
        )}
      </section>
    </main>
  );
}
