import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { handleApi } from "../src/lib/api";
import { revokeBot, userFromSessionToken } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { DEV_BOT_TOKEN } from "../src/lib/dev-keys";
import { handleMcp } from "../src/lib/mcp";
import { checkAuthorizeRequest, createConsentRequest, handleOauth } from "../src/lib/oauth";
import { POST as decisionPost } from "../src/app/oauth/authorize/decision/route";
import { useTempDb } from "./db";

const base = "http://127.0.0.1:4317";
const REDIRECT = "https://grok.com/connectors/oauth/callback";

const get = (path: string) => handleOauth(new Request(`${base}${path}`));
const form = (path: string, params: Record<string, string>) =>
  handleOauth(new Request(`${base}${path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }));
const register = async (body: Record<string, unknown> = {}) =>
  handleOauth(new Request(`${base}/oauth/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Grok", redirect_uris: [REDIRECT], ...body }) }));

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

let ipSeq = 0;
async function user() {
  ipSeq += 1;
  const res = await handleApi(new Request(`${base}/api/v1/users`, { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `10.3.0.${ipSeq}` }, body: JSON.stringify({ email: `o${Math.random()}@example.com`, password: "correct-horse-battery", name: "O" }) }));
  const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
  return { cookie, id: userFromSessionToken(decodeURIComponent(cookie.split("=")[1]))!.id };
}

function mcp(token?: string, method = "initialize") {
  return handleMcp(new Request(`${base}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(method === "initialize"
      ? { jsonrpc: "2.0", id: 1, method, params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } }
      : { jsonrpc: "2.0", id: 1, method, params: {} }),
  }));
}

/** Runs DCR + authorize + consent (through the real decision route) and returns a code. */
async function authorize(opts: { redirect?: string; challenge?: string } = {}) {
  const client = (await (await register()).json()) as { client_id: string };
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: opts.redirect ?? REDIRECT, code_challenge: opts.challenge ?? challenge, code_challenge_method: "S256", state: "xyz", scope: "shop checkout", resource: `${base}/mcp` });
  const check = checkAuthorizeRequest(params);
  if (!check.ok) return { client, verifier, check, code: "" };
  const u = await user();
  const rid = createConsentRequest(u.id, check);
  const res = await decisionPost(new Request(`${base}/oauth/authorize/decision`, { method: "POST", headers: { cookie: u.cookie, origin: base, host: "127.0.0.1:4317", "content-type": "application/x-www-form-urlencoded" }, body: `request_id=${rid}&decision=approve` }));
  const loc = new URL(res.headers.get("location")!);
  return { client, verifier, check, u, rid, loc, code: loc.searchParams.get("code")! };
}

describe("MCP OAuth 2.1", () => {
  useTempDb();

  it("serves discovery metadata with CORS", async () => {
    const prm = await get("/.well-known/oauth-protected-resource");
    expect(prm.headers.get("access-control-allow-origin")).toBe("*");
    expect(await prm.json()).toMatchObject({ resource: `${base}/mcp`, authorization_servers: [base] });
    const as = (await (await get("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as).toMatchObject({
      issuer: base,
      authorization_endpoint: `${base}/oauth/authorize`,
      token_endpoint: `${base}/oauth/token`,
      registration_endpoint: `${base}/oauth/register`,
      revocation_endpoint: `${base}/oauth/revoke`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      scopes_supported: ["shop", "checkout", "track"],
    });
    const pre = await handleOauth(new Request(`${base}/oauth/token`, { method: "OPTIONS" }));
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-methods")).toContain("POST");
  });

  it("challenges unauthenticated /mcp, including initialize", async () => {
    for (const m of ["initialize", "tools/list"]) {
      const res = await mcp(undefined, m);
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"`);
    }
    const bad = await mcp("mvat_nope");
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("keeps legacy bot tokens working on /mcp", async () => {
    expect((await mcp(DEV_BOT_TOKEN)).status).toBe(200);
  });

  it("registers clients and rejects non-https redirect URIs", async () => {
    const res = await register();
    expect(res.status).toBe(201);
    const c = (await res.json()) as { client_id: string; client_secret?: string };
    expect(c.client_id).toMatch(/^mvc_/);
    expect(c.client_secret).toBeUndefined();
    expect((await register({ redirect_uris: ["http://evil.example/cb"] })).status).toBe(400);
    const conf = (await (await register({ token_endpoint_auth_method: "client_secret_post" })).json()) as { client_secret: string };
    expect(conf.client_secret).toMatch(/^mvcs_/);
    const stored = getDb().prepare(`SELECT client_secret_hash FROM oauth_clients WHERE client_secret_hash IS NOT NULL`).get() as { client_secret_hash: string };
    expect(stored.client_secret_hash).not.toContain("mvcs_");
  });

  it("refuses a wrong redirect_uri without redirecting, and missing PKCE via redirect", async () => {
    const wrong = await authorize({ redirect: "https://grok.com/other" });
    expect(wrong.check).toMatchObject({ ok: false, fatal: true });
    const client = (await (await register()).json()) as { client_id: string };
    const noPkce = checkAuthorizeRequest(new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, state: "s" }));
    expect(noPkce.ok).toBe(false);
    if (!noPkce.ok && !noPkce.fatal) expect(new URL(noPkce.redirect).searchParams.get("error")).toBe("invalid_request");
    const plain = checkAuthorizeRequest(new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: "a".repeat(43), code_challenge_method: "plain" }));
    expect(plain).toMatchObject({ ok: false, fatal: false });
  });

  it("full flow: consent creates an MCP-only bot, PKCE enforced, code single-use, refresh rotates, revocation works", async () => {
    const a = await authorize();
    expect(a.loc!.searchParams.get("state")).toBe("xyz");
    expect(a.loc!.origin + a.loc!.pathname).toBe(REDIRECT);
    const bot = getDb().prepare(`SELECT id, name, mcp_only, scopes FROM bots WHERE user_id = ?`).get(a.u!.id) as { id: string; name: string; mcp_only: number; scopes: string };
    expect(bot).toMatchObject({ name: "Grok", mcp_only: 1 });
    expect(JSON.parse(bot.scopes)).toEqual(["search", "cart", "buy", "addresses:read"]);

    const token = (params: Record<string, string>) => form("/oauth/token", { client_id: a.client.client_id, ...params });
    // PKCE failure (and the failed attempt burns the code).
    const badPkce = await token({ grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, code_verifier: pkce().verifier });
    expect(badPkce.status).toBe(400);
    expect(((await badPkce.json()) as { error: string }).error).toBe("invalid_grant");

    const b = await authorize();
    const tokenB = (params: Record<string, string>) => form("/oauth/token", { client_id: b.client.client_id, ...params });
    const wrongRedirect = await tokenB({ grant_type: "authorization_code", code: b.code, redirect_uri: "https://grok.com/other", code_verifier: b.verifier });
    expect(wrongRedirect.status).toBe(400);

    const c = await authorize();
    const tokenC = (params: Record<string, string>) => form("/oauth/token", { client_id: c.client.client_id, ...params });
    const ok = await tokenC({ grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier, resource: `${base}/mcp` });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
    const t1 = (await ok.json()) as { access_token: string; refresh_token: string; expires_in: number; scope: string };
    expect(t1).toMatchObject({ expires_in: 3600, scope: "shop checkout" });
    const rows = getDb().prepare(`SELECT token_hash FROM oauth_tokens`).all() as { token_hash: string }[];
    expect(JSON.stringify(rows)).not.toContain(t1.access_token);

    // Code reuse fails and kills the tokens it issued.
    const reuse = await tokenC({ grant_type: "authorization_code", code: c.code, redirect_uri: REDIRECT, code_verifier: c.verifier });
    expect(reuse.status).toBe(400);
    expect((await mcp(t1.access_token)).status).toBe(401);

    // Fresh grant for rotation and revocation.
    const d = await authorize();
    const tokenD = (params: Record<string, string>) => form("/oauth/token", { client_id: d.client.client_id, ...params });
    const t2 = (await (await tokenD({ grant_type: "authorization_code", code: d.code, redirect_uri: REDIRECT, code_verifier: d.verifier })).json()) as { access_token: string; refresh_token: string };
    expect((await mcp(t2.access_token)).status).toBe(200);
    const listed = (await (await mcp(t2.access_token, "tools/list")).json()) as { result: { tools: unknown[] } };
    expect(listed.result.tools.length).toBeGreaterThan(0);

    const r1 = await tokenD({ grant_type: "refresh_token", refresh_token: t2.refresh_token });
    expect(r1.status).toBe(200);
    const t3 = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(t3.refresh_token).not.toBe(t2.refresh_token);
    // Replaying the rotated refresh token revokes the whole family.
    expect((await tokenD({ grant_type: "refresh_token", refresh_token: t2.refresh_token })).status).toBe(400);
    expect((await mcp(t3.access_token)).status).toBe(401);
    expect((await tokenD({ grant_type: "refresh_token", refresh_token: t3.refresh_token })).status).toBe(400);

    // RFC 7009 revocation.
    const e = await authorize();
    const tokenE = (params: Record<string, string>) => form("/oauth/token", { client_id: e.client.client_id, ...params });
    const t4 = (await (await tokenE({ grant_type: "authorization_code", code: e.code, redirect_uri: REDIRECT, code_verifier: e.verifier })).json()) as { access_token: string; refresh_token: string };
    expect((await form("/oauth/revoke", { client_id: e.client.client_id, token: t4.refresh_token })).status).toBe(200);
    expect((await mcp(t4.access_token)).status).toBe(401);

    // Revoking the bot on /account/bots kills its tokens.
    const f = await authorize();
    const tokenF = (params: Record<string, string>) => form("/oauth/token", { client_id: f.client.client_id, ...params });
    const t5 = (await (await tokenF({ grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier })).json()) as { access_token: string; refresh_token: string };
    const fBot = getDb().prepare(`SELECT id FROM bots WHERE user_id = ?`).get(f.u!.id) as { id: string };
    revokeBot(fBot.id, f.u!.id);
    expect((await mcp(t5.access_token)).status).toBe(401);
    expect((await tokenF({ grant_type: "refresh_token", refresh_token: t5.refresh_token })).status).toBe(400);
  });

  it("deny returns access_denied with state, and a consent request can't be replayed", async () => {
    const client = (await (await register()).json()) as { client_id: string };
    const check = checkAuthorizeRequest(new URLSearchParams({ response_type: "code", client_id: client.client_id, redirect_uri: REDIRECT, code_challenge: pkce().challenge, code_challenge_method: "S256", state: "s1" }));
    if (!check.ok) throw new Error("expected ok");
    const u = await user();
    const rid = createConsentRequest(u.id, check);
    const post = () => decisionPost(new Request(`${base}/oauth/authorize/decision`, { method: "POST", headers: { cookie: u.cookie, origin: base, host: "127.0.0.1:4317", "content-type": "application/x-www-form-urlencoded" }, body: `request_id=${rid}&decision=deny` }));
    const loc = new URL((await post()).headers.get("location")!);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("state")).toBe("s1");
    expect((await post()).status).toBe(400);
  });
});
