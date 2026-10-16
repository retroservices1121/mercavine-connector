"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Address } from "@/lib/accounts";

const FIELDS: [keyof Address, string, boolean][] = [
  ["label", "Label", false],
  ["recipient", "Recipient", true],
  ["line1", "Street address", true],
  ["line2", "Apt, suite (optional)", false],
  ["city", "City", true],
  ["region", "State", true],
  ["postal_code", "ZIP", true],
];

export function AddressManager({ addresses }: { addresses: Address[] }) {
  const router = useRouter();
  const [error, setError] = useState("");

  async function call(url: string, method: string, body?: unknown) {
    setError("");
    const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      setError(j?.error?.message ?? "Something went wrong.");
      return false;
    }
    router.refresh();
    return true;
  }

  return (
    <div className="space-y-6">
      <ul className="space-y-3">
        {addresses.map((a) => (
          <li key={a.id} className="rounded-2xl border border-[var(--line)] p-4 text-sm">
            <p className="font-medium">{a.label}{a.is_default ? " · Default" : ""}</p>
            <p className="text-[var(--muted)]">{a.recipient}, {a.line1}{a.line2 ? `, ${a.line2}` : ""}, {a.city}, {a.region} {a.postal_code}</p>
            <div className="mt-2 flex gap-2">
              {!a.is_default ? <Button variant="outline" onClick={() => call(`/api/v1/addresses/${a.id}`, "PATCH", { is_default: true })}>Make default</Button> : null}
              <Button variant="outline" onClick={() => call(`/api/v1/addresses/${a.id}`, "DELETE")}>Delete</Button>
            </div>
          </li>
        ))}
      </ul>
      <form
        action={async (fd) => {
          const body: Record<string, unknown> = Object.fromEntries(FIELDS.map(([k]) => [k, fd.get(k) || undefined]));
          body.is_default = Boolean(fd.get("is_default"));
          await call("/api/v1/addresses", "POST", body);
        }}
        className="space-y-3 rounded-3xl border border-[var(--line)] bg-[var(--card)] p-5"
      >
        <h2 className="text-xl">Add an address</h2>
        {FIELDS.map(([k, label, required]) => (
          <div key={k} className="space-y-1">
            <Label htmlFor={k}>{label}</Label>
            <Input id={k} name={k} required={required} />
          </div>
        ))}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="is_default" /> Make this my default</label>
        <p className="text-xs text-[var(--muted)]">US addresses only. Checkout ships to your default address unless your bot picks another saved one.</p>
        {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
        <Button type="submit" variant="vine">Save address</Button>
      </form>
    </div>
  );
}
