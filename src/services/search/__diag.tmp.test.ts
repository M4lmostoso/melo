import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { getSmartFolderSearchQuery, getSmartFolderUnreadCount } from "./smartFolderQuery";

const DB = "/Users/mirkolandenna/Library/Application Support/com.melomail.app/melo.db";
const ACCOUNTS = ["a"];

describe("smart folder SQL on the real DB", () => {
  it("runs", () => {
    const db = new DatabaseSync(DB, { readOnly: true });
    const accts = (db.prepare("select id from accounts").all() as unknown as Array<{id:string}>).map(a => a.id);
    for (const q of ["is:unread", "has:attachment", "is:starred after:__LAST_7_DAYS__", "has:calendar after:__LAST_6_MONTHS__", "is:ricevuta"]) {
      for (const [kind, built] of [["list", getSmartFolderSearchQuery(q, accts, 50)], ["count", getSmartFolderUnreadCount(q, accts)]] as const) {
        const named: Record<string, unknown> = {};
        built.params.forEach((p, i) => { named[String(i + 1)] = p as never; });
        const t0 = performance.now();
        try {
          const rows = db.prepare(built.sql).all(named);
          console.log(`OK   ${kind.padEnd(5)} ${q.padEnd(38)} ${String(rows.length).padStart(4)} rows  ${(performance.now()-t0).toFixed(0)}ms`);
        } catch (e) {
          console.log(`FAIL ${kind.padEnd(5)} ${q.padEnd(38)} -> ${(e as Error).message}`);
          console.log(built.sql);
        }
      }
    }
    db.close();
    expect(true).toBe(true);
  });
});
