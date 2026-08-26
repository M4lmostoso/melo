import { describe, it, expect } from "vitest";
import { buildSearchQuery } from "./searchQueryBuilder";
import type { ParsedSearchQuery } from "./searchParser";

describe("buildSearchQuery", () => {
  it("builds FTS query for free text only", () => {
    const parsed: ParsedSearchQuery = { freeText: "hello world" };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("messages_fts MATCH");
    expect(sql).toContain("bm25(messages_fts");
    // Terms are quoted, never handed to FTS5 as a raw expression.
    expect(params[0]).toBe('"hello" AND "world"');
  });

  it("quotes terms that would otherwise be FTS5 syntax errors", () => {
    for (const [input, expected] of [
      ["mario@x.it", '"mario@x.it"'],
      ["report.pdf", '"report.pdf"'],
      ["e-mail", '"e-mail"'],
      ["50%", '"50%"'],
      ["d'accordo", `"d'accordo"`],
    ] as const) {
      const { params } = buildSearchQuery({ freeText: input });
      expect(params[0]).toBe(expected);
    }
  });

  it("combines terms with OR in 'any' match mode", () => {
    const { params } = buildSearchQuery(
      { freeText: "fattura enel" },
      { matchMode: "any" },
    );
    expect(params[0]).toBe('"fattura" OR "enel"');
  });

  it("turns a leading dash into an FTS5 NOT clause", () => {
    const { params } = buildSearchQuery({ freeText: "fattura -enel" });
    expect(params[0]).toBe('"fattura" NOT ("enel")');
  });

  it("falls back to LIKE when every term is below the trigram window", () => {
    const { sql, params, tooShort } = buildSearchQuery({ freeText: "ok" });
    expect(tooShort).toBe(true);
    expect(sql).not.toContain("messages_fts MATCH");
    expect(sql).toContain("m.subject LIKE");
    expect(params[0]).toBe("ok");
  });

  it("builds from: filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", from: "john" };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("m.from_address LIKE");
    expect(sql).toContain("m.from_name LIKE");
    expect(params).toContain("john");
  });

  it("builds to: filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", to: "jane" };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("m.to_addresses LIKE");
    expect(params).toContain("jane");
  });

  it("builds subject: filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", subject: "meeting" };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("m.subject LIKE");
    expect(params).toContain("meeting");
  });

  it("builds has:attachment filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", hasAttachment: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("EXISTS (SELECT 1 FROM attachments");
  });

  it("builds is:unread filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", isUnread: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("m.is_read = 0");
  });

  it("builds is:read filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", isRead: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("m.is_read = 1");
  });

  it("builds is:starred filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", isStarred: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("m.is_starred = 1");
  });

  it("builds is:ricevuta (PEC receipt) filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", isPecReceipt: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("m.is_pec_receipt = 1");
  });

  it("builds before: date filter", () => {
    const ts = Math.floor(new Date(2024, 0, 15).getTime() / 1000);
    const parsed: ParsedSearchQuery = { freeText: "", before: ts };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("m.date <");
    expect(params).toContain(ts);
  });

  it("builds after: date filter", () => {
    const ts = Math.floor(new Date(2024, 5, 1).getTime() / 1000);
    const parsed: ParsedSearchQuery = { freeText: "", after: ts };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("m.date >");
    expect(params).toContain(ts);
  });

  it("builds label: filter", () => {
    const parsed: ParsedSearchQuery = { freeText: "", label: "work" };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("LOWER(l.name) = LOWER");
    expect(params).toContain("work");
  });

  it("builds in: filter against the system label", () => {
    const { sql, params } = buildSearchQuery({ freeText: "", in: "TRASH" });
    expect(sql).toContain("tli.label_id =");
    expect(params).toContain("TRASH");
  });

  it("in:trash lifts the Trash/Spam exclusion", () => {
    const { sql } = buildSearchQuery(
      { freeText: "fattura", in: "TRASH" },
      { excludeSystemLabels: true },
    );
    expect(sql).not.toContain("'TRASH', 'SPAM'");
  });

  it("in:anywhere lifts the exclusion without pinning a folder", () => {
    const { sql } = buildSearchQuery(
      { freeText: "fattura", in: "ANYWHERE" },
      { excludeSystemLabels: true },
    );
    expect(sql).not.toContain("'TRASH', 'SPAM'");
    expect(sql).not.toContain("tli.label_id =");
  });

  it("excludes Trash/Spam threads when asked", () => {
    const { sql } = buildSearchQuery(
      { freeText: "fattura" },
      { excludeSystemLabels: true },
    );
    expect(sql).toContain("'TRASH', 'SPAM'");
  });

  it("adds account filter when provided", () => {
    const parsed: ParsedSearchQuery = { freeText: "test" };
    const { sql, params } = buildSearchQuery(parsed, { accountId: "account-123" });
    expect(sql).toContain("m.account_id =");
    expect(params).toContain("account-123");
  });

  it("respects limit parameter", () => {
    const parsed: ParsedSearchQuery = { freeText: "test" };
    const { sql, params } = buildSearchQuery(parsed, { limit: 25 });
    expect(sql).toContain("LIMIT");
    expect(params[params.length - 1]).toBe(25);
  });

  it("combines free text with operators", () => {
    const parsed: ParsedSearchQuery = {
      freeText: "budget",
      from: "john",
      isUnread: true,
    };
    const { sql, params } = buildSearchQuery(parsed);
    expect(sql).toContain("messages_fts MATCH");
    expect(sql).toContain("m.from_address LIKE");
    expect(sql).toContain("m.is_read = 0");
    expect(params).toContain('"budget"');
    expect(params).toContain("john");
  });

  it("scores by date when there is no free text to rank", () => {
    const parsed: ParsedSearchQuery = { freeText: "", isUnread: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("m.date as score");
    expect(sql).not.toContain("bm25(");
  });

  it("scores by weighted bm25 when free text is present", () => {
    const parsed: ParsedSearchQuery = { freeText: "test", isUnread: true };
    const { sql } = buildSearchQuery(parsed);
    expect(sql).toContain("bm25(messages_fts, 12.0, 6.0, 6.0, 1.0, 3.0)");
  });

  it("sort:date ignores bm25 even with free text", () => {
    const { sql } = buildSearchQuery({ freeText: "test" }, { sort: "date" });
    expect(sql).not.toContain("bm25(");
    expect(sql).toContain("m.date as score");
  });

  it("groups to one row per thread when asked", () => {
    const { sql } = buildSearchQuery({ freeText: "test" }, { groupByThread: true });
    expect(sql).toContain("GROUP BY account_id, thread_id");
    expect(sql).toContain("MAX(score) as rank");
  });

  it("exposes FROM/WHERE fragments for composing a COUNT", () => {
    const { fromSql, whereSql, whereParams } = buildSearchQuery(
      { freeText: "", isUnread: true },
      { accountId: "acc-1" },
    );
    expect(fromSql).toBe("FROM messages m");
    expect(whereSql).toContain("m.is_read = 0");
    // The limit is not part of the WHERE params.
    expect(whereParams).toEqual(["acc-1"]);
  });

  it("uses parameterized queries (no SQL injection)", () => {
    const parsed: ParsedSearchQuery = {
      freeText: "",
      from: "'; DROP TABLE messages; --",
    };
    const { sql, params } = buildSearchQuery(parsed);
    // The value should be in params, not interpolated into SQL
    expect(sql).not.toContain("DROP TABLE");
    expect(params).toContain("'; DROP TABLE messages; --");
  });
});
