import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { botByToken } from "../src/lib/auth";
import { approveCart, createCart, setApprovalBillingRegion, submitCart } from "../src/lib/cart";
import { setNow } from "../src/lib/clock";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { assetsDir, consumeDownload, deliverDigitalForCart, safeFilename, saveDigitalAsset } from "../src/lib/digital";
import { clearMailOutbox, mailOutbox } from "../src/lib/mailer";
import { GET as download } from "../src/app/dl/[token]/route";
import { useTempDb } from "./db";

const key = (l: string) => `${l}-${Math.random().toString(36).slice(2, 10)}`;
function bot() {
  const row = botByToken(DEV_BOT_TOKEN);
  if (!row) throw new Error("seed bot missing");
  return row;
}
const FILE = new TextEncoder().encode("%PDF-1.4 hello buyer");

function digitalOffer() {
  getDb().prepare(`UPDATE offers SET fulfillment_type = 'digital', shipping_cents = 0, eta_min_days = 0, eta_max_days = 0 WHERE id = 'ofr_tape'`).run();
  return getDb().prepare(`SELECT product_id, seller_id FROM offers WHERE id = 'ofr_tape'`).get() as { product_id: string; seller_id: string };
}

async function buyDigital() {
  const offer = digitalOffer();
  saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "Field Guide.pdf", bytes: FILE });
  getDb().prepare(`DELETE FROM addresses WHERE user_id = 'usr_jp'`).run();
  clearMailOutbox();
  const cart = createCart({ bot: bot(), lines: [{ offer_id: "ofr_tape", quantity: 1 }], idempotencyKey: key("c") }).body as { id: string };
  const sub = submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("s") }).body as { approval_url: string };
  const raw = sub.approval_url.split("/a/")[1];
  setApprovalBillingRegion(raw, "usr_jp", "GA");
  const paid = await approveCart({ rawToken: raw, userId: "usr_jp", method: "dev_step_up" });
  expect(paid.paid).toBe(true);
  const mail = mailOutbox().filter((m) => m.tag === "digital_delivery");
  expect(mail).toHaveLength(1);
  const token = /\/dl\/(dl_[A-Za-z0-9_-]+)/.exec(mail[0].text)![1];
  const order = getDb().prepare(`SELECT id, status FROM orders WHERE cart_id = ?`).get(cart.id) as { id: string; status: string };
  return { cartId: cart.id, token, order };
}

describe("digital delivery", () => {
  useTempDb();

  it("stores files privately with size and sha256, and validates type and size", () => {
    const offer = digitalOffer();
    const saved = saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "../../evil name.pdf", bytes: FILE });
    expect(saved.filename).toBe("evil name.pdf");
    expect(saved.size_bytes).toBe(FILE.byteLength);
    expect(saved.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(assetsDir()).not.toContain("public");
    const row = getDb().prepare(`SELECT storage_name FROM digital_assets WHERE product_id = ?`).get(offer.product_id) as { storage_name: string };
    expect(readFileSync(`${assetsDir()}/${row.storage_name}`)).toEqual(Buffer.from(FILE));
    expect(() => saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "x.exe", bytes: FILE })).toThrowError(expect.objectContaining({ code: "invalid_file" }));
    expect(() => saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "x.html", bytes: FILE })).toThrowError(expect.objectContaining({ code: "invalid_file" }));
    expect(() => saveDigitalAsset({ sellerId: offer.seller_id, productId: offer.product_id, filename: "x.pdf", bytes: new Uint8Array() })).toThrowError(expect.objectContaining({ code: "invalid_file" }));
    expect(() => saveDigitalAsset({ sellerId: "sel_other", productId: offer.product_id, filename: "x.pdf", bytes: FILE })).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(safeFilename('a"b\\c.pdf')).toBe("c.pdf");
  });

  it("refuses to submit a digital line with no file", () => {
    digitalOffer();
    const cart = createCart({ bot: bot(), lines: [{ offer_id: "ofr_tape", quantity: 1 }], shippingAddressId: "adr_home", idempotencyKey: key("c") }).body as { id: string };
    expect(() => submitCart({ bot: bot(), cartId: cart.id, idempotencyKey: key("s") })).toThrowError(expect.objectContaining({ code: "digital_file_missing" }));
  });

  it("emails one link per order after payment, stores only the token hash, and is idempotent", async () => {
    const { cartId, token } = await buyDigital();
    const rows = getDb().prepare(`SELECT token_hash, max_downloads, emailed_at, expires_at FROM digital_downloads`).all() as { token_hash: string; max_downloads: number; emailed_at: string | null; expires_at: string }[];
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0].max_downloads).toBe(5);
    expect(rows[0].emailed_at).not.toBeNull();
    expect(Date.parse(rows[0].expires_at) - Date.now()).toBeGreaterThan(71 * 3600_000);
    expect(await deliverDigitalForCart(cartId)).toEqual({ minted: 0, emailed: 0 });
    expect(mailOutbox().filter((m) => m.tag === "digital_delivery")).toHaveLength(1);
  });

  it("downloads stream as an attachment, count down, and mark the order fulfilled on first download", async () => {
    const { token, order } = await buyDigital();
    expect(order.status).toBe("created");
    const res = await download(new Request(`http://x/dl/${token}`), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain('attachment; filename="Field Guide.pdf"');
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(FILE);
    expect((getDb().prepare(`SELECT status FROM orders WHERE id = ?`).get(order.id) as { status: string }).status).toBe("fulfilled");
    for (let i = 0; i < 4; i++) consumeDownload(token);
    expect(() => consumeDownload(token)).toThrowError(expect.objectContaining({ code: "download_limit" }));
    const log = getDb().prepare(`SELECT outcome FROM digital_download_log ORDER BY at`).all() as { outcome: string }[];
    expect(log.filter((l) => l.outcome === "ok")).toHaveLength(5);
    expect(log.some((l) => l.outcome === "limit")).toBe(true);
  });

  it("blocks downloads for refunded or disputed orders, expired links, and unknown tokens", async () => {
    const { token, order } = await buyDigital();
    getDb().prepare(`UPDATE orders SET payment_status = 'disputed' WHERE id = ?`).run(order.id);
    expect(() => consumeDownload(token)).toThrowError(expect.objectContaining({ code: "download_blocked" }));
    getDb().prepare(`UPDATE orders SET payment_status = 'refunded' WHERE id = ?`).run(order.id);
    const res = await download(new Request(`http://x/dl/${token}`), { params: Promise.resolve({ token }) });
    expect(res.status).toBe(403);
    getDb().prepare(`UPDATE orders SET payment_status = 'paid' WHERE id = ?`).run(order.id);
    setNow(new Date(Date.now() + 73 * 3600_000));
    expect(() => consumeDownload(token)).toThrowError(expect.objectContaining({ code: "download_expired" }));
    setNow(null);
    expect(() => consumeDownload("dl_doesnotexistdoesnotexist")).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(() => consumeDownload("../../etc/passwd")).toThrowError(expect.objectContaining({ code: "not_found" }));
    expect(existsSync(assetsDir())).toBe(true);
  });
});
