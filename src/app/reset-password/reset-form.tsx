"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function ResetForm({ token }: { token: string }) {
  const [done, setDone] = useState(false);
  const [error, setError] = useState("");
  if (done) {
    return <p className="text-sm">Password updated. You were signed out everywhere. <Link href="/login" className="underline">Sign in</Link></p>;
  }
  return (
    <form
      className="space-y-4"
      action={async (fd) => {
        setError("");
        if (fd.get("password") !== fd.get("confirm")) return setError("Passwords do not match.");
        const res = await fetch("/api/v1/password/reset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, password: fd.get("password") }) });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          return setError(j?.error?.message ?? "Could not reset the password.");
        }
        setDone(true);
      }}
    >
      <div className="space-y-2">
        <Label htmlFor="password">New password (at least 10 characters)</Label>
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      <div className="space-y-2">
        <Label htmlFor="confirm">Confirm new password</Label>
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
      </div>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit" variant="vine" className="w-full">Set new password</Button>
    </form>
  );
}
