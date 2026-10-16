"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { loadStripe, type Stripe } from "@stripe/stripe-js";
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js";
import { Button } from "@/components/ui/button";
import { formatUsd } from "@/lib/money";

type Intent = { seller_id: string; seller_name: string; stripe_account: string; amount_cents: number; client_secret: string; status: string };

const stripeCache = new Map<string, Promise<Stripe | null>>();
function stripeFor(key: string, account: string) {
  // Direct charges: Elements must be initialized on the seller's connected account.
  const id = `${key}:${account}`;
  if (!stripeCache.has(id)) stripeCache.set(id, loadStripe(key, { stripeAccount: account }));
  return stripeCache.get(id)!;
}

export function CardCheckout({ token, publishableKey, total, brandName }: { token: string; publishableKey: string | null; total: number; brandName: string }) {
  const router = useRouter();
  const [intents, setIntents] = useState<Intent[] | null>(null);
  const [error, setError] = useState("");
  const base = `/api/v1/approvals/${encodeURIComponent(token)}/payment`;

  const sync = useCallback(async () => {
    const res = await fetch(`${base}/sync`, { method: "POST" });
    const body = await res.json();
    if (body.paid) {
      router.refresh();
      return true;
    }
    return false;
  }, [base, router]);

  const load = useCallback(async () => {
    const res = await fetch(base, { cache: "no-store" });
    const body = await res.json();
    if (!res.ok) return setError(body.error?.message ?? "Payment could not start.");
    if (body.paid) return router.refresh();
    setIntents(body.payment.intents as Intent[]);
  }, [base, router]);

  useEffect(() => {
    // Returning from a redirect-based method (some wallets/banks) lands here; sync first.
    void sync().then((done) => (done ? null : load()));
  }, [load, sync]);

  const next = useMemo(() => intents?.find((i) => i.status === "awaiting_payment"), [intents]);
  const doneCount = intents ? intents.length - intents.filter((i) => i.status === "awaiting_payment").length : 0;

  if (!publishableKey) {
    return <div className="mx-auto max-w-xl px-4 py-16"><h1 className="text-4xl">Payments are almost ready.</h1><p className="mt-3 text-[var(--muted)]">Card checkout isn&apos;t switched on yet. Nothing was charged.</p></div>;
  }

  return (
    <div className="mx-auto max-w-xl px-4 pb-24 pt-6">
      <p className="text-xs uppercase tracking-[0.16em] text-[var(--muted)]">Approved · Payment</p>
      <h1 className="mt-2 text-4xl leading-tight">Pay {formatUsd(total)}</h1>
      <p className="mt-3 text-sm text-[var(--muted)]">
        You pay each seller directly through Stripe. {brandName} never sees your full card number, and your bot never receives payment details.
        Nothing is captured until every seller in this order is authorized.
      </p>
      {intents && intents.length > 1 ? <p className="mt-2 text-sm">Payment {Math.min(doneCount + 1, intents.length)} of {intents.length}</p> : null}
      {error ? <p className="mt-4 text-sm text-[var(--danger)]">{error}</p> : null}
      {!intents && !error ? <p className="mt-6 text-sm text-[var(--muted)]">Loading secure payment form…</p> : null}
      {next ? (
        <section key={next.client_secret} className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-4">
          <p className="mb-3 text-sm">Pay {next.seller_name} · {formatUsd(next.amount_cents)}</p>
          <Elements
            stripe={stripeFor(publishableKey, next.stripe_account)}
            options={{ clientSecret: next.client_secret, appearance: { theme: "stripe", variables: { colorPrimary: "#3f5b3a", borderRadius: "12px" } } }}
          >
            <PayForm
              token={token}
              onDone={async () => {
                if (!(await sync())) await load();
              }}
              onError={setError}
            />
          </Elements>
        </section>
      ) : intents && !next ? <p className="mt-6 text-sm">Finishing up…</p> : null}
    </div>
  );
}

function PayForm({ token, onDone, onError }: { token: string; onDone: () => Promise<void>; onError: (msg: string) => void }) {
  const stripe = useStripe();
  const elements = useElements();
  const [pending, setPending] = useState(false);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!stripe || !elements) return;
    setPending(true);
    onError("");
    const { error } = await stripe.confirmPayment({
      elements,
      confirmParams: { return_url: `${window.location.origin}/a/${encodeURIComponent(token)}` },
      redirect: "if_required",
    });
    if (error) {
      onError(error.message ?? "Your payment did not go through. You can try again.");
      setPending(false);
      return;
    }
    await onDone();
    setPending(false);
  }
  return (
    <form onSubmit={submit}>
      {/* Payment Element: cards (incl. browser autofill), Link, Apple Pay and Google Pay when enabled and eligible. */}
      <PaymentElement options={{ layout: "tabs", wallets: { applePay: "auto", googlePay: "auto" } }} />
      <Button type="submit" variant="vine" className="mt-4 w-full" disabled={!stripe || pending}>{pending ? "Processing…" : "Pay"}</Button>
    </form>
  );
}
