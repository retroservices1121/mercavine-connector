/**
 * Dev/test-only demo identities. No secrets live in source: the password,
 * bot token, and bot keypair are generated fresh in each process (or read
 * from MERCAVINE_DEV_* env vars outside production). Demo rows are only
 * seeded when demoSeedEnabled() is true.
 */
import { generateKeyPairSync, randomBytes } from "node:crypto";

const isProd = process.env.NODE_ENV === "production";
const fromEnv = (name: string): string | undefined => (isProd ? undefined : process.env[name]?.trim() || undefined);

export function demoSeedEnabled(): boolean {
  const flag = process.env.MERCAVINE_SEED_DEMO?.trim();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  return process.env.NODE_ENV !== "production";
}

export const DEMO_USER_IDS = ["usr_jp", "usr_sam"] as const;
export const DEMO_BOT_IDS = ["bot_grok_jp"] as const;

const demoPassword = fromEnv("MERCAVINE_DEV_PASSWORD") ?? randomBytes(18).toString("base64url");

export const DEV_BOT_TOKEN: string = fromEnv("MERCAVINE_DEV_BOT_TOKEN") ?? `mv_test_${randomBytes(24).toString("hex")}`;

export const DEV_SHOPPER = {
  email: "jp@mercavine.test",
  password: demoPassword,
  name: "Jordan Pike",
  displayName: "JP",
};

export const DEV_OTHER_SHOPPER = {
  email: "sam@mercavine.test",
  password: demoPassword,
  name: "Sam Okonkwo",
  displayName: "Sam",
};

const pair = generateKeyPairSync("ed25519");
export const DEV_BOT_PUBLIC_KEY: string = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
export const DEV_BOT_PRIVATE_KEY: string = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
