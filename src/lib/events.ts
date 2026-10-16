import type { DatabaseSync } from "node:sqlite";
import { audit } from "./audit";
import { nowIso } from "./clock";
import { newId } from "./ids";
import { run } from "./sql";
import { queueWebhooks } from "./webhooks";

export function emit(
  db: DatabaseSync,
  event: {
    type: string;
    userId: string;
    botId?: string | null;
    resourceId?: string | null;
    cartId?: string | null;
    data: Record<string, unknown>;
    actorType?: "bot" | "human" | "system";
    actorId?: string | null;
  },
): string {
  const id = newId("evt");
  const at = nowIso();
  const payload = { id, type: event.type, created: at, data: event.data };
  run(
    db,
    `INSERT INTO events (id, type, user_id, bot_client_id, resource_id, payload, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    id,
    event.type,
    event.userId,
    event.botId ?? null,
    event.resourceId ?? event.cartId ?? null,
    JSON.stringify(payload),
    at,
  );
  if (event.cartId) {
    run(
      db,
      `INSERT INTO cart_events (id, cart_id, type, payload, created_at) VALUES (?, ?, ?, ?, ?)`,
      newId("cev"),
      event.cartId,
      event.type,
      JSON.stringify(event.data),
      at,
    );
  }
  audit(db, {
    actorType: event.actorType ?? "system",
    actorId: event.actorId ?? event.botId ?? null,
    action: event.type,
    resourceType: event.cartId ? "cart" : "event",
    resourceId: event.cartId ?? event.resourceId ?? id,
    detail: event.data,
  });
  queueWebhooks(db, event.botId, id, event.type, payload);
  return id;
}

export function notify(db: DatabaseSync, userId: string, channel: string, title: string, body: string) {
  run(
    db,
    `INSERT INTO notifications (id, user_id, channel, title, body, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    newId("ntf"),
    userId,
    channel,
    title,
    body,
    nowIso(),
  );
}
