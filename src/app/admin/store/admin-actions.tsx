"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

async function call(path: string, method: string, body?: unknown) {
  const res = await fetch(path, { method, credentials: "same-origin", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `HTTP ${res.status}`);
  return json;
}

export function AdminLogin() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [err, setErr] = useState("");
  return (
    <form className="mt-4 space-y-3" onSubmit={async (e) => {
      e.preventDefault(); setErr("");
      try { await call("/api/v1/admin/session", "POST", { token }); setToken(""); router.refresh(); } catch (x) { setErr((x as Error).message); }
    }}>
      <label className="block text-sm">Admin token
        <input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} className="mt-1 w-full rounded-xl border p-2" />
      </label>
      <button className="rounded-full bg-[var(--vine)] px-4 py-2 text-[#f4efe4]">Sign in</button>
      {err && <p className="text-sm text-red-700">{err}</p>}
    </form>
  );
}

export function SignOut() {
  const router = useRouter();
  return <button className="text-sm underline" onClick={async () => { await call("/api/v1/admin/session", "DELETE").catch(() => {}); router.refresh(); }}>Sign out</button>;
}

export function OrderActions({ id, live }: { id: string; live: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const act = async (kind: "approve" | "reject") => {
    if (kind === "approve" && !confirm(live ? "Capture payment and create a LIVE CJ order?" : "Capture payment (dry-run, nothing sent to CJ)?")) return;
    const reason = kind === "reject" ? prompt("Reason for rejecting (voids the payment hold):") : "";
    if (reason === null) return;
    setBusy(true); setMsg("");
    try { const r = await call(`/api/v1/admin/supplier-orders/${encodeURIComponent(id)}/${kind}`, "POST", { reason }); setMsg(`Done: ${r.status ?? "ok"}`); router.refresh(); }
    catch (x) { setMsg((x as Error).message); } finally { setBusy(false); }
  };
  return (
    <div className="mt-3 flex items-center gap-2">
      <button disabled={busy} onClick={() => act("approve")} className="rounded-full bg-[var(--vine)] px-4 py-2 text-[#f4efe4] disabled:opacity-50">Approve</button>
      <button disabled={busy} onClick={() => act("reject")} className="rounded-full border px-4 py-2 disabled:opacity-50">Reject</button>
      {msg && <span>{msg}</span>}
    </div>
  );
}
