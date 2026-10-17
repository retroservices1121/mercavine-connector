import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { SiteHeader } from "@/components/site-header";
import { buyerFromSessionToken } from "@/lib/auth";
import { isEmailVerified } from "@/lib/email-auth";
import { VerifyBanner } from "./verify-banner";
import { humanOrders, notificationsFor } from "@/lib/cart";
import { config } from "@/lib/config";
import { getDb } from "@/lib/db";
import { feePercentLabel, formatUsd } from "@/lib/money";
import { shopLinkPublic } from "@/lib/shop-pay";
import { AccountActions } from "./account-actions";
import { ShopLinkPanel } from "./shop-link-panel";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const jar = await cookies();
  const user = buyerFromSessionToken(jar.get("mv_session")?.value);
  if (!user) redirect("/login");
  const cfg = config();
  const bots = getDb().prepare(`SELECT id, name, revoked_at, approval_threshold_cents, per_month_limit_cents FROM bots WHERE user_id = ?`).all(user.id) as {
    id: string;
    name: string;
    revoked_at: string | null;
    approval_threshold_cents: number;
    per_month_limit_cents: number;
  }[];
  const orders = humanOrders(user.id);
  const notes = notificationsFor(user.id);
  return (
    <main>
      <SiteHeader signedIn />
      <section className="mx-auto max-w-3xl px-5 py-8">
        <h1 className="text-4xl">{user.display_name}&apos;s account</h1>
        {isEmailVerified(user.id) ? null : <VerifyBanner email={user.email} />}
        <p className="mt-2 text-sm text-[var(--muted)]">{user.email}. Connector access is free. Sellers pay {feePercentLabel(cfg.platformFeeBps)}.</p>
        <p className="mt-2 flex flex-wrap gap-4 text-sm"><Link href="/account/bots" className="underline">Connect your bot</Link><Link href="/account/addresses" className="underline">Shipping addresses</Link><Link href="/sellers" className="underline">Amazon seller accounts</Link></p>
        {cfg.shopPayEnabled ? <ShopLinkPanel status={shopLinkPublic(user.id)} /> : null}
        {bots.map((bot) => (
          <article key={bot.id} className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
            <h2 className="text-2xl">{bot.name}</h2>
            <p className="mt-1 text-sm text-[var(--muted)]">
              Approval threshold {formatUsd(bot.approval_threshold_cents)}. Monthly limit {formatUsd(bot.per_month_limit_cents)}.
            </p>
            <div className="mt-4">
              <AccountActions botId={bot.id} revoked={Boolean(bot.revoked_at)} />
            </div>
          </article>
        ))}
        <h2 className="mt-10 text-2xl">Orders</h2>
        {orders.length === 0 ? <p className="mt-2 text-sm text-[var(--muted)]">No orders yet. Your bot can search and send an approval link.</p> : null}
        <ul className="mt-3 space-y-2">
          {orders.map((order) => (
            <li key={order.id} className="flex justify-between rounded-2xl border border-[var(--line)] px-4 py-3 text-sm">
              <span>{order.seller_name}<br /><span className="text-[var(--muted)]">{order.id} · {order.status}{order.payment_provider === "shop_pay" ? " · Shop Pay, no platform fee" : ""}</span></span>
              <span>{formatUsd(order.total_cents)}<br /><span className="text-[var(--muted)]">{order.payment_status}</span></span>
            </li>
          ))}
        </ul>
        <h2 className="mt-10 text-2xl">Notices</h2>
        <ul className="mt-3 space-y-2 text-sm">
          {notes.map((note) => (
            <li key={note.id} className="rounded-2xl bg-white px-4 py-3">
              <p>{note.title}</p>
              <p className="text-[var(--muted)]">{note.body}</p>
            </li>
          ))}
        </ul>
      </section>
    </main>
  );
}
