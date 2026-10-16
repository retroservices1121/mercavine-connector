import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";
import { getDb, transaction } from "./db";
import { ApiError, errorBody } from "./errors";
import { canonicalJson, sha256 } from "./ids";
import { one, run } from "./sql";

export type IdemResult = { status: number; body: unknown; replayed: boolean };

type Stored = { request_hash: string; response_status: number; response_body: string };

function read(db: DatabaseSync, botId: string, key: string): Stored | undefined {
  return one<Stored>(
    db,
    `SELECT request_hash, response_status, response_body FROM idempotency_keys WHERE bot_client_id = ? AND key = ?`,
    botId,
    key,
  );
}

function replay(row: Stored, hash: string): IdemResult {
  if (row.request_hash !== hash) {
    throw new ApiError(
      422,
      "idempotency_key_reuse",
      "This Idempotency-Key was already used for a different request.",
    );
  }
  return { status: row.response_status, body: JSON.parse(row.response_body) as unknown, replayed: true };
}

function write(db: DatabaseSync, botId: string, key: string, hash: string, status: number, body: unknown) {
  run(
    db,
    `INSERT INTO idempotency_keys (bot_client_id, key, request_hash, response_status, response_body, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    botId,
    key,
    hash,
    status,
    JSON.stringify(body),
    nowIso(),
  );
}

export function withIdempotency(
  botId: string,
  key: string | undefined,
  payload: unknown,
  fn: (db: DatabaseSync) => { status: number; body: unknown },
): IdemResult {
  const trimmed = key?.trim() ?? "";
  if (trimmed.length < 8) {
    throw new ApiError(400, "idempotency_key_required", "Send an Idempotency-Key of at least 8 characters on every POST.");
  }
  const hash = sha256(canonicalJson(payload));
  const early = read(getDb(), botId, trimmed);
  if (early) return replay(early, hash);
  try {
    return transaction((db) => {
      const again = read(db, botId, trimmed);
      if (again) return replay(again, hash);
      const result = fn(db);
      write(db, botId, trimmed, hash, result.status, result.body);
      return { ...result, replayed: false };
    });
  } catch (error) {
    if (error instanceof ApiError && error.status < 500) {
      const body = errorBody(error);
      try {
        transaction((db) => {
          if (!read(db, botId, trimmed)) write(db, botId, trimmed, hash, error.status, body);
        });
      } catch {
        /* a racing writer already stored the response */
      }
    }
    throw error;
  }
}
