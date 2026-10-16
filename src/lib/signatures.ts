import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { DEV_BOT_PRIVATE_KEY } from "./dev-keys";
import { ApiError } from "./errors";

/**
 * A practical subset of RFC 9421.
 * Covered components: @method, @target-uri, content-digest, idempotency-key.
 * The signature base is the RFC line format plus the @signature-params line
 * taken from the Signature-Input header. It is not a full HTTP-message-signatures
 * stack (no every derived component, no content-length negotiation).
 */

export type SignedHeaders = {
  "content-digest": string;
  "signature-input": string;
  signature: string;
};

function digest(body: string): string {
  return createHash("sha256").update(body).digest("base64");
}

export function signBotRequest(opts: {
  method: string;
  url: string;
  body: string;
  idempotencyKey: string;
  keyId: string;
  privateKeyPem?: string;
  created?: number;
}): SignedHeaders {
  const created = opts.created ?? Math.floor(Date.now() / 1000);
  const contentDigest = `sha-256=:${digest(opts.body)}:`;
  const params = `("@method" "@target-uri" "content-digest" "idempotency-key");created=${created};keyid="${opts.keyId}";alg="ed25519"`;
  const base = [
    `"@method": ${opts.method.toUpperCase()}`,
    `"@target-uri": ${opts.url}`,
    `"content-digest": ${contentDigest}`,
    `"idempotency-key": ${opts.idempotencyKey}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  const signature = sign(null, Buffer.from(base), createPrivateKey(opts.privateKeyPem ?? DEV_BOT_PRIVATE_KEY));
  return {
    "content-digest": contentDigest,
    "signature-input": `sig1=${params}`,
    signature: `sig1=:${signature.toString("base64")}:`,
  };
}

function header(req: Request, name: string): string {
  return req.headers.get(name) ?? "";
}

export async function verifyBotSignature(req: Request, rawBody: string, bot: { id: string; public_key_pem: string | null }): Promise<void> {
  const input = header(req, "signature-input");
  const sigHeader = header(req, "signature");
  if (!input && !sigHeader) {
    throw new ApiError(401, "signature_required", "This bot call needs an RFC 9421 HTTP message signature.");
  }
  if (!bot.public_key_pem) {
    throw new ApiError(401, "signature_required", "This bot has no registered signing key.");
  }
  const params = input.startsWith("sig1=") ? input.slice("sig1=".length) : "";
  const createdMatch = /created=(\d+)/.exec(params);
  const keyMatch = /keyid="([^"]+)"/.exec(params);
  if (!params || !createdMatch || !keyMatch) {
    throw new ApiError(401, "signature_invalid", "Signature-Input is missing created or keyid.");
  }
  if (keyMatch[1] !== bot.id) {
    throw new ApiError(401, "signature_invalid", "Signature keyid does not match this bot.");
  }
  const created = Number(createdMatch[1]);
  const age = Math.abs(Math.floor(Date.now() / 1000) - created);
  if (age > 300) {
    throw new ApiError(401, "signature_invalid", "Signature is older than 5 minutes.");
  }
  const contentDigest = header(req, "content-digest");
  const expectedDigest = `sha-256=:${digest(rawBody)}:`;
  if (contentDigest !== expectedDigest) {
    throw new ApiError(401, "signature_invalid", "Content-Digest does not match the body.");
  }
  const idem = header(req, "idempotency-key");
  const base = [
    `"@method": ${req.method.toUpperCase()}`,
    `"@target-uri": ${req.url}`,
    `"content-digest": ${contentDigest}`,
    `"idempotency-key": ${idem}`,
    `"@signature-params": ${params}`,
  ].join("\n");
  const sigMatch = /sig1=:([^:]+):/.exec(sigHeader);
  if (!sigMatch) throw new ApiError(401, "signature_invalid", "Signature header is missing sig1.");
  const ok = verify(
    null,
    Buffer.from(base),
    createPublicKey(bot.public_key_pem),
    Buffer.from(sigMatch[1], "base64"),
  );
  if (!ok) throw new ApiError(401, "signature_invalid", "Signature verification failed.");
}
