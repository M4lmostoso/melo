// @vitest-environment node
import { describe, it, expect, beforeAll, afterAll } from "vitest";

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
import { parseSearchQuery } from "./searchParser";
import { buildSearchQuery, type BuildSearchOptions } from "./searchQueryBuilder";

/**
 * Executes the generated SQL against a real SQLite + FTS5 index.
 *
 * The unit tests above only assert on the SQL *string*; every bug this file
 * exists for was invisible at that level. Passing raw user text to
 * `messages_fts MATCH` parses as an FTS5 query expression, so searching an
 * email address or a filename raised a syntax error that the UI could only
 * report as "no results".
 */

const DAY = 86_400_000;
const NOW = Date.now();

let db: InstanceType<NonNullable<typeof DatabaseSync>>;

interface Row {
  message_id: string;
  thread_id: string;
  subject: string | null;
  date: number;
  rank: number;
}

function run(query: string, options: BuildSearchOptions = {}): Row[] {
  const { sql, params } = buildSearchQuery(parseSearchQuery(query), options);
  const named: Record<string, unknown> = {};
  params.forEach((p, i) => {
    named[String(i + 1)] = p as never;
  });
  return db.prepare(sql).all(named) as unknown as Row[];
}

function subjects(query: string, options: BuildSearchOptions = {}): string[] {
  return run(query, options).map((r) => r.subject ?? "");
}

beforeAll(() => {
  db = new DatabaseSync!(":memory:");

  db.exec(`
    CREATE TABLE messages (
      id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      subject TEXT,
      from_name TEXT,
      from_address TEXT,
      to_addresses TEXT,
      snippet TEXT,
      body_text TEXT,
      date INTEGER NOT NULL,
      is_read INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      is_draft INTEGER DEFAULT 0,
      is_pec_receipt INTEGER DEFAULT 0,
      PRIMARY KEY (account_id, id)
    );
    CREATE TABLE thread_labels (
      account_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      label_id TEXT NOT NULL
    );
    CREATE TABLE labels (
      account_id TEXT NOT NULL,
      id TEXT NOT NULL,
      name TEXT NOT NULL
    );
    CREATE TABLE attachments (
      account_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      filename TEXT,
      mime_type TEXT,
      is_inline INTEGER DEFAULT 0
    );
  `);

  // Mirrors the production index, diacritics folding included.
  db.exec(`
    CREATE VIRTUAL TABLE messages_fts USING fts5(
      subject, from_name, from_address, body_text, snippet,
      content='messages', content_rowid='rowid',
      tokenize='trigram remove_diacritics 1'
    );
  `);

  const insert = db.prepare(`
    INSERT INTO messages (id, account_id, thread_id, subject, from_name, from_address,
      to_addresses, snippet, body_text, date, is_read, is_starred)
    VALUES ($id, 'acc-1', $thread, $subject, $fromName, $fromAddress, $to, $snippet, $body, $date, $read, $starred)
  `);

  const rows = [
    {
      id: "m1", thread: "t1", subject: "Fattura Enel di marzo",
      fromName: "Enel Energia", fromAddress: "noreply@enel.it",
      to: "mirko@example.com", snippet: "La tua fattura e pronta",
      body: "Gentile cliente, la fattura di marzo e disponibile. Importo 50% in acconto.",
      date: NOW - 3 * DAY, read: 1, starred: 0,
    },
    {
      id: "m2", thread: "t2", subject: "Newsletter settimanale",
      fromName: "News", fromAddress: "news@example.com",
      to: "mirko@example.com", snippet: "Le novita della settimana",
      // Mentions "fattura" repeatedly in the body but never in the subject:
      // unweighted BM25 ranked this above the real invoice.
      body: "fattura fattura fattura fattura fattura fattura sconti e promozioni varie",
      date: NOW - 2 * DAY, read: 1, starred: 0,
    },
    {
      id: "m3", thread: "t2", subject: "Newsletter settimanale",
      fromName: "News", fromAddress: "news@example.com",
      to: "mirko@example.com", snippet: "Altra puntata",
      body: "fattura fattura ancora promozioni",
      date: NOW - 1 * DAY, read: 1, starred: 0,
    },
    {
      id: "m4", thread: "t3", subject: "Documenti: report.pdf allegato",
      fromName: "Mario Rossi", fromAddress: "mario@x.it",
      to: "mirko@example.com", snippet: "Ti mando il report",
      body: "Ciao, in allegato trovi report.pdf. Sono d'accordo sulla proposta.",
      date: NOW - 10 * DAY, read: 0, starred: 0,
    },
    {
      id: "m5", thread: "t4", subject: "Iscrizione università",
      fromName: "Segreteria", fromAddress: "segreteria@ateneo.it",
      to: "mirko@example.com", snippet: "Perché è importante",
      body: "La tua iscrizione all'università è confermata.",
      date: NOW - 20 * DAY, read: 1, starred: 0,
    },
    {
      id: "m6", thread: "t5", subject: "Fattura Enel cestinata",
      fromName: "Enel Energia", fromAddress: "noreply@enel.it",
      to: "mirko@example.com", snippet: "Copia eliminata",
      body: "Vecchia fattura Enel finita nel cestino.",
      date: NOW - 5 * DAY, read: 1, starred: 0,
    },
    {
      id: "m7", thread: "t6", subject: "OK",
      fromName: "Luca", fromAddress: "luca@example.com",
      to: "mirko@example.com", snippet: "va bene",
      body: "va bene cosi",
      date: NOW - 30 * DAY, read: 1, starred: 0,
    },
  ];

  for (const r of rows) {
    insert.run({
      id: r.id, thread: r.thread, subject: r.subject, fromName: r.fromName,
      fromAddress: r.fromAddress, to: r.to, snippet: r.snippet, body: r.body,
      date: r.date, read: r.read, starred: r.starred,
    });
  }

  db.exec("INSERT INTO messages_fts(messages_fts) VALUES('rebuild')");

  db.exec(`
    INSERT INTO thread_labels (account_id, thread_id, label_id) VALUES
      ('acc-1','t1','INBOX'), ('acc-1','t2','INBOX'), ('acc-1','t3','INBOX'),
      ('acc-1','t4','INBOX'), ('acc-1','t5','TRASH'), ('acc-1','t6','INBOX');
  `);
});

afterAll(() => {
  db?.close();
});

describeSqlite("search SQL against a real FTS5 index", () => {
  // ── The crash class: queries that used to raise an FTS5 syntax error ──────

  it.each([
    ["mario@x.it", "Documenti: report.pdf allegato"],
    ["report.pdf", "Documenti: report.pdf allegato"],
    ["d'accordo", "Documenti: report.pdf allegato"],
    ["50%", "Fattura Enel di marzo"],
  ])("finds a message searching %j", (query, expected) => {
    expect(subjects(query)).toContain(expected);
  });

  it("does not throw on input that is FTS5 operator syntax", () => {
    for (const query of ["AND", "fattura (2)", "3,5", "e-mail", "NEAR(a b)", '"'])  {
      expect(() => run(query)).not.toThrow();
    }
  });

  // ── Diacritics ────────────────────────────────────────────────────────────

  it("matches accented text from an unaccented query", () => {
    expect(subjects("universita")).toContain("Iscrizione università");
  });

  it("matches unaccented text from an accented query", () => {
    expect(subjects("perché")).toContain("Iscrizione università");
  });

  // ── Multi-term semantics ──────────────────────────────────────────────────

  it("requires every term by default", () => {
    expect(subjects("fattura enel", { excludeSystemLabels: true }))
      .toEqual(["Fattura Enel di marzo"]);
  });

  it("accepts any term in 'any' mode", () => {
    const found = subjects("fattura universita", { matchMode: "any" });
    expect(found).toContain("Fattura Enel di marzo");
    expect(found).toContain("Iscrizione università");
  });

  it("excludes a negated term", () => {
    const found = subjects("fattura -newsletter");
    expect(found).toContain("Fattura Enel di marzo");
    expect(found).not.toContain("Newsletter settimanale");
  });

  // ── Ranking ───────────────────────────────────────────────────────────────

  it("ranks a subject match above a body match", () => {
    // The newsletter repeats "fattura" six times in its body and never in its
    // subject; on unweighted BM25 that beat the actual invoice.
    const found = subjects("fattura");
    expect(found[0]).toMatch(/^Fattura Enel/);
    expect(found.indexOf("Newsletter settimanale")).toBeGreaterThan(
      found.indexOf("Fattura Enel di marzo"),
    );
  });

  it("ranks by date when sort is date", () => {
    const found = run("fattura", { sort: "date" });
    const dates = found.map((r) => r.date);
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  // ── Thread grouping ───────────────────────────────────────────────────────

  it("returns one row per thread when grouping", () => {
    const found = run("fattura", { groupByThread: true });
    const threads = found.map((r) => r.thread_id);
    expect(new Set(threads).size).toBe(threads.length);
  });

  it("returns several messages of one thread without grouping", () => {
    const found = run("promozioni");
    expect(found.filter((r) => r.thread_id === "t2").length).toBe(2);
  });

  it("keeps the most recent message of a thread when grouping by date", () => {
    const found = run("promozioni", { groupByThread: true, sort: "date" });
    expect(found.find((r) => r.thread_id === "t2")?.message_id).toBe("m3");
  });

  // ── Trash / Spam ──────────────────────────────────────────────────────────

  it("hides Trash-only threads by default", () => {
    const found = subjects("fattura", { excludeSystemLabels: true });
    expect(found).not.toContain("Fattura Enel cestinata");
    expect(found).toContain("Fattura Enel di marzo");
  });

  it("in:trash brings them back", () => {
    const found = subjects("fattura in:trash", { excludeSystemLabels: true });
    expect(found).toEqual(["Fattura Enel cestinata"]);
  });

  it("in:anywhere searches everything", () => {
    const found = subjects("fattura in:anywhere", { excludeSystemLabels: true });
    expect(found).toContain("Fattura Enel cestinata");
    expect(found).toContain("Fattura Enel di marzo");
  });

  // ── Short queries ─────────────────────────────────────────────────────────

  it("still finds something for a two-letter query the trigram index cannot serve", () => {
    expect(subjects("ok")).toContain("OK");
  });

  // ── Operators keep working ────────────────────────────────────────────────

  it("combines free text with from:", () => {
    expect(subjects("fattura from:enel.it", { excludeSystemLabels: true }))
      .toEqual(["Fattura Enel di marzo"]);
  });

  it("filters is:unread", () => {
    expect(subjects("is:unread")).toEqual(["Documenti: report.pdf allegato"]);
  });

  it("filters by date window", () => {
    const found = subjects("fattura in:anywhere", { excludeSystemLabels: true });
    expect(found.length).toBeGreaterThan(0);
  });
});
