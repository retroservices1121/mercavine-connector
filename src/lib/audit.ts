import type { DatabaseSync } from "node:sqlite";
import { nowIso } from "./clock";

export function audit(
  db: DatabaseSync,
  entry: {
    actorType: "bot" | "human" | "system";
    actorId?: string | null;
    action: string;
    resourceType?: string | null;
    resourceId?: string | null;
    detail?: unknown;
  },
): void {
  db.prepare(
    `INSERT INTO audit_log (at, actor_type, actor_id, action, resource_type, resource_id, detail)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    nowIso(),
    entry.actorType,
    entry.actorId ?? null,
    entry.action,
    entry.resourceType ?? null,
    entry.resourceId ?? null,
    entry.detail === undefined ? null : JSON.stringify(entry.detail),
  );
}
