// @vitest-environment node
import { describe, it, expect, beforeEach, vi } from "vitest";

// Node's built-in SQLite (added 22.5, unflagged from 23.4). Imported through a
// variable so Vite never tries to bundle it as a client dependency, and guarded
// so an older runtime skips this suite instead of failing to collect it.
type SqliteModule = typeof import("node:sqlite");
const sqliteSpecifier = "node:sqlite";
const sqlite = (await import(/* @vite-ignore */ sqliteSpecifier).catch(
  () => null,
)) as SqliteModule | null;
const DatabaseSync = sqlite?.DatabaseSync;
const describeSqlite = describe.skipIf(!DatabaseSync);

vi.mock("./connection", () => ({ getDb: vi.fn() }));

import { upgradeFtsDiacritics } from "./migrations";

/**
 * The FTS upgrade drops and rebuilds a search index that can run to hundreds of
 * megabytes. `runMigrations()` is memoised per module instance, but each webview
 * (main, thread, attachment preview) is its own instance, so several of them can
 * enter the upgrade simultaneously — which is how a real 1.3 GB mailbox wedged
 * on the splash screen, with the rebuild logged twice seconds apart.
 */

type Row = Record<string, unknown>;

/** Minimal stand-in for the Tauri SQL plugin's Database, over node:sqlite. */
function adapter(db: Db, onExecute?: (sql: string) => void) {
  const bind = (params: unknown[] = []) => {
    const named: Record<string, unknown> = {};
    params.forEach((p, i) => { named[String(i + 1)] = p as never; });
    return named;
  };
  return {
    select: async <T>(sql: string, params?: unknown[]): Promise<T> =>
      db.prepare(sql).all(bind(params)) as unknown as T,
    execute: async (sql: string, params?: unknown[]) => {
      onExecute?.(sql);
      const r = db.prepare(sql).run(bind(params));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
}

type Db = InstanceType<NonNullable<typeof DatabaseSync>>;

function makeDb(): Db {
  const db = new DatabaseSync!(":memory:");
  db.exec(`
    CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE messages (
      id TEXT, account_id TEXT, subject TEXT, from_name TEXT, from_address TEXT,
      body_text TEXT, snippet TEXT
    );
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      subject, from_name, from_address, body_text, snippet,
      content='messages', content_rowid='rowid', tokenize='trigram'
    );
  `);
  db.prepare(
    "INSERT INTO messages VALUES ('m1','a','Iscrizione università','Segreteria','s@x.it','perché no','x')",
  ).run();
  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");
  return db;
}

const tokenizer = (db: Db): string =>
  (db.prepare("SELECT sql FROM sqlite_master WHERE name='messages_fts'").get() as Row)
    .sql as string;

const flag = (db: Db): string | undefined =>
  (db.prepare("SELECT value FROM settings WHERE key='fts_remove_diacritics_v1'").get() as Row | undefined)
    ?.value as string | undefined;

let db: Db;
beforeEach(() => { db = makeDb(); });

describeSqlite("upgradeFtsDiacritics", () => {
  it("rebuilds the index with diacritics folding and records the flag", async () => {
    await upgradeFtsDiacritics(adapter(db) as never);

    expect(tokenizer(db)).toContain("remove_diacritics");
    expect(flag(db)).toBe("1");

    // The rebuilt index actually matches without accents.
    const hits = db
      .prepare("SELECT subject FROM messages_fts WHERE messages_fts MATCH '\"universita\"'")
      .all() as Row[];
    expect(hits).toHaveLength(1);
  });

  it("recreates the sync triggers", async () => {
    await upgradeFtsDiacritics(adapter(db) as never);
    const triggers = db
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name")
      .all() as Row[];
    expect(triggers.map((t) => t.name)).toEqual(["messages_ad", "messages_ai", "messages_au"]);
  });

  it("is a no-op once the flag is set", async () => {
    db.prepare("INSERT INTO settings VALUES ('fts_remove_diacritics_v1','1')").run();
    const seen: string[] = [];
    await upgradeFtsDiacritics(adapter(db, (s) => seen.push(s)) as never);
    expect(seen).toEqual([]);
  });

  it("only records the flag when the index is already folded", async () => {
    await upgradeFtsDiacritics(adapter(db) as never);
    db.prepare("DELETE FROM settings WHERE key='fts_remove_diacritics_v1'").run();

    const seen: string[] = [];
    await upgradeFtsDiacritics(adapter(db, (s) => seen.push(s)) as never);

    expect(seen.some((s) => s.includes("rebuild"))).toBe(false);
    expect(flag(db)).toBe("1");
  });

  it("rebuilds only once when several windows race", async () => {
    const rebuilds: number[] = [];
    const track = (sql: string) => { if (sql.includes("'rebuild'")) rebuilds.push(1); };

    await Promise.all([
      upgradeFtsDiacritics(adapter(db, track) as never),
      upgradeFtsDiacritics(adapter(db, track) as never),
      upgradeFtsDiacritics(adapter(db, track) as never),
    ]);

    expect(rebuilds).toHaveLength(1);
    expect(tokenizer(db)).toContain("remove_diacritics");
    expect(flag(db)).toBe("1");
  });

  it("leaves no claim row behind on success", async () => {
    await upgradeFtsDiacritics(adapter(db) as never);
    const claim = db
      .prepare("SELECT value FROM settings WHERE key='fts_remove_diacritics_claim'")
      .get();
    expect(claim).toBeUndefined();
  });

  it("does not rebuild while another window holds a fresh claim", async () => {
    db.prepare("INSERT INTO settings VALUES ('fts_remove_diacritics_claim', $1)")
      .run({ 1: String(Date.now()) });

    const seen: string[] = [];
    await upgradeFtsDiacritics(adapter(db, (s) => seen.push(s)) as never);

    expect(seen.some((s) => s.includes("rebuild"))).toBe(false);
    expect(flag(db)).toBeUndefined();
  });

  it("takes over a stale claim left by a run that died mid-rebuild", async () => {
    const anHourAgo = Date.now() - 60 * 60_000;
    db.prepare("INSERT INTO settings VALUES ('fts_remove_diacritics_claim', $1)")
      .run({ 1: String(anHourAgo) });

    await upgradeFtsDiacritics(adapter(db) as never);

    expect(tokenizer(db)).toContain("remove_diacritics");
    expect(flag(db)).toBe("1");
  });
});
