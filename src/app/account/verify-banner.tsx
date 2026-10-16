"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function VerifyBanner({ email }: { email: string }) {
  const [msg, setMsg] = useState("");
  return (
    <div className="mt-4 rounded-2xl border border-[var(--line)] bg-[var(--card)] p-4 text-sm">
      <p><strong>Verify your email.</strong> We sent a link to {email}. Your bot can&apos;t start checkouts until you confirm it.</p>
      <div className="mt-2 flex items-center gap-3">
        <Button
          variant="outline"
          onClick={async () => {
            const res = await fetch("/api/v1/users/verify/resend", { method: "POST" });
            const j = await res.json().catch(() => ({}));
            setMsg(res.ok ? "Sent. Check your inbox." : j?.error?.message ?? "Could not resend.");
          }}
        >
          Resend email
        </Button>
        {msg ? <span className="text-[var(--muted)]">{msg}</span> : null}
      </div>
    </div>
  );
}
