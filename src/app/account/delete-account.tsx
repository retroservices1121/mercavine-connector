"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";

export function DeleteAccount() {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)}>
        Delete my account
      </Button>
    );
  }
  return (
    <form
      className="space-y-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const res = await fetch("/api/v1/me/delete", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password }),
        });
        setBusy(false);
        if (res.ok) {
          window.location.href = "/?account_deleted=1";
          return;
        }
        const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        setMessage(body.error?.message ?? "Could not delete the account.");
      }}
    >
      <p className="text-sm">
        This signs you out, disconnects your bots, and permanently deletes your personal data within 30 days. Order records are kept for tax purposes without your details.
      </p>
      <label className="block text-sm">
        Confirm with your password
        <input
          type="password"
          required
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mt-1 w-full rounded-xl border border-[var(--line)] px-3 py-2"
        />
      </label>
      <div className="flex gap-2">
        <Button type="submit" variant="vine" disabled={busy || !password}>
          Delete permanently
        </Button>
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      {message ? <p className="text-sm text-[var(--muted)]">{message}</p> : null}
    </form>
  );
}
