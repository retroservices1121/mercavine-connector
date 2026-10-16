"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

async function call(path: string, method: string, body?: unknown) {
  const response = await fetch(path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? "{}" : JSON.stringify(body) });
  const json = await response.json().catch(() => ({}));
  return { ok: response.ok, json };
}

export function StripeButton({ connected }: { connected: boolean }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  async function go() {
    setPending(true);
    setError("");
    const { ok, json } = await call("/api/v1/seller/stripe/onboard", "POST");
    if (ok && typeof json.url === "string") {
      window.location.href = json.url;
      return;
    }
    setPending(false);
    setError(json?.error?.message ?? "Something went wrong. Please try again.");
  }
  return (
    <div>
      <Button variant="vine" onClick={go} disabled={pending}>{pending ? "Opening Stripe…" : connected ? "Continue Stripe setup" : "Set up payouts with Stripe"}</Button>
      {error ? <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
    </div>
  );
}

/** On return from Stripe (or on load), pull fresh status once. */
export function StripeRefresher({ enabled }: { enabled: boolean }) {
  const router = useRouter();
  useEffect(() => {
    if (!enabled) return;
    call("/api/v1/seller/stripe/refresh", "POST").then(({ ok }) => ok && router.refresh());
  }, [enabled, router]);
  return null;
}

type Product = { product_id: string; title: string; description: string; category: string; price_cents: number; stock: number; image_url: string | null };
const select = "flex h-11 w-full rounded-xl border border-[var(--line)] bg-white px-3 text-sm outline-none focus:border-[var(--vine)]";

export function ProductForm({ categories, product, onDone }: { categories: { slug: string; label: string }[]; product?: Product; onDone?: () => void }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const p = product ? `-${product.product_id}` : "-new";
  async function submit(form: FormData) {
    setPending(true);
    setError("");
    const body = Object.fromEntries(["title", "description", "category", "price", "stock", "image_url"].map((k) => [k, form.get(k) ?? ""]));
    const { ok, json } = product
      ? await call(`/api/v1/seller/products/${product.product_id}`, "PATCH", { ...body, stock: Number(body.stock) })
      : await call("/api/v1/seller/products", "POST", { ...body, stock: Number(body.stock) });
    setPending(false);
    if (!ok) {
      setError(json?.error?.message ?? "We couldn't save that product.");
      return;
    }
    onDone?.();
    router.refresh();
  }
  return (
    <form action={submit} className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1 sm:col-span-2"><Label htmlFor={`title${p}`}>Product name</Label><Input id={`title${p}`} name="title" defaultValue={product?.title} required /></div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`description${p}`}>Description</Label>
        <textarea id={`description${p}`} name="description" defaultValue={product?.description} required rows={3} className={`${select} h-auto py-2`} />
      </div>
      <div className="space-y-1"><Label htmlFor={`price${p}`}>Price (USD)</Label><Input id={`price${p}`} name="price" inputMode="decimal" defaultValue={product ? (product.price_cents / 100).toFixed(2) : ""} placeholder="24.99" required /></div>
      <div className="space-y-1"><Label htmlFor={`stock${p}`}>In stock</Label><Input id={`stock${p}`} name="stock" type="number" min={0} defaultValue={product?.stock ?? 1} required /></div>
      <div className="space-y-1">
        <Label htmlFor={`category${p}`}>Category</Label>
        <select id={`category${p}`} name="category" defaultValue={product?.category ?? ""} required className={select}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
        </select>
      </div>
      <div className="space-y-1"><Label htmlFor={`image${p}`}>Image link (optional)</Label><Input id={`image${p}`} name="image_url" type="url" placeholder="https://" defaultValue={product?.image_url ?? ""} /></div>
      {error ? <p role="alert" className="text-sm text-[var(--danger)] sm:col-span-2">{error}</p> : null}
      <div className="sm:col-span-2"><Button type="submit" variant="vine" disabled={pending}>{pending ? "Saving…" : product ? "Save changes" : "Add product"}</Button></div>
    </form>
  );
}

export function ProductRow({ product, categories, visible }: { product: Product; categories: { slug: string; label: string }[]; visible: boolean }) {
  const [editing, setEditing] = useState(false);
  return (
    <li className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{product.title}</p>
          <p className="text-sm text-[var(--muted)]">${(product.price_cents / 100).toFixed(2)} · {product.stock} in stock · {visible ? "Live" : "Hidden until payouts are ready"}</p>
        </div>
        <Button variant="outline" onClick={() => setEditing(!editing)} aria-expanded={editing}>{editing ? "Cancel" : "Edit"}</Button>
      </div>
      {editing ? <div className="mt-4"><ProductForm categories={categories} product={product} onDone={() => setEditing(false)} /></div> : null}
    </li>
  );
}
