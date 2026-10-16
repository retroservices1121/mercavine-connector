import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { userFromSessionToken } from "@/lib/auth";
import { loadApproval } from "@/lib/cart";
import { config } from "@/lib/config";
import { feePercentLabel, formatUsd } from "@/lib/money";
import { ApprovalClient, type ReviewCart } from "./approval-client";
import { RefreshButton } from "./refresh-button";
import { CardCheckout } from "./card-checkout";

export const dynamic = "force-dynamic";

export default async function ApprovalPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const jar = await cookies();
  const user = userFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect(`/login?next=${encodeURIComponent(`/a/${token}`)}`);
  const view = loadApproval(token, user.id);
  const cfg = config();

  if (view.kind === "foreign") {
    return <Shell><h1 className="text-4xl">This request belongs to another account.</h1><p className="mt-3 text-[var(--muted)]">Nothing about the cart is shown here. The owner has been told.</p></Shell>;
  }
  if (view.kind === "invalid" || view.kind === "stale") {
    return <Shell><h1 className="text-4xl">This approval link is no longer valid.</h1><p className="mt-3 text-[var(--muted)]">Ask your bot for a new one.</p></Shell>;
  }
  if (view.kind === "rate_limited") {
    return <Shell><h1 className="text-4xl">This link was opened too many times.</h1><p className="mt-3 text-[var(--muted)]">Wait a few minutes and try again. The token was not used up.</p></Shell>;
  }
  if (view.kind === "expired") {
    return (
      <Shell>
        <h1 className="text-4xl">This request expired.</h1>
        <p className="mt-3 text-[var(--muted)]">The price hold ended at {new Date(view.expired_at).toLocaleString()}.</p>
        <RefreshButton token={token} />
      </Shell>
    );
  }
  if (view.kind === "cancelled") {
    return <Shell><h1 className="text-4xl">This request was cancelled.</h1><p className="mt-3 text-[var(--muted)]">{view.reason === "security_hold" ? "Too many failed sign-in attempts closed it." : "Your bot was told."}</p></Shell>;
  }
  if (view.kind === "card") {
    return (
      <main>
        <header className="px-4 pt-4 text-sm"><Link href="/">{cfg.brandName}</Link></header>
        <CardCheckout token={token} publishableKey={view.publishable_key} total={view.cart.totals.grand_total.amount} brandName={cfg.brandName} />
      </main>
    );
  }
  if (view.kind === "status") {
    const cart = view.cart;
    if (cart.status === "pending_shop_pay") {
      const shop = cart.shop_pay;
      return (
        <Shell>
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Shop Pay</p>
          <h1 className="mt-2 text-4xl">Approve this purchase in Shop Pay</h1>
          <p className="mt-3 text-[var(--muted)]">
            {cfg.brandName} recorded your approval. Shop Pay still has to approve this purchase on {shop?.merchant_name ?? "the merchant"}&apos;s checkout.
            The {feePercentLabel(cfg.platformFeeBps)} platform fee does not apply.
          </p>
          <p className="mt-4 text-lg">{formatUsd(cart.totals.grand_total.amount)}</p>
          {shop?.continue_url ? (
            <Link href={shop.continue_url} className="mt-6 inline-block rounded-full bg-[var(--vine)] px-5 py-3 text-sm text-white">Continue in Shop Pay</Link>
          ) : (
            <p className="mt-4 text-sm">The Shop Pay approval link is not ready yet. Refresh this page.</p>
          )}
        </Shell>
      );
    }
    if (cart.status === "paid") {
      const shopPaid = cart.platform_fee_applies === false || cart.lane === "shop_pay";
      return (
        <Shell>
          <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Paid</p>
          <h1 className="mt-2 text-4xl">Receipt</h1>
          <ul className="mt-4 space-y-2 text-sm">
            {cart.order_ids.map((id) => <li key={id}>{id}</li>)}
          </ul>
          {shopPaid ? (
            <p className="mt-4">Total {formatUsd(cart.totals.grand_total.amount)}. Paid with Shop Pay on the merchant&apos;s checkout. {cfg.brandName}&apos;s {feePercentLabel(cfg.platformFeeBps)} fee does not apply.</p>
          ) : (
            <p className="mt-4">Total {formatUsd(cart.totals.grand_total.amount)}. Sellers were charged directly. {cfg.brandName}&apos;s {cart.fee_label} fee comes out of each seller charge, not your total.</p>
          )}
          <Link href="/account" className="mt-6 inline-block text-sm underline">Back to your account</Link>
        </Shell>
      );
    }
    return <Shell><h1 className="text-4xl capitalize">{cart.status.replaceAll("_", " ")}.</h1><p className="mt-3 text-[var(--muted)]">{cart.status === "declined" ? "We told your bot." : "This link has already been used."}</p></Shell>;
  }

  return (
    <main>
      <header className="px-4 pt-4 text-sm"><Link href="/">{cfg.brandName}</Link></header>
      <ApprovalClient token={token} cart={JSON.parse(JSON.stringify(view.cart)) as ReviewCart} hasPasskey={view.has_passkey} devStepUp={cfg.allowDevStepUp} />
    </main>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <main className="mx-auto max-w-xl px-5 py-16">{children}</main>;
}
