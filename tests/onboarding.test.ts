import { describe, expect, it } from "vitest";
import { addressStepNext } from "@/lib/onboarding";

describe("buyer onboarding address step", () => {
  it("advances to the account page once a default address exists during onboarding", () => {
    expect(addressStepNext({ onboarding: true, hasDefault: true })).toBe("/account");
  });
  it("stays on the step when no default address exists yet", () => {
    expect(addressStepNext({ onboarding: true, hasDefault: false })).toBeNull();
  });
  it("does not redirect when managing addresses outside onboarding", () => {
    expect(addressStepNext({ onboarding: false, hasDefault: true })).toBeNull();
  });
});


import { createPublicKey } from "node:crypto";
import { buildBotPayload, ed25519Supported, generateBotKeyPair, looksLikePublicKeyPem } from "@/lib/bot-keys";

describe("Generate a key for me", () => {
  it("makes an SPKI public PEM the server accepts and a PKCS8 private PEM", async () => {
    expect(await ed25519Supported()).toBe(true);
    const pair = await generateBotKeyPair();
    expect(pair.publicKeyPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    expect(pair.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);
    expect(createPublicKey(pair.publicKeyPem).asymmetricKeyType).toBe("ed25519");
    expect(looksLikePublicKeyPem(pair.publicKeyPem)).toBe(true);
    expect(looksLikePublicKeyPem(pair.privateKeyPem)).toBe(false);
    expect(looksLikePublicKeyPem("hello")).toBe(false);
  });

  it("submit payload carries only the public key, never the private key", async () => {
    const pair = await generateBotKeyPair();
    const body = JSON.stringify(buildBotPayload({ name: "b", scopes: ["shop"], public_key_pem: pair.publicKeyPem }));
    expect(body).toContain("BEGIN PUBLIC KEY");
    expect(body).not.toContain("PRIVATE KEY");
    expect(Object.keys(JSON.parse(body)).sort()).toEqual(["mcp_only", "name", "public_key_pem", "scopes"]);
    expect(() => buildBotPayload({ name: "b", scopes: ["shop"], public_key_pem: pair.privateKeyPem })).toThrow();
    expect(await ed25519Supported(undefined as unknown as SubtleCrypto)).toBeDefined();
  });
});
