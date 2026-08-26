import { describe, it, expect } from "vitest";
import { buildFtsQuery, highlightTermsFor } from "./ftsQuery";

describe("buildFtsQuery", () => {
  it("quotes a plain term", () => {
    expect(buildFtsQuery("fattura").match).toBe('"fattura"');
  });

  it("ANDs multiple terms by default", () => {
    expect(buildFtsQuery("fattura enel").match).toBe('"fattura" AND "enel"');
  });

  it("ORs multiple terms in 'any' mode", () => {
    expect(buildFtsQuery("fattura enel", "any").match).toBe('"fattura" OR "enel"');
  });

  it.each([
    ["mario@x.it", '"mario@x.it"'],
    ["report.pdf", '"report.pdf"'],
    ["e-mail", '"e-mail"'],
    ["50%", '"50%"'],
    ["3,5", '"3,5"'],
    ["d'accordo", `"d'accordo"`],
    ["fattura (2024)", '"fattura" AND "2024"'],
  ])("neutralises FTS5 syntax in %j", (input, expected) => {
    expect(buildFtsQuery(input).match).toBe(expected);
  });

  it("neutralises FTS5 operator keywords", () => {
    expect(buildFtsQuery("AND").match).toBe('"AND"');
    expect(buildFtsQuery("a NEAR b").match).toBe('"NEAR"');
  });

  it("doubles an embedded quote rather than closing the literal", () => {
    // An unbalanced quote inside a word would otherwise terminate the FTS5
    // string literal and leave the rest as stray syntax.
    expect(buildFtsQuery('abc"def').match).toBe('"abc""def"');
  });

  it("keeps a quoted phrase as one term", () => {
    expect(buildFtsQuery('"fattura enel"').match).toBe('"fattura enel"');
  });

  it("trims edge punctuation but keeps it inside a term", () => {
    expect(buildFtsQuery("rossi.").match).toBe('"rossi"');
    expect(buildFtsQuery("report.pdf.").match).toBe('"report.pdf"');
  });

  it("turns a leading dash into a NOT clause", () => {
    expect(buildFtsQuery("fattura -enel").match).toBe('"fattura" NOT ("enel")');
  });

  it("parenthesises an OR list before negating", () => {
    expect(buildFtsQuery("fattura enel -spam", "any").match).toBe(
      '("fattura" OR "enel") NOT ("spam")',
    );
  });

  it("drops terms below the trigram window without zeroing the query", () => {
    const q = buildFtsQuery("la fattura di enel");
    expect(q.match).toBe('"fattura" AND "enel"');
    expect(q.droppedShortTerms).toEqual(["la", "di"]);
    expect(q.tooShort).toBe(false);
  });

  it("reports tooShort when nothing survives", () => {
    const q = buildFtsQuery("ok");
    expect(q.match).toBe("");
    expect(q.tooShort).toBe(true);
  });

  it("is empty, not tooShort, for empty input", () => {
    const q = buildFtsQuery("   ");
    expect(q.match).toBe("");
    expect(q.tooShort).toBe(false);
  });

  it("exposes the surviving terms for highlighting", () => {
    expect(buildFtsQuery("fattura enel").terms).toEqual(["fattura", "enel"]);
  });
});

describe("highlightTermsFor", () => {
  it("ignores operator segments", () => {
    expect(highlightTermsFor("fattura from:enel.it is:unread")).toEqual(["fattura"]);
  });

  it("ignores a quoted operator value", () => {
    expect(highlightTermsFor('budget from:"John Doe"')).toEqual(["budget"]);
  });

  it("returns nothing for an operator-only query", () => {
    expect(highlightTermsFor("is:unread has:attachment")).toEqual([]);
  });
});
