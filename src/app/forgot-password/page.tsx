"use client";

import { useState } from "react";
import Link from "next/link";
import { SiteHeader } from "@/components/site-header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false);
  return (
    <main>
      <SiteHeader />
      <section className="mx-auto max-w-md px-5 py-10">
        <h1 className="text-4xl">Forgot password</h1>
        {sent ? (
          <p className="mt-4 text-sm">If an account exists for that email, we sent a reset link. It expires in 1 hour.</p>
        ) : (
          <form
            className="mt-6 space-y-4 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5"
            action={async (fd) => {
              await fetch("/api/v1/password/forgot", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: fd.get("email") }) });
              setSent(true);
            }}
          >
            <div className="space-y-2">
              <Label htmlFor="email">Email</Label>
              <Input id="email" name="email" type="email" autoComplete="email" required />
            </div>
            <Button type="submit" variant="vine" className="w-full">Send reset link</Button>
          </form>
        )}
        <p className="mt-4 text-sm"><Link href="/login" className="underline">Back to sign in</Link></p>
      </section>
    </main>
  );
}
