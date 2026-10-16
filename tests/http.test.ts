import { describe, expect, it } from "vitest";
import { handleApi } from "../src/lib/api";
import { DEV_BOT_PRIVATE_KEY, DEV_BOT_TOKEN, DEV_SHOPPER } from "../src/lib/dev-keys";
import { handleMcp } from "../src/lib/mcp";
import { signBotRequest } from "../src/lib/signatures";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";

function botHeaders(extra?: HeadersInit) {
  return {
    authorization: `Bearer ${DEV_BOT_TOKEN}`,
    accept: "application/json",
    ...extra,
  };
}

describe("http and mcp", () => {
  useTempDb();

  it("runs search, approval, and a paid order over HTTP, including a signed cart create", async () => {
    const health = await handleApi(new Request(`${base}/api/health`));
    expect(await health.json()).toMatchObject({ ok: true, brand: "Mercavine", payment_mode: "mock", fee_bps: 300 });

    const search = await handleApi(new Request(`${base}/api/v1/products/search?q=hinge`, { headers: botHeaders() }));
    expect(search.status).toBe(200);
    const found = (await search.json()) as { results: { title: string }[] };
    expect(found.results.some((product) => /hinge/i.test(product.title))).toBe(true);

    const body = JSON.stringify({
      lines: [{ offer_id: "ofr_brass_hinge", quantity: 1 }],
      shipping_address_id: "adr_home",
    });
    const idem = "signed-http-01";
    const url = `${base}/api/v1/carts`;
    const signed = signBotRequest({
      method: "POST",
      url,
      body,
      idempotencyKey: idem,
      keyId: "bot_grok_jp",
      privateKeyPem: DEV_BOT_PRIVATE_KEY,
    });
    const created = await handleApi(
      new Request(url, {
        method: "POST",
        headers: botHeaders({ "content-type": "application/json", "idempotency-key": idem, ...signed }),
        body,
      }),
    );
    expect(created.status).toBe(201);
    const cart = (await created.json()) as { id: string };
    const submitted = await handleApi(
      new Request(`${base}/api/v1/carts/${cart.id}/submit`, {
        method: "POST",
        headers: botHeaders({ "content-type": "application/json", "idempotency-key": "submit-http-01" }),
        body: "{}",
      }),
    );
    expect(submitted.status).toBe(200);
    const pending = (await submitted.json()) as { approval_url: string; status: string };
    expect(pending.status).toBe("pending_approval");
    const raw = pending.approval_url.split("/a/")[1];

    const session = await handleApi(
      new Request(`${base}/api/v1/session`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base },
        body: JSON.stringify({ email: DEV_SHOPPER.email, password: DEV_SHOPPER.password }),
      }),
    );
    expect(session.status).toBe(200);
    const cookie = session.headers.get("set-cookie")?.split(";")[0] ?? "";
    const approved = await handleApi(
      new Request(`${base}/api/v1/approvals/${encodeURIComponent(raw)}/approve`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: base, cookie },
        body: JSON.stringify({ method: "dev_step_up" }),
      }),
    );
    expect(approved.status).toBe(200);
    const receipt = (await approved.json()) as { paid: boolean; cart: { order_ids: string[] } };
    expect(receipt.paid).toBe(true);
    const order = await handleApi(new Request(`${base}/api/v1/orders/${receipt.cart.order_ids[0]}`, { headers: botHeaders() }));
    expect(order.status).toBe(200);
    expect(await order.json()).toMatchObject({ payment_status: "paid" });

    const hook = await handleApi(
      new Request(`${base}/api/v1/stripe/webhook`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ type: "payment_intent.succeeded", data: { object: { id: "pi_ignored", metadata: {} } } }),
      }),
    );
    expect(hook.status).toBe(200);
  });

  it("calls search_products over the MCP endpoint", async () => {
    const response = await handleMcp(
      new Request(`${base}/mcp`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${DEV_BOT_TOKEN}`,
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "search_products", arguments: { query: "hinge", limit: 5 } },
        }),
      }),
    );
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { result?: { content?: { text: string }[] }; error?: unknown };
    expect(payload.error).toBeUndefined();
    const data = JSON.parse(payload.result?.content?.[0]?.text ?? "{}") as { results: { title: string }[] };
    expect(data.results.some((product) => /hinge/i.test(product.title))).toBe(true);
  });
});
