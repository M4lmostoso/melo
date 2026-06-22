import { describe, it, expect } from "vitest";
import {
  isPecCandidateEmail,
  isPecReceipt,
  pecReceiptSqlPredicate,
} from "./pecReceipts";

describe("isPecCandidateEmail", () => {
  it("matches certified-email addresses", () => {
    expect(isPecCandidateEmail("opusgestio@pec.it")).toBe(true);
    expect(isPecCandidateEmail("mario.rossi@legalmail.it")).toBe(true);
    expect(isPecCandidateEmail("studio@legal.example.com")).toBe(true);
    expect(isPecCandidateEmail("AZIENDA@PEC.ARUBA.IT")).toBe(true);
  });

  it("rejects ordinary addresses and empty input", () => {
    expect(isPecCandidateEmail("mario.rossi@gmail.com")).toBe(false);
    expect(isPecCandidateEmail("info@example.com")).toBe(false);
    expect(isPecCandidateEmail(null)).toBe(false);
    expect(isPecCandidateEmail("")).toBe(false);
  });
});

describe("isPecReceipt", () => {
  it("matches accettazione / consegna receipts from posta-certificata@", () => {
    expect(isPecReceipt("posta-certificata@pec.aruba.it", "ACCETTAZIONE: Contratto")).toBe(true);
    expect(isPecReceipt("posta-certificata@telecompost.it", "CONSEGNA: Doppio addebito")).toBe(true);
    expect(isPecReceipt("posta-certificata@legalmail.it", "AVVENUTA CONSEGNA: Fattura")).toBe(true);
    expect(isPecReceipt("posta-certificata@pec.aruba.it", "MANCATA CONSEGNA: X")).toBe(true);
    // case-insensitive sender + subject
    expect(isPecReceipt("Posta-Certificata@PEC.aruba.it", "accettazione: x")).toBe(true);
  });

  it("does NOT match the real certified message (busta di trasporto)", () => {
    expect(isPecReceipt("posta-certificata@pec.aruba.it", "POSTA CERTIFICATA: Invio File 123")).toBe(false);
  });

  it("does not match receipt subjects from non-certified senders", () => {
    expect(isPecReceipt("mario@example.com", "ACCETTAZIONE: qualcosa")).toBe(false);
  });

  it("handles a receipt whose original subject embeds POSTA CERTIFICATA later", () => {
    expect(
      isPecReceipt("posta-certificata@pec.aruba.it", "ACCETTAZIONE: Fwd: POSTA CERTIFICATA: Sollecito"),
    ).toBe(true);
  });

  it("returns false on missing data", () => {
    expect(isPecReceipt(null, "ACCETTAZIONE: x")).toBe(false);
    expect(isPecReceipt("posta-certificata@pec.it", null)).toBe(false);
  });
});

describe("pecReceiptSqlPredicate", () => {
  it("references the given alias and excludes nothing by params", () => {
    const sql = pecReceiptSqlPredicate("m");
    expect(sql).toContain("LOWER(m.from_address) LIKE 'posta-certificata@%'");
    expect(sql).toContain("UPPER(m.subject) LIKE 'ACCETTAZIONE:%'");
    expect(sql).toContain("UPPER(m.subject) LIKE 'CONSEGNA:%'");
    // must not match the busta di trasporto prefix
    expect(sql).not.toContain("'POSTA CERTIFICATA:%'");
  });
});
