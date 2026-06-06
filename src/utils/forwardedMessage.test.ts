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

  it("collapses border-top divider with RAW Outlook header text (no fw-blk built, empty <p> before)", () => {
    // Real-world INBOX-3441 pattern: an empty <p></p> right before the divider makes the
    // Case-5 regex bridge across block boundaries, so the fw-blk is never built. Detection
    // must fall back to the divider's raw header text ("Da: … Inviato: … Oggetto: …").
    const html =
      "<p>Buongiorno Lorenzo, ecco la mia risposta nuova</p>" +
      '<p style="MARGIN-BOTTOM:5pt"></p>' +
      "<div>" +
      '<div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">' +
      '<p class="MsoNormal"><b><span>Da:</span></b><span> Lorenzo Lupetti &lt;L.Lupetti@x.com&gt;<br>' +
      "<b>Inviato:</b> lunedì 30 marzo 2026 10:10<br>" +
      "<b>A:</b> Bruno Morabito &lt;bruno@reonitalia.it&gt;<br>" +
      "<b>Oggetto:</b> R: Sedibex Dosaggio</span></p>" +
      "</div></div>" +
      "<p>Buongiorno Bruno, avremmo bisogno della offerta</p>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "Buongiorno Lorenzo")).toBeLessThan(at(out, "q-tgl"));
    // The header AND the quoted body must be hidden behind the toggle
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Lorenzo Lupetti"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Buongiorno Bruno"));
  });

  it("collapses Outlook outer-wrapper pattern: preamble + border-top header + sibling body", () => {
    // Outlook structure: <div>(<br><p>Uso Interno</p><div border-top><fw-blk></div>)</div>
    // followed by the forwarded body as a sibling — NOT inside the wrapper.
    const html =
      "<p>Sylvie forwarding text</p>" +
      "<div>" +
      '<p style="color:grey">Uso Interno / Internal Use</p>' +
      '<div style="border:none;border-top:solid #E1E1E1 1.0pt;">' +
      '<p><b>De :</b> Josselin LIOUST &lt;jlioust@elcimai.com&gt;<br>' +
      "<b>Envoyé :</b> vendredi 5 juin 2026 11:45<br>" +
      "<b>Objet :</b> RE: Point Hebdo AO CHINON</p>" +
      "</div>" +
      "</div>" +
      "<p>Bonjour,</p>" +
      "<p>Comme convenu...</p>";
    const out = transformHtml(html);
    expect(toggles(out)).toBe(1);
    expect(at(out, "Sylvie")).toBeLessThan(at(out, "q-tgl"));
    // Both the fw-blk header AND the body must be behind the single toggle
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "CHINON"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Bonjour"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Comme convenu"));
  });

  it("collapses entire WordSection1: outer-wrapper-A + body text + outer-wrapper-B all hidden", () => {
    // INBOX-4053 pattern: new Yuri message in first WordSection1; second WordSection1 contains
    // outer-wrapper-A (fw-blk Da: Yuri) + body "In IFC..." + outer-wrapper-B (fw-blk Da: Mirko).
    // The entire second WordSection1 must collapse behind ONE toggle.
    const html =
      '<div class="WordSection1"><p>Yuri nuova risposta</p></div>' +
      "<p>Firma Yuri</p>" +
      '<div class="WordSection1">' +
      '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">' +
      "<p><b>Da:</b> Yuri Furia<br><b>Inviato:</b> giovedì 4 giugno 2026 15:11<br>" +
      "<b>A:</b> Mirko Landenna &lt;M.Landenna@termomeccanica.com&gt;<br>" +
      "<b>Cc:</b> Lorenzo Lupetti &lt;L.Lupetti@termomeccanica.com&gt;<br>" +
      "<b>Oggetto:</b> R: R: R: R: Chinon: Modello 3D</p>" +
      "</div></div>" +
      "<p>In IFC devo farlo fare al collega, glielo chiedo subito</p>" +
      '<div><div style="border:none;border-top:solid #E1E1E1 1.0pt;padding:3.0pt 0cm 0cm 0cm">' +
      "<p><b>Da:</b> Mirko Landenna<br><b>Inviato:</b> giovedì 4 giugno 2026 15:03<br>" +
      "<b>A:</b> Yuri Furia<br><b>Cc:</b> Lorenzo<br>" +
      "<b>Oggetto:</b> Re: R: R: R: Chinon: Modello 3D</p>" +
      "</div></div>" +
      "<blockquote>contenuto più profondo</blockquote>" +
      "</div>";
    const out = transformHtml(html);
    // depth-0 produces a toggle before the second WordSection1;
    // depth-1 produces a second toggle inside it (before outer-wrapper-B). Both are correct.
    expect(toggles(out)).toBeGreaterThanOrEqual(1);
    // The outermost (first) toggle must precede all quoted content.
    expect(at(out, "Yuri nuova risposta")).toBeLessThan(at(out, "q-tgl"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "Yuri Furia"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "In IFC"));
    expect(at(out, "q-tgl")).toBeLessThan(at(out, "contenuto"));
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
