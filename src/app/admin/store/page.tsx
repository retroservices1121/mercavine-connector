import { cookies } from "next/headers";
import { ADMIN_COOKIE, adminTokenConfigured, adminTokenMatches } from "@/lib/admin-auth";
import { notFound } from "next/navigation";
import { AdminLogin, OrderActions, SignOut } from "./admin-actions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Store orders", robots: { index: false, follow: false } };

const usd = (c: number) => `$${(c / 100).toFixed(2)}`;

export default async function AdminStorePage() {
  if (!adminTokenConfigured()) notFound();
  const jar = await cookies();
  if (!adminTokenMatches(jar.get(ADMIN_COOKIE)?.value)) {
    return (
      <main className="mx-auto max-w-md p-6">
        <h1 className="display text-3xl">Store admin</h1>
        <AdminLogin />
      </main>
    );
  }
  const { supplierOrdersForReview, storeConfig } = await import("@/lib/cj-store");
  const { jobStatus } = await import("@/lib/store-jobs");
  const orders = supplierOrdersForReview();
  const live = storeConfig().ordersLive;
  const jobs = jobStatus() as Record<string, { at?: string; ok?: boolean }>;
  return (
    <main className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <h1 className="display text-3xl">Store orders</h1>
        <SignOut />
      </div>
      <p className={`rounded-xl p-3 text-sm ${live ? "bg-red-100" : "bg-[#efe3cf]"}`}>
        {live ? "CJ_ORDERS_LIVE is on: approving captures payment and creates a real CJ order (unpaid, payType 3)." : "Dry-run: approving captures payment and records the CJ request, but nothing is sent to CJ."}
      </p>
      <p className="text-xs text-[var(--muted)]">
        Jobs: {Object.keys(jobs).length ? Object.entries(jobs).map(([k, v]) => `${k} ${v.ok ? "ok" : "failed"} ${v.at ?? ""}`).join(" · ") : "no runs yet"}
      </p>
      {orders.length === 0 && <p>No store orders yet.</p>}
      {orders.map((o) => (
        <section key={o.id} className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5 text-sm">
          <div className="flex justify-between gap-2">
            <strong>{o.id}</strong>
            <span className="rounded-full bg-[#efe3cf] px-3 py-1 text-xs">{o.status}</span>
          </div>
          <p className="text-[var(--muted)]">{o.created_at} · ships to {o.ship_to}</p>
          <ul className="my-2 list-disc pl-5">
            {o.lines.map((l, i) => (<li key={i}>{l.quantity} × {l.title} @ {usd(l.unit_price_cents)}</li>))}
          </ul>
          <p>Subtotal {usd(o.subtotal_cents)} · tax {usd(o.tax_cents)} · est. CJ cost {usd(o.est_cost_cents)} · margin {usd(o.subtotal_cents - o.est_cost_cents)}</p>
          {o.tracking_number && <p>Tracking: {o.tracking_number} ({o.cj_status})</p>}
          {o.detail && <p className="text-[var(--muted)]">Note: {o.detail}</p>}
          {o.status === "pending_approval" && <OrderActions id={o.id} live={live} />}
        </section>
      ))}
    </main>
  );
}
