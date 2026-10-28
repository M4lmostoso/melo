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
    const html = buildReplyQuote(msg());
    expect(html).toContain('&quot;Melki, Benjamin&quot; &lt;benjamin.melki@suez.com&gt; wrote:');
    // The bare form was unreadable: "…, Melki, Benjamin <…> wrote:"
    expect(html).not.toContain("Melki, Benjamin &lt;");
  });

  it("leaves a plain display name unquoted", () => {
    const html = buildReplyQuote(msg({ from_name: "Anna Bianchi", from_address: "a@x.com" }));
    expect(html).toContain("Anna Bianchi &lt;a@x.com&gt; wrote:");
  });

  it("falls back to the bare address when there is no display name", () => {
    const html = buildReplyQuote(msg({ from_name: null }));
    expect(html).toContain("benjamin.melki@suez.com wrote:");
  });

  it("keeps the quoted body and returns '' for no messages", () => {
    expect(buildReplyQuote(msg())).toContain("Bonjour");
    expect(buildReplyQuote(undefined)).toBe("");
  });

  it("quotes exactly one message — its body already carries the history", () => {
    const html = buildReplyQuote(msg({ body_html: "<p>newer</p><blockquote>older</blockquote>" }));
    expect(html.match(/border-left/g)).toHaveLength(1);
    expect(html).toContain("newer");
    expect(html).toContain("older");
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

  it("puts the forwarded (last) message first, earlier ones after", () => {
    const theirs = msg({ body_html: "<p>their earlier mail</p>", from_address: "jf@x.fr" });
    const mine = msg({ body_html: "<p>my reply</p>", from_address: "me@x.it" });
    const html = buildForwardQuote([theirs, mine]);
    const fwdHeader = html.indexOf("---------- Forwarded message ---------");
    expect(html.indexOf("my reply")).toBeGreaterThan(fwdHeader);
    expect(html.indexOf("my reply")).toBeLessThan(html.indexOf("---------- Previous message ---------"));
    expect(html.indexOf("their earlier mail")).toBeGreaterThan(html.indexOf("---------- Previous message ---------"));
  });

  it("returns '' for no messages", () => {
    expect(buildForwardQuote([])).toBe("");
  });
});
