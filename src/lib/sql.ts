import type { DatabaseSync } from "node:sqlite";
import type { Sql } from "./db";

export function one<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function many<T>(db: DatabaseSync, sql: string, ...params: Sql[]): T[] {
  return db.prepare(sql).all(...params) as unknown as T[];
}

export function run(db: DatabaseSync, sql: string, ...params: Sql[]): void {
  db.prepare(sql).run(...params);
}
