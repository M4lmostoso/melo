import { describe, it, expect } from "vitest";
import { transformHtml } from "./forwardedMessage";

const toggles = (html: string) => html.match(/class="q-tgl"/g)?.length ?? 0;
const at = (html: string, needle: string) => html.indexOf(needle);

describe("transformHtml — quote collapsing", () => {
  it("cuts AT the attribution line, not after it", () => {
    const html =
      "<p>my answer</p>" +
      "<p>Il 27 mag 2026, 12:04 +0200, Bochicchio &lt;avv@tiscali.it&gt;, ha scritto:</p>" +
      "<blockquote>quoted body</blockquote>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "my answer")).toBeLessThan(at(out, "q-tgl"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "ha scritto"));
    expect(at(out, "ha scritto")).toBeLessThan(at(out, "quoted body"));
  });

  it("collapses an attribution + quote that has NO blockquote at all", () => {
    const html =
      "<div>reply text</div>" +
      "<div>Il giorno 13 mag 2026, alle ore 12:20, Luigi &lt;lf@x.it&gt; ha scritto:</div>" +
      "<div>quoted line 1</div><div>quoted line 2</div>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "reply text")).toBeLessThan(at(out, "q-tgl"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "ha scritto"));
  });

  it("collapses a Gmail quote marker", () => {
    const html =
      "<div>New reply</div>" +
      '<blockquote class="gmail_quote">Old quoted text</blockquote>';
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Old quoted text"));
  });

  it("anchors on a forwarded-message separator", () => {
    const html =
      "<p>see below</p>" +
      "<div>---------- Messaggio inoltrato ---------</div>" +
      "<div>Da: x@y.com</div><div>forwarded body</div>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Messaggio inoltrato"));
  });

  it("anchors on an Outlook <hr> + header divider", () => {
    const html =
      "<p>Bonjour Céline</p>" +
      "<hr>" +
      "<p>De : mirko@gmail.com</p><p>Objet : Re: IDDEO</p><div>quoted</div>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "Bonjour")).toBeLessThan(at(out, "q-tgl"));
  });

  it("SAFETY: does not collapse when the quote has no content above it", () => {
    const html = '<blockquote type="cite">entire body is the quote</blockquote>';
    expect(transformHtml(html)).toBe(html);
  });

  it("SAFETY: leaves a received body wrapped in a bare blockquote alone", () => {
    // No attribution / marker → a content blockquote must NOT be swallowed.
    const html = "<blockquote>Dear Sir, here is our full offer ...</blockquote>";
    expect(transformHtml(html)).toBe(html);
  });

  it("SAFETY: does not restructure a table-based layout", () => {
    const html =
      "<table><tr><td>cell</td>" +
      "<td>Il giorno 1 gen 2026, 10:00, A &lt;a@b.it&gt; ha scritto:</td></tr></table>";
    // anchor's parent is a <tr> → bail out, return unchanged.
    expect(transformHtml(html)).toBe(html);
  });

  it("does not match ordinary prose ending in 'ha scritto:'", () => {
    const html = "<p>Il libro che lui ha scritto: era bellissimo</p>";
    expect(transformHtml(html)).toBe(html);
  });

  it("leaves non-reply emails (no quote markers) untouched", () => {
    const html = "<div>Just a normal email body</div>";
    expect(transformHtml(html)).toBe(html);
  });

  it("collapses Gmail border-left reply div INCLUDING its body content", () => {
    const html =
      "<p>My new reply text</p>" +
      '<div style="border-left:2px solid #ccc;padding-left:12px;margin-left:0;">' +
      "On 22/05/2026, 21:57:45, Mirko Landenna &lt;mirko.landenna@gmail.com&gt; wrote:<br>" +
      "<div>Quoted body content here</div>" +
      "</div>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "My new reply")).toBeLessThan(at(out, "q-tgl"));
    // Both the attribution AND the quoted body must be hidden behind the toggle
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "wrote"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Quoted body"));
  });

  it("collapses forwarded message fw-blk AND its following body content", () => {
    const html =
      "<p>Mirko forwarding note</p>" +
      "<br><br>---------- Forwarded message ---------<br><br>" +
      "From: Sylvie &lt;s@x.fr&gt;<br>Subject: Test subj<br><br>" +
      '<div class="WordSection1"><p>Bonjour à tous,</p></div>';
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "Mirko")).toBeLessThan(at(out, "q-tgl"));
    // Both the fw-blk header AND the body must be hidden behind the single toggle
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Forwarded message"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Bonjour"));
  });
});
