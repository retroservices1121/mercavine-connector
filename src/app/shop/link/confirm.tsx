"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";

export function ConfirmShopLink() {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  return (
    <div className="mt-6">
      <Button
        variant="vine"
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError("");
          const response = await fetch("/api/v1/shop/link/poll", { method: "POST" });
          const body = await response.json();
          setPending(false);
          if (!response.ok) {
            setError(body.error?.message ?? "Shop has not approved this sign-in yet.");
            return;
          }
          router.refresh();
        }}
      >
        {pending ? "Checking…" : "I've approved in Shop"}
      </Button>
      {error ? <p className="mt-3 text-sm text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}
