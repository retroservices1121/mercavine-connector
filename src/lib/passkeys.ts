import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import { config } from "./config";
import { addMinutes, nowIso } from "./clock";
import { getDb } from "./db";
import { ApiError } from "./errors";
import { newId } from "./ids";
import { one, run } from "./sql";

function originAndRp() {
  const cfg = config();
  return { origin: cfg.passkeyOrigin, rpID: cfg.passkeyRpId, rpName: cfg.brandName };
}

export async function registrationOptions(user: { id: string; email: string; name: string }) {
  const db = getDb();
  const existing = db.prepare(`SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`).all(user.id) as unknown as {
    credential_id: string;
    transports: string | null;
  }[];
  const options = await generateRegistrationOptions({
    ...originAndRp(),
    userName: user.email,
    userID: Buffer.from(user.id),
    userDisplayName: user.name,
    authenticatorSelection: { residentKey: "preferred", userVerification: "required" },
    excludeCredentials: existing.map((row) => ({ id: row.credential_id, transports: row.transports ? (JSON.parse(row.transports) as string[]) : undefined })),
  });
  run(db, `DELETE FROM webauthn_challenges WHERE user_id = ? AND kind = 'register'`, user.id);
  run(
    db,
    `INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at, created_at) VALUES (?, ?, 'register', ?, ?, ?)`,
    newId("wch"),
    user.id,
    options.challenge,
    addMinutes(new Date(), 5),
    nowIso(),
  );
  return options;
}

export async function verifyRegistration(userId: string, response: RegistrationResponseJSON) {
  const db = getDb();
  const challenge = one<{ challenge: string; expires_at: string }>(
    db,
    `SELECT challenge, expires_at FROM webauthn_challenges WHERE user_id = ? AND kind = 'register' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  if (!challenge || challenge.expires_at < nowIso()) throw new ApiError(400, "challenge_expired", "Start passkey enrollment again.");
  const checked = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: originAndRp().origin,
    expectedRPID: originAndRp().rpID,
    requireUserVerification: true,
  });
  if (!checked.verified) throw new ApiError(400, "passkey_failed", "Passkey enrollment could not be verified.");
  const cred = checked.registrationInfo.credential;
  run(
    db,
    `INSERT INTO webauthn_credentials (id, user_id, credential_id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    newId("wcr"),
    userId,
    cred.id,
    Buffer.from(cred.publicKey).toString("base64url"),
    cred.counter,
    response.response.transports ? JSON.stringify(response.response.transports) : null,
    nowIso(),
  );
  run(db, `DELETE FROM webauthn_challenges WHERE user_id = ? AND kind = 'register'`, userId);
  return { verified: true };
}

export async function authenticationOptions(userId: string) {
  const db = getDb();
  const creds = db.prepare(`SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?`).all(userId) as unknown as {
    credential_id: string;
    transports: string | null;
  }[];
  if (!creds.length) throw new ApiError(404, "passkey_missing", "Enroll a passkey on the account page first.");
  const options = await generateAuthenticationOptions({
    rpID: originAndRp().rpID,
    userVerification: "required",
    allowCredentials: creds.map((row) => ({ id: row.credential_id, transports: row.transports ? (JSON.parse(row.transports) as string[]) : undefined })),
  });
  run(db, `DELETE FROM webauthn_challenges WHERE user_id = ? AND kind = 'authenticate'`, userId);
  run(
    db,
    `INSERT INTO webauthn_challenges (id, user_id, kind, challenge, expires_at, created_at) VALUES (?, ?, 'authenticate', ?, ?, ?)`,
    newId("wch"),
    userId,
    options.challenge,
    addMinutes(new Date(), 5),
    nowIso(),
  );
  return options;
}

export async function verifyAssertion(userId: string, response: AuthenticationResponseJSON): Promise<string> {
  const db = getDb();
  const challenge = one<{ challenge: string; expires_at: string }>(
    db,
    `SELECT challenge, expires_at FROM webauthn_challenges WHERE user_id = ? AND kind = 'authenticate' ORDER BY created_at DESC LIMIT 1`,
    userId,
  );
  if (!challenge || challenge.expires_at < nowIso()) throw new ApiError(400, "challenge_expired", "Start the passkey prompt again.");
  const cred = one<{ credential_id: string; public_key: string; counter: number; transports: string | null }>(
    db,
    `SELECT credential_id, public_key, counter, transports FROM webauthn_credentials WHERE user_id = ? AND credential_id = ?`,
    userId,
    response.id,
  );
  if (!cred) throw new ApiError(400, "passkey_failed", "This passkey is not enrolled.");
  const checked = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge.challenge,
    expectedOrigin: originAndRp().origin,
    expectedRPID: originAndRp().rpID,
    requireUserVerification: true,
    credential: {
      id: cred.credential_id,
      publicKey: Buffer.from(cred.public_key, "base64url"),
      counter: cred.counter,
      transports: cred.transports ? (JSON.parse(cred.transports) as ("ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb")[]) : undefined,
    },
  });
  if (!checked.verified) throw new ApiError(400, "passkey_failed", "Passkey verification failed.");
  run(db, `UPDATE webauthn_credentials SET counter = ? WHERE credential_id = ?`, checked.authenticationInfo.newCounter, cred.credential_id);
  run(db, `DELETE FROM webauthn_challenges WHERE user_id = ? AND kind = 'authenticate'`, userId);
  return response.id;
}
