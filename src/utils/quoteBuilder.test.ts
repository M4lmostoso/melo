import { buildReplyQuote, buildForwardQuote, type QuotableMessage } from "./quoteBuilder";

const msg = (over: Partial<QuotableMessage> = {}): QuotableMessage => ({
  from_name: "Melki, Benjamin",
  from_address: "benjamin.melki@suez.com",
  date: Date.UTC(2026, 8, 23, 8, 28, 55),
  subject: "RE: réunion TME/Suez",
  to_addresses: "Mirko Landenna <m.landenna@termomeccanica.com>",
  body_html: "<p>Bonjour</p>",
  body_text: null,
  ...over,
});

describe("buildReplyQuote", () => {
  it("quotes a comma-bearing display name in the attribution line", () => {
    const html = buildReplyQuote([msg()]);
    expect(html).toContain('&quot;Melki, Benjamin&quot; &lt;benjamin.melki@suez.com&gt; wrote:');
    // The bare form was unreadable: "…, Melki, Benjamin <…> wrote:"
    expect(html).not.toContain("Melki, Benjamin &lt;");
  });

  it("leaves a plain display name unquoted", () => {
    const html = buildReplyQuote([msg({ from_name: "Anna Bianchi", from_address: "a@x.com" })]);
    expect(html).toContain("Anna Bianchi &lt;a@x.com&gt; wrote:");
  });

  it("falls back to the bare address when there is no display name", () => {
    const html = buildReplyQuote([msg({ from_name: null })]);
    expect(html).toContain("benjamin.melki@suez.com wrote:");
  });

  it("keeps the quoted body and returns '' for no messages", () => {
    expect(buildReplyQuote([msg()])).toContain("Bonjour");
    expect(buildReplyQuote([])).toBe("");
  });

  it("orders newest message last-in-first (most recent quote first)", () => {
    const older = msg({ body_html: "<p>older</p>", from_address: "old@x.com" });
    const newer = msg({ body_html: "<p>newer</p>", from_address: "new@x.com" });
    const html = buildReplyQuote([older, newer]);
    expect(html.indexOf("newer")).toBeLessThan(html.indexOf("older"));
  });
});

describe("buildForwardQuote", () => {
  it("emits localized headers with a quoted sender name", () => {
    const html = buildForwardQuote([msg()]);
    expect(html).toContain("---------- Forwarded message ---------");
    expect(html).toContain('From: &quot;Melki, Benjamin&quot; &lt;benjamin.melki@suez.com&gt;');
    expect(html).toContain("Subject: RE: réunion TME/Suez");
    expect(html).toContain("To: Mirko Landenna &lt;m.landenna@termomeccanica.com&gt;");
  });

  it("separates multiple forwarded messages", () => {
    const html = buildForwardQuote([msg(), msg({ body_html: "<p>second</p>" })]);
    expect(html).toContain("---------- Previous message ---------");
  });

  it("returns '' for no messages", () => {
    expect(buildForwardQuote([])).toBe("");
  });
});
