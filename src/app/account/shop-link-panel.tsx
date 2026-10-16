"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

type LinkStatus = {
  linked: boolean;
  email: string | null;
  name: string | null;
  mode: string;
  user_code: string | null;
  verification_uri: string | null;
};

export function ShopLinkPanel({ status }: { status: LinkStatus }) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function start() {
    setPending(true);
    setMessage("");
    const response = await fetch("/api/v1/shop/link", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_name: "Mercavine" }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setMessage(body.error?.message ?? "Shop Pay could not start.");
      return;
    }
    router.refresh();
  }

  return (
    <section className="mt-6 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5">
      <h2 className="text-2xl">Shop Pay</h2>
      <p className="mt-1 text-sm text-[var(--muted)]">
        Link your Shop Pay account. Each purchase still needs your approval here, then in Shop Pay. Card numbers stay with Shop.
        {status.mode === "mock" ? " This server is in mock mode, so the sign-in stays on Mercavine." : ""}
      </p>
      {status.linked ? <p className="mt-3 text-sm">Linked{status.email ? ` as ${status.email}` : ""}.</p> : null}
      {status.user_code && status.verification_uri ? (
        <p className="mt-3 text-sm">
          Code <span className="font-medium">{status.user_code}</span>.{" "}
          <a className="underline" href={status.verification_uri}>Open Sign in with Shop</a>
        </p>
      ) : null}
      <div className="mt-4">
        <Button variant="vine" disabled={pending} onClick={start}>
          {status.linked ? "Link again" : "Sign in with Shop"}
        </Button>
      </div>
      {message ? <p className="mt-2 text-sm text-[var(--danger)]">{message}</p> : null}
    </section>
  );
}
