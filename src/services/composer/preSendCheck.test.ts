import { describe, it, expect } from "vitest";
import { mentionsAttachment, getPreSendWarnings } from "./preSendCheck";

describe("mentionsAttachment", () => {
  it("returns false for empty / unrelated text", () => {
    expect(mentionsAttachment("")).toBe(false);
    expect(mentionsAttachment("Ciao, ci vediamo domani")).toBe(false);
  });

  it("detects English attachment phrasing", () => {
    expect(mentionsAttachment("Please find the attached report")).toBe(true);
    expect(mentionsAttachment("I'm attaching the invoice")).toBe(true);
    expect(mentionsAttachment("See the enclosed document")).toBe(true);
  });

  it("detects Italian attachment phrasing", () => {
    expect(mentionsAttachment("Trovi il file in allegato")).toBe(true);
    expect(mentionsAttachment("Ti allego la fattura")).toBe(true);
    expect(mentionsAttachment("Allegati i documenti richiesti")).toBe(true);
  });

  it("detects French attachment phrasing", () => {
    expect(mentionsAttachment("Veuillez trouver la pièce jointe")).toBe(true);
    expect(mentionsAttachment("Le document ci-joint")).toBe(true);
  });

  it("detects the French 'PJ' abbreviation in its various forms", () => {
    expect(mentionsAttachment("Voir PJ")).toBe(true);
    expect(mentionsAttachment("voir pj")).toBe(true);
    expect(mentionsAttachment("Cf. P.J.")).toBe(true);
    expect(mentionsAttachment("la facture en P. J.")).toBe(true);
  });

  it("does not match 'pj' inside an unrelated word", () => {
    expect(mentionsAttachment("upjohn pjs")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(mentionsAttachment("ATTACHED")).toBe(true);
  });

  it("does not false-positive on 'allegro'", () => {
    expect(mentionsAttachment("Un tempo allegro e spensierato")).toBe(false);
  });
});

describe("getPreSendWarnings", () => {
  const body = "ok";

  it("warns on missing subject", () => {
    expect(
      getPreSendWarnings({ subject: "   ", attachmentCount: 1, bodyText: body }),
    ).toEqual(["subject"]);
  });

  it("warns on forgotten attachment only when nothing is attached", () => {
    expect(
      getPreSendWarnings({ subject: "Hi", attachmentCount: 0, bodyText: "see attached" }),
    ).toEqual(["attachment"]);
    expect(
      getPreSendWarnings({ subject: "Hi", attachmentCount: 1, bodyText: "see attached" }),
    ).toEqual([]);
  });

  it("can return both warnings", () => {
    expect(
      getPreSendWarnings({ subject: "", attachmentCount: 0, bodyText: "in allegato" }),
    ).toEqual(["subject", "attachment"]);
  });

  it("returns nothing for a complete message", () => {
    expect(
      getPreSendWarnings({ subject: "Hello", attachmentCount: 0, bodyText: "no hints here" }),
    ).toEqual([]);
  });
});
