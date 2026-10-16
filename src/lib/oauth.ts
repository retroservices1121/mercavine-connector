import { createHash, timingSafeEqual } from "node:crypto";
import { createBot, SCOPE_GROUPS } from "./accounts";
import { botById, botByToken, type BotRecord } from "./auth";
import { addDays, addHours, addMinutes, now, nowIso } from "./clock";
import { config } from "./config";
import { getDb, transaction } from "./db";
import { newId, randomToken, sha256 } from "./ids";
import { one, run } from "./sql";

/**
 * OAuth 2.1 for the MCP endpoint, per the MCP authorization spec:
 * RFC 9728 (protected resource metadata), RFC 8414 (AS metadata), RFC 7591 (DCR),
 * RFC 7636 (PKCE S256 only), RFC 8707 (resource indicators), RFC 7009 (revocation).
 */

export const OAUTH_SCOPES = ["shop", "checkout", "track"] as const;
export const ACCESS_TOKEN_TTL_HOURS = 1;
export const REFRESH_TOKEN_TTL_DAYS = 30;
const CODE_TTL_MINUTES = 5;
const REQUEST_TTL_MINUTES = 10;

export function baseUrl(): string {
  return config().publicBaseUrl.replace(/\/+$/, "");
}
export function mcpResource(): string {
  return `${baseUrl()}/mcp`;
}
export function resourceMetadataUrl(): string {
  return `${baseUrl()}/.well-known/oauth-protected-resource`;
}

const CORS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-expose-headers": "www-authenticate",
  "access-control-max-age": "86400",
};

function json(status: number, body: unknown, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", pragma: "no-cache", ...CORS, ...extra },
  });
}
function oauthError(status: number, error: string, description: string): Response {
  return json(status, { error, error_description: description });
}

export function protectedResourceMetadata() {
  return {
    resource: mcpResource(),
    authorization_servers: [baseUrl()],
    scopes_supported: [...OAUTH_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: `${config().brandName} MCP`,
  };
}

export function authorizationServerMetadata() {
  const b = baseUrl();
  return {
    issuer: b,
    authorization_endpoint: `${b}/oauth/authorize`,
    token_endpoint: `${b}/oauth/token`,
    registration_endpoint: `${b}/oauth/register`,
    revocation_endpoint: `${b}/oauth/revoke`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    scopes_supported: [...OAUTH_SCOPES],
  };
}

/** 401 challenge for /mcp so clients (Grok's custom connector) can discover the authorization server. */
export function mcpChallenge(error?: "invalid_token"): Response {
  const parts = [`resource_metadata="${resourceMetadataUrl()}"`];
  if (error) parts.push(`error="${error}"`, `error_description="The access token is invalid or expired"`);
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message: "Authorization required. Sign in to Mercavine to connect." }, id: null }),
    { status: 401, headers: { "content-type": "application/json", "www-authenticate": `Bearer ${parts.join(", ")}`, ...CORS } },
  );
}

// ---------- clients (RFC 7591) ----------

type ClientRow = { client_id: string; client_secret_hash: string | null; client_name: string; redirect_uris: string; token_endpoint_auth_method: string };

export function isAllowedRedirectUri(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  if (u.hash) return false;
  if (u.protocol === "https:") return true;
  // Loopback for local development tools only.
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

function getClient(clientId: string): (Omit<ClientRow, "redirect_uris"> & { redirect_uris: string[] }) | undefined {
  const row = one<ClientRow>(getDb(), `SELECT * FROM oauth_clients WHERE client_id = ?`, clientId);
  return row ? { ...row, redirect_uris: JSON.parse(row.redirect_uris) as string[] } : undefined;
}

export function registerClient(body: Record<string, unknown>): Response {
  const uris = Array.isArray(body.redirect_uris) ? body.redirect_uris.map(String) : [];
  if (!uris.length || uris.some((u) => !isAllowedRedirectUri(u))) {
    return oauthError(400, "invalid_redirect_uri", "redirect_uris must be one or more https URLs (or http loopback for development).");
  }
  const method = String(body.token_endpoint_auth_method ?? "none");
  if (method !== "none" && method !== "client_secret_post") {
    return oauthError(400, "invalid_client_metadata", "token_endpoint_auth_method must be none or client_secret_post.");
  }
  const grants = Array.isArray(body.grant_types) ? body.grant_types.map(String) : ["authorization_code", "refresh_token"];
  if (grants.some((g) => g !== "authorization_code" && g !== "refresh_token")) {
    return oauthError(400, "invalid_client_metadata", "Only authorization_code and refresh_token grants are supported.");
  }
  const name = String(body.client_name ?? "").trim().slice(0, 80) || "MCP client";
  const clientId = `mvc_${randomToken(16)}`;
  const secret = method === "client_secret_post" ? `mvcs_${randomToken(32)}` : null;
  run(
    getDb(),
    `INSERT INTO oauth_clients (client_id, client_secret_hash, client_name, redirect_uris, token_endpoint_auth_method, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    clientId, secret ? sha256(secret) : null, name, JSON.stringify(uris), method, nowIso(),
  );
  // Grok's callback URL is not documented, so record what it registers (no secrets logged).
  console.info(`[oauth] registered client ${clientId} name=${JSON.stringify(name)} redirect_uris=${JSON.stringify(uris)} auth=${method}`);
  return json(201, {
    client_id: clientId,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: uris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    scope: OAUTH_SCOPES.join(" "),
  });
}

function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function authenticateClient(params: URLSearchParams) {
  const client = getClient(params.get("client_id") ?? "");
  if (!client) return undefined;
  if (client.token_endpoint_auth_method === "client_secret_post") {
    const secret = params.get("client_secret") ?? "";
    if (!client.client_secret_hash || !safeEq(sha256(secret), client.client_secret_hash)) return undefined;
  }
  return client;
}

// ---------- authorize ----------

export type AuthorizeCheck =
  | { ok: true; client: { client_id: string; client_name: string }; redirectUri: string; scopes: string[]; state: string | null; codeChallenge: string; resource: string | null }
  /** Client or redirect_uri can't be trusted: show an error page, never redirect. */
  | { ok: false; fatal: true; message: string }
  /** Safe to report back to the client's redirect_uri. */
  | { ok: false; fatal: false; redirect: string };

export function parseScopes(raw: string | null): string[] | null {
  if (!raw || !raw.trim()) return [...OAUTH_SCOPES];
  const s = [...new Set(raw.trim().split(/\s+/))];
  return s.every((x) => (OAUTH_SCOPES as readonly string[]).includes(x)) ? s : null;
}

function errorRedirect(redirectUri: string, error: string, description: string, state: string | null): string {
  const u = new URL(redirectUri);
  u.searchParams.set("error", error);
  u.searchParams.set("error_description", description);
  if (state) u.searchParams.set("state", state);
  u.searchParams.set("iss", baseUrl());
  return u.toString();
}

export function checkAuthorizeRequest(p: URLSearchParams): AuthorizeCheck {
  const client = getClient(p.get("client_id") ?? "");
  if (!client) return { ok: false, fatal: true, message: "Unknown app. Ask the app to reconnect." };
  const redirectUri = p.get("redirect_uri") ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  // Exact string match against a registered URI.
  if (!client.redirect_uris.includes(redirectUri)) return { ok: false, fatal: true, message: "This app's return address doesn't match what it registered." };
  const state = p.get("state");
  const back = (e: string, d: string): AuthorizeCheck => ({ ok: false, fatal: false, redirect: errorRedirect(redirectUri, e, d, state) });
  if (p.get("response_type") !== "code") return back("unsupported_response_type", "response_type must be code.");
  const challenge = p.get("code_challenge") ?? "";
  if (!challenge) return back("invalid_request", "PKCE code_challenge is required.");
  if (p.get("code_challenge_method") !== "S256") return back("invalid_request", "code_challenge_method must be S256.");
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) return back("invalid_request", "code_challenge is malformed.");
  const resource = p.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== mcpResource()) return back("invalid_target", `resource must be ${mcpResource()}.`);
  const scopes = parseScopes(p.get("scope"));
  if (!scopes) return back("invalid_scope", `scope must be from: ${OAUTH_SCOPES.join(" ")}.`);
  return { ok: true, client: { client_id: client.client_id, client_name: client.client_name }, redirectUri, scopes, state, codeChallenge: challenge, resource };
}

/** Stores a pending consent bound to the signed-in user; the consent form posts back its id. */
export function createConsentRequest(userId: string, check: Extract<AuthorizeCheck, { ok: true }>): string {
  const id = `oar_${randomToken(24)}`;
  run(
    getDb(),
    `INSERT INTO oauth_requests (id, client_id, user_id, redirect_uri, scopes, state, code_challenge, resource, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    id, check.client.client_id, userId, check.redirectUri, JSON.stringify(check.scopes), check.state, check.codeChallenge, check.resource,
    addMinutes(now(), REQUEST_TTL_MINUTES),
  );
  return id;
}

type RequestRow = { id: string; client_id: string; user_id: string; redirect_uri: string; scopes: string; state: string | null; code_challenge: string; resource: string | null; expires_at: string; used_at: string | null };

/** Returns the redirect URL to send the browser to, or null if the request is invalid. */
export function decideConsent(requestId: string, userId: string, approve: boolean): string | null {
  return transaction((db) => {
    const r = one<RequestRow>(db, `SELECT * FROM oauth_requests WHERE id = ?`, requestId);
    if (!r || r.user_id !== userId || r.used_at || r.expires_at < nowIso()) return null;
    run(db, `UPDATE oauth_requests SET used_at = ? WHERE id = ?`, nowIso(), r.id);
    if (!approve) return errorRedirect(r.redirect_uri, "access_denied", "The user denied access.", r.state);
    const client = getClient(r.client_id)!;
    const groups = JSON.parse(r.scopes) as string[];
    const bot = createBot(userId, { name: client.client_name, scopes: groups });
    run(db, `UPDATE bots SET mcp_only = 1 WHERE id = ?`, bot.id);
    const code = `mvac_${randomToken(32)}`;
    run(
      db,
      `INSERT INTO oauth_codes (code_hash, client_id, user_id, bot_id, redirect_uri, code_challenge, scopes, resource, family, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      sha256(code), r.client_id, userId, bot.id, r.redirect_uri, r.code_challenge, r.scopes, r.resource, newId("ofam"),
      addMinutes(now(), CODE_TTL_MINUTES),
    );
    const u = new URL(r.redirect_uri);
    u.searchParams.set("code", code);
    if (r.state) u.searchParams.set("state", r.state);
    u.searchParams.set("iss", baseUrl());
    return u.toString();
  });
}

// ---------- tokens ----------

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function issueTokens(family: string, clientId: string, botId: string, scopes: string, resource: string | null) {
  const access = `mvat_${randomToken(32)}`;
  const refresh = `mvrt_${randomToken(32)}`;
  const db = getDb();
  const at = nowIso();
  run(db, `INSERT INTO oauth_tokens (token_hash, kind, client_id, bot_id, scopes, resource, family, expires_at, created_at) VALUES (?, 'access', ?, ?, ?, ?, ?, ?, ?)`,
    sha256(access), clientId, botId, scopes, resource, family, addHours(now(), ACCESS_TOKEN_TTL_HOURS), at);
  run(db, `INSERT INTO oauth_tokens (token_hash, kind, client_id, bot_id, scopes, resource, family, expires_at, created_at) VALUES (?, 'refresh', ?, ?, ?, ?, ?, ?, ?)`,
    sha256(refresh), clientId, botId, scopes, resource, family, addDays(now(), REFRESH_TOKEN_TTL_DAYS), at);
  return {
    access_token: access,
    token_type: "Bearer",
    expires_in: ACCESS_TOKEN_TTL_HOURS * 3600,
    refresh_token: refresh,
    scope: (JSON.parse(scopes) as string[]).join(" "),
  };
}

function revokeFamily(family: string) {
  run(getDb(), `UPDATE oauth_tokens SET revoked_at = ? WHERE family = ? AND revoked_at IS NULL`, nowIso(), family);
}

async function readParams(req: Request): Promise<URLSearchParams> {
  const type = req.headers.get("content-type") ?? "";
  const text = await req.text();
  if (type.includes("application/json")) {
    try {
      const obj = JSON.parse(text) as Record<string, unknown>;
      return new URLSearchParams(Object.entries(obj).map(([k, v]) => [k, String(v)]));
    } catch {
      return new URLSearchParams();
    }
  }
  return new URLSearchParams(text);
}

type CodeRow = { code_hash: string; client_id: string; user_id: string; bot_id: string; redirect_uri: string; code_challenge: string; scopes: string; resource: string | null; family: string; expires_at: string; used_at: string | null };
type TokenRow = { token_hash: string; kind: string; client_id: string; bot_id: string; scopes: string; resource: string | null; family: string; expires_at: string; revoked_at: string | null };

export async function tokenEndpoint(req: Request): Promise<Response> {
  const p = await readParams(req);
  const client = authenticateClient(p);
  if (!client) return oauthError(401, "invalid_client", "Unknown client or bad client credentials.");
  const grant = p.get("grant_type");
  const resource = p.get("resource");
  if (resource && resource.replace(/\/+$/, "") !== mcpResource()) return oauthError(400, "invalid_target", `resource must be ${mcpResource()}.`);

  if (grant === "authorization_code") {
    const out = transaction((db) => {
      const code = one<CodeRow>(db, `SELECT * FROM oauth_codes WHERE code_hash = ?`, sha256(p.get("code") ?? ""));
      if (!code || code.client_id !== client.client_id) return oauthError(400, "invalid_grant", "Unknown authorization code.");
      if (code.used_at) {
        // Code replay: kill anything issued from it.
        revokeFamily(code.family);
        return oauthError(400, "invalid_grant", "Authorization code was already used.");
      }
      run(db, `UPDATE oauth_codes SET used_at = ? WHERE code_hash = ?`, nowIso(), code.code_hash);
      if (code.expires_at < nowIso()) return oauthError(400, "invalid_grant", "Authorization code expired.");
      if ((p.get("redirect_uri") ?? code.redirect_uri) !== code.redirect_uri) return oauthError(400, "invalid_grant", "redirect_uri does not match.");
      const verifier = p.get("code_verifier") ?? "";
      if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier) || !safeEq(s256(verifier), code.code_challenge)) {
        return oauthError(400, "invalid_grant", "PKCE verification failed.");
      }
      return json(200, issueTokens(code.family, client.client_id, code.bot_id, code.scopes, code.resource ?? mcpResource()));
    });
    return out;
  }

  if (grant === "refresh_token") {
    return transaction((db) => {
      const t = one<TokenRow>(db, `SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'`, sha256(p.get("refresh_token") ?? ""));
      if (!t || t.client_id !== client.client_id) return oauthError(400, "invalid_grant", "Unknown refresh token.");
      if (t.revoked_at) {
        // A rotated-out refresh token was replayed: revoke the whole chain.
        revokeFamily(t.family);
        return oauthError(400, "invalid_grant", "Refresh token was revoked.");
      }
      if (t.expires_at < nowIso()) return oauthError(400, "invalid_grant", "Refresh token expired.");
      const bot = botById(t.bot_id);
      if (!bot || bot.revoked_at) return oauthError(400, "invalid_grant", "This connection was revoked.");
      let scopes = t.scopes;
      const requested = p.get("scope");
      if (requested) {
        const want = parseScopes(requested);
        const had = JSON.parse(t.scopes) as string[];
        if (!want || want.some((s) => !had.includes(s))) return oauthError(400, "invalid_scope", "Cannot widen scope on refresh.");
        scopes = JSON.stringify(want);
      }
      run(db, `UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`, nowIso(), t.token_hash);
      return json(200, issueTokens(t.family, client.client_id, t.bot_id, scopes, t.resource));
    });
  }

  return oauthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

export async function revokeEndpoint(req: Request): Promise<Response> {
  const p = await readParams(req);
  const client = authenticateClient(p);
  if (!client) return oauthError(401, "invalid_client", "Unknown client or bad client credentials.");
  const t = one<TokenRow>(getDb(), `SELECT * FROM oauth_tokens WHERE token_hash = ?`, sha256(p.get("token") ?? ""));
  if (t && t.client_id === client.client_id) {
    // Revoking a refresh token ends the whole grant; an access token only itself.
    if (t.kind === "refresh") revokeFamily(t.family);
    else run(getDb(), `UPDATE oauth_tokens SET revoked_at = ? WHERE token_hash = ?`, nowIso(), t.token_hash);
  }
  return json(200, {}); // RFC 7009: same response whether or not the token existed.
}

/** Resolve an /mcp bearer: an OAuth access token, or a legacy bot token (unchanged). */
export function botForMcpToken(token: string): BotRecord | undefined {
  if (!token) return undefined;
  if (token.startsWith("mvat_")) {
    const t = one<TokenRow>(getDb(), `SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'access'`, sha256(token));
    if (!t || t.revoked_at || t.expires_at < nowIso()) return undefined;
    if (t.resource && t.resource !== mcpResource()) return undefined;
    const bot = botById(t.bot_id);
    if (!bot || bot.revoked_at) return undefined;
    const granted = (JSON.parse(t.scopes) as string[]).flatMap((g) => SCOPE_GROUPS[g] ?? []);
    return { ...bot, scopes: bot.scopes.filter((s) => granted.includes(s)) };
  }
  const bot = botByToken(token);
  return bot && !bot.revoked_at ? bot : undefined;
}

// ---------- routing ----------

export async function handleOauth(req: Request): Promise<Response> {
  const path = new URL(req.url).pathname.replace(/\/+$/, "");
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method === "GET" && (path === "/.well-known/oauth-protected-resource" || path === "/.well-known/oauth-protected-resource/mcp")) {
    return json(200, protectedResourceMetadata(), { "cache-control": "public, max-age=300" });
  }
  if (req.method === "GET" && (path === "/.well-known/oauth-authorization-server" || path === "/.well-known/oauth-authorization-server/mcp")) {
    return json(200, authorizationServerMetadata(), { "cache-control": "public, max-age=300" });
  }
  if (req.method === "POST" && path === "/oauth/register") {
    let body: Record<string, unknown> = {};
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return oauthError(400, "invalid_client_metadata", "Body must be JSON.");
    }
    return registerClient(body);
  }
  if (req.method === "POST" && path === "/oauth/token") return tokenEndpoint(req);
  if (req.method === "POST" && path === "/oauth/revoke") return revokeEndpoint(req);
  return oauthError(404, "not_found", "Not found.");
}
