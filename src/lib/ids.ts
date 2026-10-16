import { createHash, randomBytes } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomBytes(9).toString("base64url")}`;
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

/** Approval tokens are `osa_` plus 32 CSPRNG bytes. Only the hash is stored. */
export function mintApprovalSecret(): { raw: string; hash: string } {
  const raw = `osa_${randomBytes(32).toString("base64url")}`;
  return { raw, hash: sha256(raw) };
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
