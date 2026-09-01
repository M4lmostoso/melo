import { describe, it, expect } from "vitest";
import { buildRawEmail } from "./emailBuilder";

describe("emailBuilder", () => {
  it("builds a basic email", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["recipient@example.com"],
      subject: "Test Subject",
      htmlBody: "<p>Hello World</p>",
    });

    // Should be base64url encoded
    expect(raw).toBeTruthy();
    expect(raw).not.toContain("+");
    expect(raw).not.toContain("/");
    expect(raw).not.toContain("=");

    // Decode to verify structure
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("From: sender@example.com");
    expect(decoded).toContain("To: recipient@example.com");
    expect(decoded).toContain("Subject: Test Subject");
    expect(decoded).toContain("MIME-Version: 1.0");
    expect(decoded).toContain("multipart/alternative");
    expect(decodedBodies(decoded)).toContain("<p>Hello World</p>");
  });

  it("includes Date and Message-ID headers", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toMatch(/Date: .+/);
    expect(decoded).toMatch(/Message-ID: <.+@example\.com>/);
  });

  it("builds a well-formed Message-ID when From has a display name", () => {
    const raw = buildRawEmail({
      from: "Mario Rossi <sender@example.com>",
      to: ["to@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    const msgId = decoded.match(/^Message-ID: (.+)$/m)?.[1];
    // The domain must come from the addr-spec, not the raw mailbox — a
    // "<id@example.com>>" double bracket defeats sent-message dedup.
    expect(msgId).toMatch(/^<[^<>]+@example\.com>$/);
  });

  it("includes CC and BCC headers", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      cc: ["cc@example.com"],
      bcc: ["bcc@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("Cc: cc@example.com");
    expect(decoded).toContain("Bcc: bcc@example.com");
  });

  it("includes In-Reply-To header", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Re: Test",
      htmlBody: "<p>Reply</p>",
      inReplyTo: "<msg-id@gmail.com>",
      references: "<msg-id@gmail.com>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("In-Reply-To: <msg-id@gmail.com>");
    expect(decoded).toContain("References: <msg-id@gmail.com>");
  });

  it("generates plain text from HTML", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Test",
      htmlBody: "<p>Hello</p><br><p>World</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });

  it("handles multiple recipients", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["a@example.com", "b@example.com"],
      subject: "Test",
      htmlBody: "<p>Hi</p>",
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("To: a@example.com, b@example.com");
  });

  it("builds email with attachments using multipart/mixed", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "With attachment",
      htmlBody: "<p>See attached</p>",
      attachments: [
        {
          filename: "test.txt",
          mimeType: "text/plain",
          content: btoa("Hello file content"),
        },
      ],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("multipart/mixed");
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).toContain('Content-Disposition: attachment; filename="test.txt"');
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    expect(decodedBodies(decoded)).toContain("<p>See attached</p>");
    expect(decoded).toContain("text/plain");
    expect(decoded).toContain("text/html");
  });

  it("builds email with multiple attachments", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "Multi attach",
      htmlBody: "<p>Files</p>",
      attachments: [
        { filename: "a.txt", mimeType: "text/plain", content: btoa("aaa") },
        { filename: "b.pdf", mimeType: "application/pdf", content: btoa("bbb") },
      ],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain('filename="a.txt"');
    expect(decoded).toContain('filename="b.pdf"');
    expect(decoded).toContain("application/pdf");
  });

  it("keeps multipart/alternative when no attachments", () => {
    const raw = buildRawEmail({
      from: "sender@example.com",
      to: ["to@example.com"],
      subject: "No attach",
      htmlBody: "<p>Plain</p>",
      attachments: [],
    });

    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("multipart/alternative");
    expect(decoded).not.toContain("multipart/mixed");
  });
});

/**
 * Every body part is base64 now, so assertions on body text have to decode.
 * Returns all base64 part payloads concatenated as text.
 */
function decodedBodies(rawMessage: string): string {
  return rawMessage
    .split(/\r\n--/)
    .filter((part) => /Content-Transfer-Encoding: base64/i.test(part))
    .map((part) => {
      const payload = part.split("\r\n\r\n").slice(1).join("\r\n\r\n");
      try {
        return new TextDecoder().decode(
          Uint8Array.from(atob(payload.replace(/\s/g, "")), (c) => c.charCodeAt(0)),
        );
      } catch {
        return "";
      }
    })
    .join("\n");
}

function decodeBase64Url(encoded: string): string {
  // Add back padding
  let base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
  while (base64.length % 4 !== 0) {
    base64 += "=";
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new TextDecoder().decode(bytes);
}

describe("buildRawEmail — internal placeholder ids", () => {
  const base = {
    from: "me@example.com",
    to: ["you@example.com"],
    subject: "Re: Offerta",
    htmlBody: "<p>ok</p>",
  };

  it("never publishes a synthetic In-Reply-To in outgoing mail", () => {
    const raw = buildRawEmail({ ...base, inReplyTo: "synthetic-5ca99472fc027bdf@melo.local" });
    expect(decodeBase64Url(raw)).not.toContain("In-Reply-To");
  });

  it("drops the legacy UID-derived placeholder too", () => {
    const raw = buildRawEmail({ ...base, inReplyTo: "synthetic-acc-1-INBOX-2410@melo.local" });
    expect(decodeBase64Url(raw)).not.toContain("In-Reply-To");
  });

  it("keeps real Message-IDs and strips only the placeholders from References", () => {
    const raw = buildRawEmail({
      ...base,
      inReplyTo: "<real.2@example.com>",
      references: "<real.1@example.com> synthetic-5ca99472fc027bdf@melo.local <real.2@example.com>",
    });
    const text = decodeBase64Url(raw);
    expect(text).toContain("In-Reply-To: <real.2@example.com>");
    expect(text).toContain("References: <real.1@example.com> <real.2@example.com>");
    expect(text).not.toContain("melo.local");
  });
});

describe("buildRawEmail — 7-bit safety (Exchange ErrorMimeContentInvalid)", () => {
  const base = {
    from: "me@example.com",
    to: ["you@example.com"],
    subject: "Test",
    htmlBody: "<p>ok</p>",
  };

  const hasRawNonAscii = (text: string) => /[^\x00-\x7f]/.test(text);

  it("never emits raw 8-bit bytes in an accented attachment filename", () => {
    const raw = buildRawEmail({
      ...base,
      attachments: [
        {
          filename: "caractéristiques techniques.xlsx",
          mimeType: "application/vnd.ms-excel",
          content: btoa("x"),
        },
      ],
    });
    const decoded = decodeBase64Url(raw);
    const headers = decoded.slice(0, decoded.indexOf("\r\n\r\n"));
    expect(hasRawNonAscii(headers)).toBe(false);
    expect(decoded).toContain(
      "filename*=UTF-8''caract%C3%A9ristiques%20techniques.xlsx",
    );
    // An ASCII-only fallback stays for clients that ignore RFC 2231.
    expect(decoded).toContain('filename="caract_ristiques techniques.xlsx"');
  });

  it("RFC 2047-encodes an accented Subject", () => {
    const raw = buildRawEmail({ ...base, subject: "Caractéristiques techniques" });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toMatch(/^Subject: =\?UTF-8\?B\?[^\r\n]+\?=$/m);
    expect(decoded).not.toContain("Caractéristiques");
  });

  it("RFC 2047-encodes an accented From display name but not the address", () => {
    const raw = buildRawEmail({ ...base, from: "Mirko Landénna <me@example.com>" });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toMatch(/^From: =\?UTF-8\?B\?[^\r\n]+\?= <me@example\.com>$/m);
  });

  it("base64-encodes the bodies so accented text is never 8-bit", () => {
    const raw = buildRawEmail({ ...base, htmlBody: "<p>ça va — è però</p>" });
    const decoded = decodeBase64Url(raw);
    expect(hasRawNonAscii(decoded)).toBe(false);
    expect(decoded).toContain("Content-Transfer-Encoding: base64");
    expect(decodedBodies(decoded)).toContain("<p>ça va — è però</p>");
  });

  // THE root cause of the rejected sends: the HTML body of a long reply chain
  // went out as one unbroken 640KB line. RFC 5322 caps a line at 998 octets and
  // Exchange enforces it — the message never left, and the Sent copy never landed.
  it("keeps every line inside the RFC 5322 998-octet limit", () => {
    const longChain = `<div>${"quoted reply text ".repeat(60000)}</div>`;
    const raw = buildRawEmail({
      ...base,
      subject: "Re: ".repeat(60) + "long chain",
      htmlBody: longChain,
      references: Array.from({ length: 40 }, (_, i) => `msg-${i}@example.com`).join(" "),
      to: Array.from({ length: 30 }, (_, i) => `person${i}@example.com`),
      attachments: [
        { filename: "big.bin", mimeType: "application/octet-stream", content: "A".repeat(5000) },
      ],
    });
    const longest = Math.max(...decodeBase64Url(raw).split("\r\n").map((l) => l.length));
    expect(longest).toBeLessThanOrEqual(998);
  });

  it("brackets bare Message-IDs in In-Reply-To and References", () => {
    // Melo stores message_id_header without angle brackets.
    const raw = buildRawEmail({
      ...base,
      inReplyTo: "abc@outlook.com",
      references: "one@example.com <two@example.com> three@example.com",
    });
    const decoded = decodeBase64Url(raw);
    expect(decoded).toContain("In-Reply-To: <abc@outlook.com>");
    expect(decoded).toContain(
      "References: <one@example.com> <two@example.com> <three@example.com>",
    );
  });
});
