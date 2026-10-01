// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

// Node's built-in SQLite, imported through a variable so Vite never bundles it
// (same pattern as ftsUpgrade.test.ts); older runtimes skip the suite.
type SqliteModule = typeof import("node:sqlite");
const sqliteSpecifier = "node:sqlite";
const sqlite = (await import(/* @vite-ignore */ sqliteSpecifier).catch(
  () => null,
)) as SqliteModule | null;
const DatabaseSync = sqlite?.DatabaseSync;
const describeSqlite = describe.skipIf(!DatabaseSync);

vi.mock("./connection", () => ({ getDb: vi.fn() }));

import { getDb } from "./connection";
import { purgeGhostDrafts } from "./messages";

type Db = InstanceType<NonNullable<typeof DatabaseSync>>;

function adapter(db: Db) {
  const bind = (params: unknown[] = []) => {
    const named: Record<string, unknown> = {};
    params.forEach((p, i) => { named[String(i + 1)] = p as never; });
    return named;
  };
  return {
    select: async <T>(sql: string, params?: unknown[]): Promise<T> =>
      db.prepare(sql).all(bind(params)) as unknown as T,
    execute: async (sql: string, params?: unknown[]) => {
      const r = db.prepare(sql).run(bind(params));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
}

const HOUR = 60 * 60 * 1000;
const now = Date.now();

function makeDb(): Db {
  const db = new DatabaseSync!(":memory:");
  db.exec(`
    CREATE TABLE threads (id TEXT, account_id TEXT, PRIMARY KEY (account_id, id));
    CREATE TABLE thread_labels (
      thread_id TEXT NOT NULL, account_id TEXT NOT NULL, label_id TEXT NOT NULL,
      PRIMARY KEY (account_id, thread_id, label_id)
    );
    CREATE TABLE messages (
      id TEXT, account_id TEXT, thread_id TEXT, from_address TEXT, date INTEGER,
      is_draft INTEGER DEFAULT 0, is_trashed INTEGER DEFAULT 0
    );
    CREATE TABLE message_embeddings (account_id TEXT, message_id TEXT);
  `);
  return db;
}

function thread(db: Db, id: string, labels: string[]) {
  db.prepare("INSERT INTO threads VALUES (?, 'a')").run(id);
  for (const l of labels) db.prepare("INSERT INTO thread_labels VALUES (?, 'a', ?)").run(id, l);
}

function msg(db: Db, id: string, threadId: string, from: string, date: number, isDraft = 0) {
  db.prepare(
    "INSERT INTO messages (id, account_id, thread_id, from_address, date, is_draft) VALUES (?, 'a', ?, ?, ?, ?)",
  ).run(id, threadId, from, date, isDraft);
}

const ids = (db: Db) =>
  (db.prepare("SELECT id FROM messages ORDER BY id").all() as { id: string }[]).map((r) => r.id);
const labels = (db: Db, t: string) =>
  (db.prepare("SELECT label_id FROM thread_labels WHERE thread_id = ? ORDER BY label_id").all(t) as {
    label_id: string;
  }[]).map((r) => r.label_id);

describeSqlite("purgeGhostDrafts", () => {
  let db: Db;
  beforeEach(() => {
    db = makeDb();
    vi.mocked(getDb).mockResolvedValue(adapter(db) as never);
  });

  it("keeps a parked reply draft in an INBOX thread, however old", async () => {
    thread(db, "t1", ["INBOX", "DRAFT"]);
    msg(db, "in", "t1", "them@x.it", now - 48 * HOUR);
    msg(db, "draft", "t1", "me@x.it", now - 24 * HOUR, 1);

    expect(await purgeGhostDrafts()).toBe(0);
    expect(ids(db)).toContain("draft");
  });

  it("keeps a parked draft whose DRAFT label the sync dropped, and restores the label", async () => {
    thread(db, "t1", ["INBOX"]);
    msg(db, "in", "t1", "them@x.it", now - 48 * HOUR);
    msg(db, "draft", "t1", "me@x.it", now - 24 * HOUR, 1);
    // A reply from the other side arrived after the draft was parked
    msg(db, "in2", "t1", "them@x.it", now - HOUR);

    expect(await purgeGhostDrafts()).toBe(0);
    expect(ids(db)).toContain("draft");
    expect(labels(db, "t1")).toEqual(["DRAFT", "INBOX"]);
  });

  it("removes a draft left behind after it was sent", async () => {
    thread(db, "t1", ["INBOX", "SENT", "DRAFT"]);
    msg(db, "in", "t1", "them@x.it", now - 48 * HOUR);
    msg(db, "draft", "t1", "me@x.it", now - 2 * HOUR, 1);
    msg(db, "sent", "t1", "Me@X.it", now - HOUR);

    expect(await purgeGhostDrafts()).toBe(1);
    expect(ids(db)).toEqual(["in", "sent"]);
    expect(labels(db, "t1")).toEqual(["INBOX", "SENT"]);
  });

  it("leaves a draft younger than 5 minutes alone even with a later sent copy", async () => {
    thread(db, "t1", ["SENT", "DRAFT"]);
    msg(db, "draft", "t1", "me@x.it", now - 60_000, 1);
    msg(db, "sent", "t1", "me@x.it", now - 30_000);

    expect(await purgeGhostDrafts()).toBe(0);
  });
});
