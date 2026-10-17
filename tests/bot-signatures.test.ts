import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { useTempDb } from "./db";
import { handleApi } from "@/lib/api";
import { getDb } from "@/lib/db";
import { signBotRequest } from "@/lib/signatures";
import { handleMcp } from "@/lib/mcp";

const base = "http://127.0.0.1:4317";

async function signupCookie(email: string) {
  const res = await handleApi(new Request(`${base}/api/v1/users`, { method: "POST", headers: { "content-type": "application/json", origin: base, "x-forwarded-for": "10.7.7.7" }, body: JSON.stringify({ email, password: "correct horse battery staple", name: "T" }) }));
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}
function post(path: string, body: unknown, headers: Record<string, string> = {}) {
  return handleApi(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: base, ...headers }, body: JSON.stringify(body) }));
}
const code = async (r: Response) => ((await r.json()) as { error: { code: string } }).error.code;

afterEach(() => {
  delete process.env.MERCAVINE_BOT_SIGNATURE_ENFORCE_AFTER;
  delete process.env.MERCAVINE_REQUIRE_SIGNATURES;
});

describe("bot connection signing keys", () => {
  useTempDb();
  it("requires a valid Ed25519 key unless the bot is MCP-only", async () => {
    const cookie = await signupCookie("k@example.com");
    expect(await code(await post("/api/v1/bots", { scopes: ["shop"] }, { cookie }))).toBe("public_key_required");
    expect(await code(await post("/api/v1/bots", { scopes: ["shop"], public_key_pem: "nope" }, { cookie }))).toBe("invalid_public_key");
    const pub = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" }).toString();
    expect((await post("/api/v1/bots", { scopes: ["shop"], public_key_pem: pub }, { cookie })).status).toBe(201);
    expect((await post("/api/v1/bots", { scopes: ["shop"], mcp_only: true }, { cookie })).status).toBe(201);
  });

  it("enforces signatures on REST bot calls when enforcement is on, and rejects MCP-only tokens on REST", async () => {
    const cookie = await signupCookie("s@example.com");
    const pair = generateKeyPairSync("ed25519");
    const pub = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
    const priv = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const keyed = (await (await post("/api/v1/bots", { scopes: ["shop"], public_key_pem: pub }, { cookie })).json()) as { id: string; token: string };
    const mcp = (await (await post("/api/v1/bots", { scopes: ["shop"], mcp_only: true }, { cookie })).json()) as { token: string };
    // A legacy bot made before keys were required.
    const legacy = (await (await post("/api/v1/bots", { scopes: ["shop"], public_key_pem: pub }, { cookie })).json()) as { id: string; token: string };
    getDb().prepare(`UPDATE bots SET public_key_pem = NULL WHERE id = ?`).run(legacy.id);

    const url = `${base}/api/v1/products/search?q=hinge`;
    const get = (token: string, extra: Record<string, string> = {}) => handleApi(new Request(url, { headers: { authorization: `Bearer ${token}`, ...extra } }));

    expect(await code(await get(mcp.token))).toBe("mcp_only_connection");
    expect((await get(legacy.token)).status).toBe(200); // grace period before the enforcement date

    process.env.MERCAVINE_BOT_SIGNATURE_ENFORCE_AFTER = "2000-01-01";
    const unsigned = await get(keyed.token);
    expect(unsigned.status).toBe(401);
    expect(await code(unsigned)).toBe("signature_required");
    expect(await code(await get(legacy.token))).toBe("signature_key_missing");
    const sig = signBotRequest({ method: "GET", url, body: "", idempotencyKey: "", keyId: keyed.id, privateKeyPem: priv });
    expect((await get(keyed.token, { ...sig, "idempotency-key": "" })).status).toBe(200);
    const bad = await get(keyed.token, { ...sig, signature: "sig1=:AAAA:" });
    expect(bad.status).toBe(401);
    expect(await code(bad)).toBe("signature_invalid");

    // The /mcp path is unchanged: an unsigned MCP-only bearer token still works.
    const res = await handleMcp(new Request(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: `Bearer ${mcp.token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }));
    expect(res.status).toBe(200);
  });
});
