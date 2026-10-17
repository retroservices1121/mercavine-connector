/** Browser-safe helpers for the "Generate a key for me" flow. No server imports. */

function toPem(label: string, der: ArrayBuffer): string {
  const bytes = new Uint8Array(der);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  const b64 = btoa(bin).replace(/(.{64})/g, "$1\n").trim();
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export async function ed25519Supported(subtle: SubtleCrypto | undefined = globalThis.crypto?.subtle): Promise<boolean> {
  if (!subtle) return false;
  try {
    await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    return true;
  } catch {
    return false;
  }
}

/** Generates an Ed25519 pair: public key as SPKI PEM (what the server stores), private key as PKCS8 PEM (stays with the user). */
export async function generateBotKeyPair(subtle: SubtleCrypto = globalThis.crypto.subtle): Promise<{ publicKeyPem: string; privateKeyPem: string }> {
  const pair = (await subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const spki = await subtle.exportKey("spki", pair.publicKey);
  const pkcs8 = await subtle.exportKey("pkcs8", pair.privateKey);
  return { publicKeyPem: toPem("PUBLIC KEY", spki), privateKeyPem: toPem("PRIVATE KEY", pkcs8) };
}

/** Light client-side check; the server does the authoritative Ed25519 parse. */
export function looksLikePublicKeyPem(value: string): boolean {
  const v = value.trim();
  if (/PRIVATE KEY/.test(v)) return false;
  const m = v.match(/^-----BEGIN PUBLIC KEY-----\s*([A-Za-z0-9+/=\s]+?)\s*-----END PUBLIC KEY-----$/);
  if (!m) return false;
  // Ed25519 SPKI DER is 44 bytes -> 60 base64 chars.
  return m[1].replace(/\s+/g, "").length === 60;
}

export type BotFormInput = {
  name: unknown;
  scopes: string[];
  per_order_limit_cents?: number;
  per_month_limit_cents?: number;
  public_key_pem?: string;
  mcp_only?: boolean;
};

/** The only thing the Connect form ever POSTs. A private key can never be part of it. */
export function buildBotPayload(input: BotFormInput): BotFormInput {
  const payload: BotFormInput = {
    name: input.name,
    scopes: input.scopes,
    per_order_limit_cents: input.per_order_limit_cents,
    per_month_limit_cents: input.per_month_limit_cents,
    mcp_only: Boolean(input.mcp_only),
    public_key_pem: input.mcp_only ? undefined : input.public_key_pem?.trim(),
  };
  if (JSON.stringify(payload).includes("PRIVATE KEY")) throw new Error("Refusing to send a private key.");
  return payload;
}
