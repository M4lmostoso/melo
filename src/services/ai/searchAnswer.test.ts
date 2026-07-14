import { describe, it, expect, vi } from "vitest";

vi.mock("./askInbox", () => ({
  askMyInbox: vi.fn(),
}));

import { isQuestionQuery } from "./searchAnswer";

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
