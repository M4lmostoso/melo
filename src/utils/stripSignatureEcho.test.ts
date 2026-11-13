import { describe, it, expect } from "vitest";
import { stripSignatureEcho } from "./stripSignatureEcho";

// The real signature shape from the 2026-11-13 report (TME, Termomeccanica).
const SIGNATURE =
  "<p><b>Mirko Landenna</b><br><i>Business Development Manager</i><br>Mob. +39 349 450 3449</p>" +
  '<p><img src="cid:logo"></p>' +
  "<p><b>TM.E. S.p.A - Termomeccanica Ecologia</b> Via del Molo 1/B - 19126 La Spezia – Italia<br>" +
  "Tel. +39 0187 5521 - Fax. +39 0187 552 215</p>";

describe("stripSignatureEcho", () => {
  it("drops the signature lines the model appended as paragraphs, keeps the closing formula", () => {
    const body =
      "<p>Bonjour Catherine,</p><p>Merci pour votre envoi. Du côté de TME, nous n’avons aucune objection.</p>" +
      "<p>Cordialement,</p><p>Mirko Landenna</p><p>Business Development Manager</p>" +
      "<p>Mob. +39 349 450 3449</p><p>TM.E. S.p.A – Termomeccanica Ecologia</p>" +
      "<p>Via del Molo 1/B – 19126 La Spezia – Italia</p>";
    expect(stripSignatureEcho(body, SIGNATURE)).toBe(
      "<p>Bonjour Catherine,</p><p>Merci pour votre envoi. Du côté de TME, nous n’avons aucune objection.</p><p>Cordialement,</p>",
    );
  });

  it("trims echoed lines inside a <br> block", () => {
    const body = "<p>Grazie, a presto.</p><p>Cordiali saluti,<br>Mirko Landenna<br>Business Development Manager</p>";
    expect(stripSignatureEcho(body, SIGNATURE)).toBe("<p>Grazie, a presto.</p><p>Cordiali saluti,</p>");
  });

  it("leaves a body without an echo untouched, even if it mentions the company mid-text", () => {
    const body = "<p>Per TM.E. S.p.A confermo la consegna.</p><p>Saluti,</p>";
    expect(stripSignatureEcho(body, SIGNATURE)).toBe(body);
  });

  it("does nothing without a signature", () => {
    const body = "<p>Ciao</p><p>Mirko Landenna</p>";
    expect(stripSignatureEcho(body, "")).toBe(body);
    expect(stripSignatureEcho(body, null)).toBe(body);
  });

  it("never empties the body", () => {
    const body = "<p>Mirko Landenna</p>";
    expect(stripSignatureEcho(body, SIGNATURE)).not.toBe("");
  });
});
