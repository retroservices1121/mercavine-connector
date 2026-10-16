"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function SellerConnect({
  sellerId,
  connected,
  primeEnrolled,
  disabled,
  devTools,
}: {
  sellerId: string;
  connected: boolean;
  primeEnrolled: boolean;
  disabled: boolean;
  devTools: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);

  async function connect() {
    setPending(true);
    setMessage("");
    const response = await fetch(`/api/v1/sellers/${sellerId}/amazon/connect`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setMessage(body.error?.message ?? "Amazon could not be connected.");
      return;
    }
    if (typeof body.authorize_url === "string" && body.authorize_url) {
      window.location.href = body.authorize_url;
      return;
    }
    router.refresh();
  }

  async function togglePrime() {
    setPending(true);
    setMessage("");
    const response = await fetch(`/api/v1/sellers/${sellerId}/amazon/prime`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enrolled: !primeEnrolled }),
    });
    const body = await response.json();
    setPending(false);
    if (!response.ok) {
      setMessage(body.error?.message ?? "Prime enrollment could not be updated.");
      return;
    }
    router.refresh();
  }

  return (
    <div className="mt-4 flex flex-wrap gap-2">
      <Button variant="vine" disabled={disabled || pending} onClick={connect}>
        {connected ? "Reconnect Amazon" : "Connect Amazon seller account"}
      </Button>
      {devTools ? (
        <Button variant="outline" disabled={disabled || pending} onClick={togglePrime}>
          {primeEnrolled ? "Dev: clear Prime enrollment" : "Dev: mark Prime enrolled"}
        </Button>
      ) : null}
      {message ? <p className="w-full text-sm text-[var(--danger)]">{message}</p> : null}
    </div>
  );
}
