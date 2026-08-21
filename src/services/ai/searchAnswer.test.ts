import { describe, it, expect, vi } from "vitest";

vi.mock("./askInbox", () => ({
  askMyInbox: vi.fn(),
}));

import { isQuestionQuery, buildCitations } from "./searchAnswer";
import type { SearchResult } from "@/services/db/search";

describe("isQuestionQuery", () => {
  it("detects explicit question marks", () => {
    expect(isQuestionQuery("fattura apple?")).toBe(true);
  });

  it("detects English question starters", () => {
    expect(isQuestionQuery("when is the next invoice due")).toBe(true);
    expect(isQuestionQuery("show me the latest receipts")).toBe(true);
  });

  it("detects Italian question starters", () => {
    expect(isQuestionQuery("quando scade il contratto di noleggio")).toBe(true);
    expect(isQuestionQuery("dimmi le ultime fatture ricevute")).toBe(true);
  });

  it("detects Italian preposition+question bigrams", () => {
    expect(isQuestionQuery("per quando è fissata la riunione")).toBe(true);
    expect(isQuestionQuery("entro quando devo pagare la bolletta")).toBe(true);
    expect(isQuestionQuery("da quando è attivo il servizio")).toBe(true);
  });

  it("does NOT trigger on bare prepositions that aren't questions", () => {
    expect(isQuestionQuery("per favore inviami il documento")).toBe(false);
    expect(isQuestionQuery("da rossi fattura dicembre")).toBe(false);
    expect(isQuestionQuery("in allegato il contratto firmato")).toBe(false);
    expect(isQuestionQuery("entro fine mese va bene")).toBe(false);
  });

  it("ignores very short or two-word queries without question mark", () => {
    expect(isQuestionQuery("ciao")).toBe(false);
    expect(isQuestionQuery("quando scade")).toBe(false);
  });
});

const ACCOUNT = "63a6a419-1954-45b4-aea1-62a171feec43";

function src(uid: number, subject: string): SearchResult {
  return {
    message_id: `imap-${ACCOUNT}-INBOX-${uid}`,
    account_id: ACCOUNT,
    thread_id: `thread-${uid}`,
    subject,
    from_name: "Catherine Viard-Oberle",
    from_address: "catherine@example.com",
    snippet: null,
    date: 0,
    rank: 0,
  };
}

describe("buildCitations", () => {
  const sources = [src(4922, "PFD"), src(4386, "Schema TF"), src(4359, "PID")];

  it("resolves exact message ids", () => {
    const { citations, byToken } = buildCitations(
      `See [imap-${ACCOUNT}-INBOX-4386] for details.`,
      sources,
    );
    expect(citations.map((c) => c.threadId)).toEqual(["thread-4386"]);
    expect(byToken[`imap-${ACCOUNT}-INBOX-4386`]).toHaveLength(1);
  });

  it("resolves the echoed 'Message ID:' prefix as a chip token", () => {
    const token = `Message ID: imap-${ACCOUNT}-INBOX-4922`;
    const { citations, byToken } = buildCitations(`Vedi [${token}].`, sources);
    expect(citations).toHaveLength(1);
    expect(byToken[token]?.[0]?.threadId).toBe("thread-4922");
  });

  it("resolves positional markers", () => {
    const { citations } = buildCitations("Il PFD [#1] e lo schema [2].", sources);
    expect(citations.map((c) => c.threadId)).toEqual(["thread-4922", "thread-4386"]);
  });

  it("resolves ids the model mangled (dropped UUID characters)", () => {
    // Real failure: "63a6a419" came back as "63a419".
    const { citations } = buildCitations(
      "Commenti sul PFD [imap-63a419-1954-45b4-aea1-62a171feec43-INBOX-4922].",
      sources,
    );
    expect(citations.map((c) => c.threadId)).toEqual(["thread-4922"]);
  });

  it("resolves several ids inside one marker", () => {
    const { citations } = buildCitations("Vedi [#2, #3].", sources);
    expect(citations.map((c) => c.threadId)).toEqual(["thread-4386", "thread-4359"]);
  });

  it("dedupes repeated citations", () => {
    const { citations } = buildCitations("[#1] poi ancora [#1].", sources);
    expect(citations).toHaveLength(1);
  });

  it("ignores brackets that match nothing", () => {
    const { citations, byToken } = buildCitations("Nel 2026 [nota] non c'e nulla.", sources);
    expect(citations).toHaveLength(0);
    expect(byToken).toEqual({});
  });

  it("does not resolve out-of-range positional markers", () => {
    const { citations } = buildCitations("Vedi [#9].", sources);
    expect(citations).toHaveLength(0);
  });
});
