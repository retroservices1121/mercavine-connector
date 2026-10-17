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

type Product = { product_id: string; title: string; description: string; category: string; price_cents: number; stock: number; image_url: string | null; unlisted?: boolean };
const select = "flex h-11 w-full rounded-xl border border-[var(--line)] bg-white px-3 text-sm outline-none focus:border-[var(--vine)]";
const LABELS: Record<string, string> = { title: "Product name", description: "Description", category: "Category", price: "Price", stock: "In stock", image_url: "Image link" };

export function ProductForm({ categories, product, onDone }: { categories: { slug: string; label: string }[]; product?: Product; onDone?: (message: string) => void }) {
  const router = useRouter();
  const [error, setError] = useState("");
  const [field, setField] = useState("");
  const [saved, setSaved] = useState("");
  const [pending, setPending] = useState(false);
  const [formKey, setFormKey] = useState(0);
  const p = product ? `-${product.product_id}` : "-new";
  const errId = `product-error${p}`;
  const inv = (f: string) => ({ "aria-invalid": field === f || undefined, "aria-describedby": field === f ? errId : undefined });
  async function submit(form: FormData) {
    setPending(true);
    setError("");
    setField("");
    setSaved("");
    const body = Object.fromEntries(["title", "description", "category", "price", "stock", "image_url"].map((k) => [k, form.get(k) ?? ""]));
    const { ok, json } = product
      ? await call(`/api/v1/seller/products/${product.product_id}`, "PATCH", { ...body, stock: Number(body.stock) })
      : await call("/api/v1/seller/products", "POST", { ...body, stock: Number(body.stock) });
    setPending(false);
    if (!ok) {
      setError(json?.error?.message ?? "We couldn't save that product. Please check the details and try again.");
      setField(typeof json?.error?.field === "string" ? json.error.field : "");
      return;
    }
    const message = product ? `Saved changes to ${json.title ?? "your product"}.` : `Product added: ${json.title ?? "your product"}.`;
    if (product) onDone?.(message);
    else {
      setSaved(message);
      setFormKey((k) => k + 1); // fresh, empty add form
    }
    router.refresh();
  }
  return (
    <form key={formKey} action={submit} className="grid gap-3 sm:grid-cols-2">
      {saved ? <p role="status" className="rounded-xl bg-[#e3efe0] px-3 py-2 text-sm text-[var(--vine)] sm:col-span-2">{saved}</p> : null}
      <div className="space-y-1 sm:col-span-2"><Label htmlFor={`title${p}`}>Product name</Label><Input id={`title${p}`} name="title" defaultValue={product?.title} required {...inv("title")} /></div>
      <div className="space-y-1 sm:col-span-2">
        <Label htmlFor={`description${p}`}>Description</Label>
        <textarea id={`description${p}`} name="description" defaultValue={product?.description} required rows={3} className={`${select} h-auto py-2`} {...inv("description")} />
      </div>
      <div className="space-y-1"><Label htmlFor={`price${p}`}>Price (USD)</Label><Input id={`price${p}`} name="price" inputMode="decimal" defaultValue={product ? (product.price_cents / 100).toFixed(2) : ""} placeholder="24.99" required {...inv("price")} /></div>
      <div className="space-y-1"><Label htmlFor={`stock${p}`}>In stock</Label><Input id={`stock${p}`} name="stock" type="number" min={0} defaultValue={product?.stock ?? 1} required {...inv("stock")} /></div>
      <div className="space-y-1">
        <Label htmlFor={`category${p}`}>Category</Label>
        <select id={`category${p}`} name="category" defaultValue={product?.category ?? ""} required className={select} {...inv("category")}>
          <option value="" disabled>Choose a category</option>
          {categories.map((c) => <option key={c.slug} value={c.slug}>{c.label}</option>)}
        </select>
      </div>
      <div className="space-y-1"><Label htmlFor={`image${p}`}>Image link (optional)</Label><Input id={`image${p}`} name="image_url" type="url" placeholder="https://" defaultValue={product?.image_url ?? ""} {...inv("image_url")} /></div>
      {error ? <p id={errId} role="alert" className="text-sm text-[var(--danger)] sm:col-span-2">{field ? `${LABELS[field] ?? "Form"}: ` : ""}{error}</p> : null}
      <div className="flex flex-wrap gap-2 sm:col-span-2">
        <Button type="submit" variant="vine" disabled={pending}>{pending ? "Saving…" : product ? "Save changes" : "Add product"}</Button>
        {product && onDone ? <Button type="button" variant="outline" onClick={() => onDone("")}>Cancel</Button> : null}
      </div>
    </form>
  );
}

export function ProductRow({ product, categories, visible }: { product: Product; categories: { slug: string; label: string }[]; visible: boolean }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  async function remove() {
    setPending(true);
    setError("");
    const { ok, json } = await call(`/api/v1/seller/products/${product.product_id}`, "DELETE");
    setPending(false);
    setConfirming(false);
    if (!ok) return setError(json?.error?.message ?? "We couldn't remove that product. Please try again.");
    setNotice(json.result === "unlisted" ? "Unlisted. It's hidden from shoppers and kept for your order history." : "Deleted.");
    router.refresh();
  }
  async function relist() {
    setPending(true);
    setError("");
    const { ok, json } = await call(`/api/v1/seller/products/${product.product_id}/relist`, "POST");
    setPending(false);
    if (!ok) return setError(json?.error?.message ?? "We couldn't relist that product. Please try again.");
    setNotice("Relisted.");
    router.refresh();
  }
  const status = product.unlisted ? "Unlisted" : visible ? "Live" : "Hidden until payouts are ready";
  return (
    <li className="rounded-2xl border border-[var(--line)] bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="font-medium">{product.title}</p>
          <p className="text-sm text-[var(--muted)]">${(product.price_cents / 100).toFixed(2)} · {product.stock} in stock · {status}</p>
        </div>
        {!editing && !confirming ? (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => { setEditing(true); setNotice(""); }}>Edit</Button>
            {product.unlisted
              ? <Button variant="outline" disabled={pending} onClick={relist}>Relist</Button>
              : <Button variant="outline" disabled={pending} onClick={() => setConfirming(true)}>Remove</Button>}
          </div>
        ) : null}
      </div>
      {confirming ? (
        <div role="alertdialog" aria-labelledby={`confirm-${product.product_id}`} className="mt-3 rounded-xl border border-[var(--line)] bg-[var(--paper)] p-3 text-sm">
          <p id={`confirm-${product.product_id}`}>Remove {product.title}? Shoppers won&apos;t see it anymore. If it&apos;s in any orders, we&apos;ll unlist it instead so your order history stays intact.</p>
          <div className="mt-3 flex gap-2">
            <Button variant="vine" disabled={pending} onClick={remove}>{pending ? "Removing…" : "Yes, remove it"}</Button>
            <Button variant="outline" disabled={pending} onClick={() => setConfirming(false)}>Keep it</Button>
          </div>
        </div>
      ) : null}
      {notice ? <p role="status" className="mt-2 text-sm text-[var(--vine)]">{notice}</p> : null}
      {error ? <p role="alert" className="mt-2 text-sm text-[var(--danger)]">{error}</p> : null}
      {editing ? <div className="mt-4"><ProductForm categories={categories} product={product} onDone={(m) => { setEditing(false); setNotice(m); }} /></div> : null}
    </li>
  );
}
