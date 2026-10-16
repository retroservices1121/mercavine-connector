"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { buildBotPayload, ed25519Supported, generateBotKeyPair, looksLikePublicKeyPem } from "@/lib/bot-keys";

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
  const [mcpOnly, setMcpOnly] = useState(false);
  const [publicKey, setPublicKey] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [savedPrivate, setSavedPrivate] = useState(false);
  const [privCopied, setPrivCopied] = useState(false);
  const [canGenerate, setCanGenerate] = useState<boolean | null>(null);

  useEffect(() => {
    ed25519Supported().then(setCanGenerate);
  }, []);

  const keyValid = looksLikePublicKeyPem(publicKey);
  const canSubmit = mcpOnly || (keyValid && (!privateKey || savedPrivate));

  async function generate() {
    setError("");
    try {
      const pair = await generateBotKeyPair();
      setPublicKey(pair.publicKeyPem);
      setPrivateKey(pair.privateKeyPem);
      setSavedPrivate(false);
    } catch {
      setCanGenerate(false);
    }
  }

  function downloadPrivate() {
    const url = URL.createObjectURL(new Blob([privateKey], { type: "application/x-pem-file" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "mercavine-bot-private-key.pem";
    a.click();
    URL.revokeObjectURL(url);
  }

  async function onSubmit(formData: FormData) {
    setError("");
    if (!canSubmit) {
      setError(mcpOnly ? "" : !keyValid ? "Add a valid Ed25519 public key, or generate one." : "Confirm you saved your private key.");
      return;
    }
    const dollars = (key: string) => {
      const v = String(formData.get(key) ?? "").trim();
      return v ? Math.round(Number(v) * 100) : undefined;
    };
    const response = await fetch("/api/v1/bots", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Only the public key is sent. The private key lives in component state and never leaves the browser.
      body: JSON.stringify(
        buildBotPayload({
          name: formData.get("name"),
          scopes: GROUPS.map((g) => g.id).filter((id) => formData.get(`scope_${id}`)),
          per_order_limit_cents: dollars("per_order"),
          per_month_limit_cents: dollars("per_month"),
          public_key_pem: publicKey,
          mcp_only: mcpOnly,
        }),
      ),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      setError(body?.error?.message ?? "Could not connect the bot.");
      return;
    }
    setPrivateKey("");
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
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={mcpOnly} onChange={(e) => setMcpOnly(e.target.checked)} />
        <span>This bot only connects through the MCP link (like Grok Bot). It can&apos;t sign requests, so it won&apos;t be able to use the direct API.</span>
      </label>
      {!mcpOnly ? (
        <div className="space-y-3">
          <div className="space-y-2">
            <Label htmlFor="public_key_pem">Bot signing key (Ed25519 public key, required)</Label>
            <p className="text-xs text-[var(--muted)]">This proves requests really come from your bot. If you don&apos;t have one, let us make one for you.</p>
            <textarea
              id="public_key_pem"
              name="public_key_pem"
              rows={3}
              required
              aria-invalid={publicKey !== "" && !keyValid}
              aria-describedby="public_key_help"
              value={publicKey}
              onChange={(e) => setPublicKey(e.target.value)}
              className="w-full rounded-2xl border border-[var(--line)] bg-transparent p-3 text-sm"
              placeholder="-----BEGIN PUBLIC KEY-----"
            />
            <p id="public_key_help" className="text-xs text-[var(--muted)]">
              {publicKey === "" ? "Paste a public key that starts with -----BEGIN PUBLIC KEY-----." : keyValid ? "Looks good." : "That doesn't look like an Ed25519 public key."}
            </p>
            {canGenerate === false ? (
              <p className="text-xs text-[var(--danger)]">This browser can&apos;t make keys. Try a recent Chrome, Edge, Firefox or Safari, or paste a key you made yourself.</p>
            ) : (
              <Button type="button" variant="outline" onClick={generate} disabled={canGenerate === null}>Generate a key for me</Button>
            )}
          </div>
          {privateKey ? (
            <div className="space-y-2 rounded-2xl border border-[var(--danger)] p-4">
              <p className="text-sm font-medium">Save your private key now</p>
              <p className="text-sm text-[var(--muted)]">
                Your bot uses this secret key to sign its requests. It was made in your browser and Mercavine never sees it.
                We can&apos;t show it again or recover it. If you lose it, connect a new bot.
              </p>
              <textarea readOnly aria-label="Private key" rows={4} value={privateKey} className="w-full rounded-2xl border border-[var(--line)] bg-[var(--bg)] p-3 font-mono text-xs" />
              <div className="flex gap-2">
                <Button type="button" variant="outline" onClick={async () => { await navigator.clipboard.writeText(privateKey); setPrivCopied(true); }}>{privCopied ? "Copied" : "Copy private key"}</Button>
                <Button type="button" variant="outline" onClick={downloadPrivate}>Download .pem</Button>
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" required checked={savedPrivate} onChange={(e) => setSavedPrivate(e.target.checked)} /> I saved my private key
              </label>
            </div>
          ) : null}
        </div>
      ) : null}
      {error ? <p className="text-sm text-[var(--danger)]">{error}</p> : null}
      <Button type="submit" variant="vine" disabled={!canSubmit}>Connect bot</Button>
    </form>
  );
}
