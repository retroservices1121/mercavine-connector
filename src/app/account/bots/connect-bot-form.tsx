"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type Created = { id: string; name: string; token: string; scopes: string[] };

const GROUPS = [
  { id: "shop", label: "Shop", hint: "search the catalog" },
  { id: "checkout", label: "Checkout", hint: "build carts and submit them for your approval" },
  { id: "track", label: "Track", hint: "order status, tracking, returns" },
];

export function ConnectBotForm({ mcpUrl }: { mcpUrl: string }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);

  async function onSubmit(formData: FormData) {
    setError("");
    const dollars = (key: string) => {
      const v = String(formData.get(key) ?? "").trim();
      return v ? Math.round(Number(v) * 100) : undefined;
    };
    const response = await fetch("/api/v1/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: formData.get("name"),
        scopes: GROUPS.map((g) => g.id).filter((id) => formData.get(`scope_${id}`)),
        per_order_limit_cents: dollars("per_order"),
        per_month_limit_cents: dollars("per_month"),
        public_key_pem: formData.get("public_key_pem") || undefined,
      }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not connect the bot.");
      return;
    }
    setCreated(body as Created);
    router.refresh();
  }

  if (created) {
    return (
      <div className="space-y-3">
        <p className="text-sm font-medium">Bot “{created.name}” is connected. Copy this token now. It will not be shown again.</p>
        <code className="block break-all rounded-2xl border border-[var(--line)] bg-[var(--bg)] p-3 text-sm">{created.token}</code>
        <Button
          variant="vine"
          onClick={async () => {
            await navigator.clipboard.writeText(created.token);
            setCopied(true);
          }}
        >
          {copied ? "Copied" : "Copy token"}
        </Button>
        <p className="text-sm text-[var(--muted)]">
          In your bot, add the MCP server <code>{mcpUrl}</code> and send the token as <code>Authorization: Bearer &lt;token&gt;</code>.
          Scopes: {created.scopes.join(", ")}. Lost it? Revoke this bot and connect a new one.
        </p>
        <Button variant="outline" onClick={() => setCreated(null)}>Done</Button>
      </div>
    );
  }

  return (
    <form action={onSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="name">Bot name</Label>
        <Input id="name" name="name" placeholder="My Grok Bot" />
      </div>
      <fieldset className="space-y-2">
        <legend className="text-sm font-medium">Permissions</legend>
        {GROUPS.map((g) => (
          <label key={g.id} className="flex items-center gap-2 text-sm">
            <input type="checkbox" name={`scope_${g.id}`} defaultChecked /> {g.label} <span className="text-[var(--muted)]">({g.hint})</span>
          </label>
        ))}
      </fieldset>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-2">
          <Label htmlFor="per_order">Per-order limit (USD, optional)</Label>
          <Input id="per_order" name="per_order" type="number" min="0" step="0.01" placeholder="250" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="per_month">Monthly limit (USD, optional)</Label>
          <Input id="per_month" name="per_month" type="number" min="0" step="0.01" placeholder="2000" />
        </div>
      </div>
      <div className="space-y-2">
        <Label htmlFor="public_key_pem">Ed25519 public key for request signatures (optional)</Label>
        <textarea id="public_key_pem" name="public_key_pem" rows={3} className="w-full rounded-2xl border border-[var(--line)] bg-transparent p-3 text-sm" placeholder="-----BEGIN PUBLIC KEY-----" />
      </div>
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit" variant="vine">Connect bot</Button>
    </form>
  );
}
