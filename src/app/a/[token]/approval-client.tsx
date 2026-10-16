"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { startAuthentication } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { formatUsd } from "@/lib/money";

type Line = {
  line_id: string;
  title: string;
  variant: string | null;
  quantity: number;
  unit_price: number;
  status: string;
};

type Group = {
  seller: { id: string; name: string };
  merchant_of_record: boolean;
  lines: Line[];
  shipping: number;
  tax: number;
  subtotal: number;
  total: number;
};

export type ReviewCart = {
  id: string;
  status: string;
  bot_name: string;
  note_for_human: string | null;
  lock_expires_at: string | null;
  seller_groups: Group[];
  totals: { subtotal: number; shipping: number; tax: number; grand_total: { amount: number } };
  changes_pending: boolean;
  fee_label: string;
  platform_fee_applies?: boolean;
  lane?: string;
  shop_pay?: { continue_url: string | null; merchant_name?: string; fee_cents?: number; status?: string } | null;
  seller_fees: { seller_id: string; seller_name: string; charge_cents: number; fee_cents: number }[];
  limits: { spent_month_cents: number; month_limit_cents: number; threshold_cents: number; above_threshold: boolean };
  shipping_address_full: { id: string; label: string; recipient: string; line1: string; city: string; region: string; postal_code: string } | null;
  saved_addresses: { id: string; label: string; city: string; region: string }[];
  order_ids: string[];
  payment_mode?: string;
};

function useCountdown(iso: string | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  return useMemo(() => {
    if (!iso) return "—";
    const remain = Math.max(0, Date.parse(iso) - now);
    const min = Math.floor(remain / 60000);
    const sec = Math.floor((remain % 60000) / 1000);
    return `${min}:${sec.toString().padStart(2, "0")}`;
  }, [iso, now]);
}

export function ApprovalClient({ token, cart, hasPasskey, devStepUp }: { token: string; cart: ReviewCart; hasPasskey: boolean; devStepUp: boolean }) {
  const router = useRouter();
  const countdown = useCountdown(cart.lock_expires_at);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [reason, setReason] = useState("not_now");
  const [showDecline, setShowDecline] = useState(false);
  const [failSeller, setFailSeller] = useState("");
  const shopPay = cart.platform_fee_applies === false || cart.lane === "shop_pay";
  const count = cart.seller_groups.reduce((sum, group) => sum + group.lines.filter((line) => line.status !== "unavailable").length, 0);
  const payers = cart.seller_groups.filter((group) => group.total > 0);

  async function approve() {
    setPending(true);
    setError("");
    try {
      let method: "passkey" | "dev_step_up" = "dev_step_up";
      let assertion: unknown;
      if (hasPasskey) {
        const options = await fetch("/api/v1/passkeys/authenticate/options", { method: "POST" }).then((res) => res.json());
        assertion = await startAuthentication({ optionsJSON: options });
        method = "passkey";
      }
      const response = await fetch(`/api/v1/approvals/${encodeURIComponent(token)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          method,
          assertion,
          acknowledged_changes: ack,
          simulate_failure_seller_id: failSeller || undefined,
        }),
      });
      const body = await response.json();
      if (!response.ok) {
        setError(body.code === "card_declined" ? "The seller's bank declined the charge. You can try again before the hold expires." : body.error?.message ?? "Payment did not complete.");
        setPending(false);
        router.refresh();
        return;
      }
      // Live Stripe: approval opens the card step (Payment Element) on this same hosted page.
      router.refresh();
    } catch {
      setError("The approval could not be completed.");
      setPending(false);
    }
  }

  async function decline() {
    setPending(true);
    await fetch(`/api/v1/approvals/${encodeURIComponent(token)}/decline`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reason, share_note: false }),
    });
    router.refresh();
  }

  async function changeAddress(addressId: string) {
    await fetch(`/api/v1/approvals/${encodeURIComponent(token)}/address`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address_id: addressId }),
    });
    router.refresh();
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-36 pt-6">
      <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Price held for {countdown}</p>
      <h1 className="mt-2 text-4xl leading-tight">{cart.bot_name} wants to buy {count} {count === 1 ? "item" : "items"}</h1>
      {cart.note_for_human ? <p className="mt-4 rounded-2xl bg-white px-4 py-3 text-sm">{cart.note_for_human}</p> : null}
      <div className="mt-6 space-y-4">
        {cart.seller_groups.map((group) => (
          <section key={group.seller.id} className="rounded-3xl border border-[var(--line)] bg-[var(--card)] p-4">
            <p className="text-sm">Sold by {group.seller.name}</p>
            <p className="text-xs text-[var(--muted)]">Merchant of record</p>
            <ul className="mt-3 space-y-3">
              {group.lines.map((line) => (
                <li key={line.line_id} className={line.status === "unavailable" ? "text-[var(--muted)] line-through" : ""}>
                  <div className="flex justify-between gap-3">
                    <span>{line.title}{line.variant ? ` · ${line.variant}` : ""} × {line.quantity}</span>
                    <span>{line.status === "unavailable" ? "Unavailable" : formatUsd(line.unit_price * line.quantity)}</span>
                  </div>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-sm text-[var(--muted)]">Shipping {formatUsd(group.shipping)} · Tax {formatUsd(group.tax)} · {formatUsd(group.total)}</p>
          </section>
        ))}
      </div>
      {cart.changes_pending ? (
        <label className="mt-4 flex items-start gap-3 rounded-2xl border border-[var(--copper)] bg-white p-3 text-sm">
          <Checkbox checked={ack} onCheckedChange={(value) => setAck(value === true)} />
          <span>I&apos;ve reviewed the changes. Unavailable lines will not be charged.</span>
        </label>
      ) : null}
      <section className="mt-4 rounded-3xl border border-[var(--line)] p-4">
        <p className="text-sm">Ship to {cart.shipping_address_full?.label}</p>
        <p className="text-sm text-[var(--muted)]">
          {cart.shipping_address_full?.recipient}, {cart.shipping_address_full?.line1}, {cart.shipping_address_full?.city} {cart.shipping_address_full?.region} {cart.shipping_address_full?.postal_code}
        </p>
        {cart.saved_addresses.length > 1 ? (
          <label className="mt-2 block text-sm">
            Change
            <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white p-2" value={cart.shipping_address_full?.id} onChange={(event) => changeAddress(event.target.value)}>
              {cart.saved_addresses.map((address) => (
                <option key={address.id} value={address.id}>{address.label} · {address.city}, {address.region}</option>
              ))}
            </select>
          </label>
        ) : null}
      </section>
      <section className="mt-4 text-sm">
        <div className="flex justify-between"><span>Subtotal</span><span>{formatUsd(cart.totals.subtotal)}</span></div>
        <div className="flex justify-between"><span>Shipping</span><span>{formatUsd(cart.totals.shipping)}</span></div>
        <div className="flex justify-between"><span>Tax estimate</span><span>{formatUsd(cart.totals.tax)}</span></div>
        <div className="mt-1 flex justify-between text-lg"><span>You pay</span><span>{formatUsd(cart.totals.grand_total.amount)}</span></div>
        {payers.length > 1 ? (
          <p className="mt-2 text-[var(--muted)]">You&apos;ll see {payers.length} charges: {payers.map((group) => `${group.seller.name} ${formatUsd(group.total)}`).join(" · ")}.</p>
        ) : null}
        {shopPay ? (
          <p className="mt-2 text-[var(--muted)]">This order is paid with Shop Pay on the merchant&apos;s checkout. Mercavine&apos;s 3% fee does not apply.</p>
        ) : (
          <p className="mt-2 text-[var(--muted)]">
            Sellers pay Mercavine {cart.fee_label} of each charge via Stripe before their payout.
            {cart.seller_fees.map((fee) => ` ${fee.seller_name} ${formatUsd(fee.fee_cents)}.`)}
            {" "}That fee is not added to your total.
          </p>
        )}
        <p className="mt-2">
          This bot has spent {formatUsd(cart.limits.spent_month_cents)} of {formatUsd(cart.limits.month_limit_cents)} this month.
          {cart.limits.above_threshold ? ` This order is above your ${formatUsd(cart.limits.threshold_cents)} approval threshold.` : ` This order is within your ${formatUsd(cart.limits.threshold_cents)} approval threshold.`}
        </p>
      </section>
      {cart.payment_mode === "mock" && !shopPay ? (
        <label className="mt-4 block text-xs text-[var(--muted)]">
          Test mode can decline one seller before any capture.
          <select className="mt-1 w-full rounded-xl border border-[var(--line)] bg-white p-2 text-sm" value={failSeller} onChange={(event) => setFailSeller(event.target.value)}>
            <option value="">Charge normally</option>
            {payers.map((group) => <option key={group.seller.id} value={group.seller.id}>Decline {group.seller.name}</option>)}
          </select>
        </label>
      ) : null}
      {error ? <p className="mt-3 text-sm text-[var(--danger)]">{error}</p> : null}
      <div className="fixed inset-x-0 bottom-0 border-t border-[var(--line)] bg-[var(--paper)] px-4 py-3">
        <div className="mx-auto flex max-w-xl gap-2">
          <Button variant="vine" className="flex-1" disabled={pending || (cart.changes_pending && !ack)} onClick={approve}>
            {pending ? "Working…" : shopPay ? "Approve for Shop Pay" : "Approve & pay"}
          </Button>
          <Button variant="danger" disabled={pending} onClick={() => setShowDecline((value) => !value)}>Decline</Button>
        </div>
        {!hasPasskey && devStepUp ? <p className="mx-auto mt-2 max-w-xl text-center text-xs text-[var(--muted)]">No passkey is enrolled. This tap is a dev confirmation, not a passkey.</p> : null}
        {showDecline ? (
          <div className="mx-auto mt-3 flex max-w-xl gap-2">
            <select className="flex-1 rounded-xl border border-[var(--line)] bg-white p-2 text-sm" value={reason} onChange={(event) => setReason(event.target.value)}>
              <option value="too_expensive">Too expensive</option>
              <option value="wrong_item">Wrong item</option>
              <option value="not_now">Not now</option>
              <option value="other">Other</option>
            </select>
            <Button variant="outline" onClick={decline}>Confirm decline</Button>
          </div>
        ) : null}
        <p className="mx-auto mt-2 max-w-xl text-center text-xs text-[var(--muted)]">Your payment details are never shared with your bot.</p>
      </div>
    </div>
  );
}
