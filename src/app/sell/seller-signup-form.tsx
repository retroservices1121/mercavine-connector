"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const field = "space-y-2";
const select = "flex h-11 w-full rounded-xl border border-[var(--line)] bg-white px-3 text-sm outline-none focus:border-[var(--vine)]";

export function SellerSignupForm({
  signedInEmail,
  categories,
  states,
}: {
  signedInEmail: string | null;
  categories: { slug: string; label: string }[];
  states: string[];
}) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);

  async function onSubmit(form: FormData) {
    setPending(true);
    setError("");
    const body: Record<string, unknown> = Object.fromEntries(
      ["business_name", "contact_name", "contact_email", "password", "phone", "website", "category", "state", "description"].map((k) => [k, form.get(k) ?? ""]),
    );
    body.agree_terms = form.get("agree_terms") === "on";
    const response = await fetch("/api/v1/sellers/signup", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    setPending(false);
    if (!response.ok) {
      const json = await response.json().catch(() => ({}));
      setError(json?.error?.message ?? "We couldn't create your seller account. Please check your details.");
      return;
    }
    router.push("/seller");
    router.refresh();
  }

  return (
    <form action={onSubmit} className="space-y-4" aria-describedby={error ? "seller-error" : undefined}>
      <div className={field}>
        <Label htmlFor="business_name">Business name</Label>
        <Input id="business_name" name="business_name" autoComplete="organization" required />
      </div>
      <div className={field}>
        <Label htmlFor="contact_name">Your name</Label>
        <Input id="contact_name" name="contact_name" autoComplete="name" required />
      </div>
      {signedInEmail ? (
        <p className="rounded-xl bg-[var(--paper)] px-3 py-2 text-sm">Signed in as {signedInEmail}. We&apos;ll use this account.</p>
      ) : (
        <>
          <div className={field}>
            <Label htmlFor="contact_email">Email</Label>
            <Input id="contact_email" name="contact_email" type="email" autoComplete="email" required />
          </div>
          <div className={field}>
            <Label htmlFor="password">Password (at least 10 characters)</Label>
            <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
          </div>
        </>
      )}
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor="phone">Phone (optional)</Label>
          <Input id="phone" name="phone" type="tel" autoComplete="tel" />
        </div>
        <div className={field}>
          <Label htmlFor="website">Website (optional)</Label>
          <Input id="website" name="website" type="url" placeholder="https://" />
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className={field}>
          <Label htmlFor="category">What do you sell?</Label>
          <select id="category" name="category" required className={select} defaultValue="">
            <option value="" disabled>Choose a category</option>
            {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
          </select>
        </div>
        <div className={field}>
          <Label htmlFor="state">State</Label>
          <select id="state" name="state" required className={select} defaultValue="">
            <option value="" disabled>Choose a state</option>
            {states.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
      </div>
      <div className={field}>
        <Label htmlFor="description">Tell shoppers about your business</Label>
        <textarea id="description" name="description" required minLength={10} maxLength={500} rows={3} className={`${select} h-auto py-2`} />
      </div>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" name="agree_terms" required className="mt-1" />
        <span>I agree to the <a href="/terms" className="underline" target="_blank">seller terms</a>.</span>
      </label>
      {error ? <p id="seller-error" role="alert" className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit" variant="vine" disabled={pending} className="w-full">
        {pending ? "Creating your seller account…" : "Start selling"}
      </Button>
    </form>
  );
}
