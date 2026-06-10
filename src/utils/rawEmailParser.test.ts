import { describe, it, expect } from "vitest";
import { buildRawEmail } from "./emailBuilder";
import { parseRawEmailFull } from "./rawEmailParser";

// 1x1 transparent PNG
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

describe("parseRawEmailFull", () => {
  it("round-trips recipients including BCC", () => {
    const raw = buildRawEmail({
      from: "me@example.com",
      to: ["a@example.com", "b@example.com"],
      cc: ["c@example.com"],
      bcc: ["secret@example.com"],
      subject: "Hello there",
      htmlBody: "<p>Body text</p>",
    });
    const parsed = parseRawEmailFull(raw);
    expect(parsed.to).toEqual(["a@example.com", "b@example.com"]);
    expect(parsed.cc).toEqual(["c@example.com"]);
    expect(parsed.bcc).toEqual(["secret@example.com"]);
    expect(parsed.subject).toBe("Hello there");
    expect(parsed.bodyHtml).toContain("Body text");
    expect(parsed.attachments).toHaveLength(0);
  });

  it("recovers attachments with their base64 content", () => {
    const raw = buildRawEmail({
      from: "me@example.com",
      to: ["a@example.com"],
      subject: "With file",
      htmlBody: "<p>see attached</p>",
      attachments: [
        { filename: "report.pdf", mimeType: "application/pdf", content: PNG_B64 },
      ],
    });
    const parsed = parseRawEmailFull(raw);
    expect(parsed.attachments).toHaveLength(1);
    const att = parsed.attachments[0]!;
    expect(att.filename).toBe("report.pdf");
    expect(att.mimeType).toBe("application/pdf");
    // base64 content survives the MIME line-wrapping round trip
    expect(att.content.replace(/=+$/, "")).toBe(PNG_B64.replace(/=+$/, ""));
  });

  it("re-inlines cid: images back to data: URLs", () => {
    const raw = buildRawEmail({
      from: "me@example.com",
      to: ["a@example.com"],
      subject: "Inline image",
      htmlBody: `<p>pic:</p><img src="data:image/png;base64,${PNG_B64}">`,
    });
    const parsed = parseRawEmailFull(raw);
    // The inline image must NOT appear as a downloadable attachment...
    expect(parsed.attachments).toHaveLength(0);
    // ...and the cid reference must be rewritten to a data URL.
    expect(parsed.bodyHtml).toContain(`data:image/png;base64,${PNG_B64}`);
    expect(parsed.bodyHtml).not.toContain("cid:");
  });
});
