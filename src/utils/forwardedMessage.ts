/**
 * Transforms raw "---------- Forwarded message ---------" blocks and reply
 * attribution lines ("On DATE, NAME <email> wrote:") into styled collapsible
 * components, for both plain-text and HTML emails.
 *
 * CSS/JS constants are injected into the iframe srcdoc by EmailRenderer.
 */

import { t } from "@/i18n";

const HEADER_KEYS = new Set([
  "from", "date", "subject", "to", "cc", "bcc", "reply-to",
  "sent", "mailed-by", "signed-by", "delivered-to",
]);

/** Maps locale header keys → canonical English key checked against HEADER_KEYS. */
const LOCALE_HEADER_MAP: Record<string, string> = {
  // Italian
  "da": "from", "inviato": "sent", "data": "date",
  "a": "to", "oggetto": "subject", "rispondi a": "reply-to",
  // French
  "de": "from", "envoyé": "sent", "envoye": "sent",
  "à": "to", "objet": "subject",
  // Spanish
  "enviado": "sent", "enviado el": "sent", "para": "to", "asunto": "subject",
  // German
  "von": "from", "gesendet": "sent", "an": "to", "betreff": "subject",
};

const CHEVRON = `<svg class="fw-chv" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;
const DOTS_HTML = `<span class="q-dots"><span class="q-dot"></span><span class="q-dot"></span><span class="q-dot"></span></span>`;

/**
 * CSS variables are set per-theme by buildAccentOverride (last rule wins).
 * Light defaults use indigo; dark defaults are solid neutrals.
 * Both light and dark text/muted/line vars live in FW_CSS/:root so they can
 * be overridden by FW_DARK_CSS without touching the accent vars.
 */
export const FW_CSS = `
:root{
  --fw-accent:#6366f1;
  --fw-bg:rgba(99,102,241,.09);
  --fw-hd-hover:rgba(99,102,241,.18);
  --fw-pill:rgba(99,102,241,.09);
  --fw-pill-hover:rgba(99,102,241,.20);
  --fw-border:rgba(0,0,0,.10);
  --fw-line:rgba(0,0,0,.09);
  --fw-text:#1a1612;
  --fw-muted:#6b6259
}
.fw-blk{margin:10px 0;overflow:hidden;border-left:2.5px solid var(--fw-accent);border-radius:3px 12px 12px 3px}
.fw-hd{display:flex;align-items:center;gap:7px;padding:12px 16px;cursor:pointer;user-select:none;font-family:system-ui,-apple-system,sans-serif;font-size:13px;line-height:1.35;background:var(--fw-bg)}
.fw-hd:hover{background:var(--fw-hd-hover)}
.fw-blk.fw-plain .fw-hd{cursor:default}
.fw-chv{color:var(--fw-accent);transition:transform .2s ease;flex-shrink:0}
.fw-blk:not(.fw-open)>.fw-hd .fw-chv{transform:rotate(-90deg)}
.fw-from{font-weight:600;color:var(--fw-text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.fw-sep{color:var(--fw-muted);flex-shrink:0;padding:0 1px}
.fw-date{color:var(--fw-muted);font-size:12px;flex-shrink:0;white-space:nowrap}
.fw-subj{color:var(--fw-muted);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.fw-meta{display:grid;grid-template-columns:auto 1fr;row-gap:4px;column-gap:12px;padding:0 16px 13px;font-size:12px;font-family:system-ui,-apple-system,sans-serif;border-top:1px solid var(--fw-line);padding-top:9px;background:var(--fw-bg)}
.fw-lbl{color:var(--fw-muted);font-weight:600;white-space:nowrap;padding-top:1px;text-transform:uppercase;font-size:10.5px;letter-spacing:.04em}
.fw-val{color:var(--fw-text);word-break:break-word}
.fw-blk:not(.fw-open)>.fw-meta,.fw-blk:not(.fw-open)>.fw-body{display:none}
.fw-body{padding:12px 16px 14px;border-top:1px solid var(--fw-line);color:var(--fw-text);overflow-x:auto;background:color-mix(in srgb,var(--fw-bg) 30%,transparent)}
.fw-body blockquote,.fw-body .gmail_quote,.fw-body [style*="border-left"],.q-quote blockquote,.q-quote .gmail_quote,.q-quote [style*="border-left"]{border-left:0 !important;margin-left:0 !important;padding-left:0 !important}
`;

export const FW_DARK_CSS = ``;

export const QUOTE_CSS = `
.q-tgl{display:inline-flex;align-items:center;gap:7px;padding:6px 13px;margin:6px 0;background:var(--fw-pill);color:var(--fw-accent);border:1px solid color-mix(in srgb,var(--fw-accent) 30%,transparent);border-radius:999px;font-size:12.5px;font-weight:600;font-family:system-ui,-apple-system,sans-serif;cursor:pointer;vertical-align:middle;line-height:1.35;transition:background .15s,border-color .15s,color .15s}
.q-tgl:hover{background:var(--fw-pill-hover);border-color:color-mix(in srgb,var(--fw-accent) 45%,transparent)}
.q-tgl[aria-expanded="true"]{background:transparent;color:var(--fw-muted);border-color:color-mix(in srgb,var(--fw-muted) 22%,transparent)}
.q-dots{display:flex;gap:2.5px;align-items:center;flex-shrink:0}
.q-dot{display:block;width:3.5px;height:3.5px;border-radius:50%;background:currentColor}
.q-label{color:inherit}
.q-hidden{display:none!important}
.q-quote{color:var(--fw-muted)}
`;

export const QUOTE_DARK_CSS = ``;

/**
 * Parses a hex color string (#RRGGBB or #RGB) into "r,g,b" for use in rgba().
 */
function hexToRgbStr(hex: string): string {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full.slice(0, 6), 16);
  if (isNaN(n)) return "99,102,241";
  return `${(n >> 16) & 0xff},${(n >> 8) & 0xff},${n & 0xff}`;
}

/**
 * Sets ALL theme-aware CSS variables for fw-blk and q-tgl, running last so it
 * wins over FW_CSS and FW_DARK_CSS defaults. Callers must pass accentLight from
 * the theme (e.g. "rgba(155,194,135,0.14)") so we use the EXACT design-system
 * value as the surface tint instead of a hardcoded alpha approximation.
 *
 * Text vars (--fw-text, --fw-muted) are also set here to guarantee the correct
 * foreground color regardless of what the email HTML itself inherits.
 */
export function buildAccentOverride(accent: string, isDark: boolean, accentLight?: string): string {
  const rgb = hexToRgbStr(accent);
  const bg = accentLight ?? `rgba(${rgb},${isDark ? ".14" : ".09"})`;
  const hover = `rgba(${rgb},${isDark ? ".24" : ".18"})`;
  const pill = `rgba(${rgb},${isDark ? ".20" : ".12"})`;
  const pillHover = `rgba(${rgb},${isDark ? ".30" : ".20"})`;
  const text = isDark ? "#e8eaed" : "#1a1612";
  const muted = isDark ? "#9aa0a6" : "#6b6259";
  const border = isDark ? "rgba(255,255,255,.10)" : `rgba(${rgb},.12)`;
  return `:root{--fw-accent:${accent};--fw-bg:${bg};--fw-hd-hover:${hover};--fw-pill:${pill};--fw-pill-hover:${pillHover};--fw-border:${border};--fw-text:${text};--fw-muted:${muted}}`;
}

export const FW_JS = `document.querySelectorAll('.fw-hd').forEach(function(h){h.addEventListener('click',function(){var blk=h.closest('.fw-blk');if(!blk||blk.classList.contains('fw-plain'))return;blk.classList.toggle('fw-open')})});document.querySelectorAll('.q-tgl').forEach(function(b){b.addEventListener('click',function(){var q=b.nextElementSibling;if(!q)return;var hidden=q.classList.toggle('q-hidden');b.setAttribute('aria-expanded',hidden?'false':'true')})});`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&").replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");
}

function normalizeKey(raw: string): string {
  const low = raw.toLowerCase();
  return LOCALE_HEADER_MAP[low] ?? low;
}

function parseHeaderLine(line: string): [string, string] | null {
  const i = line.indexOf(":");
  // Allow i >= 1 so single-char locale keys like "A:" (Italian To) are accepted
  if (i < 1 || i > 20) return null;
  const raw = line.slice(0, i).trim();
  const norm = normalizeKey(raw);
  if (!HEADER_KEYS.has(norm)) return null;
  const val = line.slice(i + 1).trim();
  // Display the normalized English key so the block is always in English
  return val ? [norm.charAt(0).toUpperCase() + norm.slice(1), val] : null;
}

function buildBlock(headers: Array<[string, string]>, label = "Forwarded message", bodyHtml = ""): string {
  if (!headers.length) return "";
  const get = (key: string) => headers.find(([k]) => k.toLowerCase() === key)?.[1] ?? "";
  const from = get("from");
  const date = get("date") || get("sent");
  const subject = get("subject");

  // Only To and Cc appear in the expandable meta — From/Date/Subject are in the header line
  const metaRows = headers
    .filter(([k]) => ["to", "cc"].includes(k.toLowerCase()))
    .map(([k, v]) => `<div class="fw-lbl">${k}</div><div class="fw-val">${v}</div>`)
    .join("");
  const hasDetail = !!metaRows;
  // Block is collapsible whenever it has meta rows OR a body — not just when it has meta.
  const hasToggle = hasDetail || !!bodyHtml;

  const hFrom = `<span class="fw-from">${from || label}</span>`;
  const hDate = date ? `<span class="fw-sep">·</span><span class="fw-date">${date}</span>` : "";
  const hSubj = subject ? `<span class="fw-sep">—</span><span class="fw-subj">${subject}</span>` : "";

  return (
    `<div class="fw-blk${hasToggle ? "" : " fw-plain"}">` +
    `<div class="fw-hd">${hasToggle ? CHEVRON : ""}${hFrom}${hDate}${hSubj}</div>` +
    (hasDetail ? `<div class="fw-meta">${metaRows}</div>` : "") +
    (bodyHtml ? `<div class="fw-body">${bodyHtml}</div>` : "") +
    `</div>`
  );
}

// ---------------------------------------------------------------------------
// Reply attribution: "On DATE, NAME <email> wrote:" and locale variants
// ---------------------------------------------------------------------------

interface Attribution {
  name: string;
  email: string;
  date: string;
}

/**
 * Matches locale-aware reply attribution lines:
 *   English:    "On Mon, 20 May 2025 at 10:08, John Doe <j@x.com> wrote:"
 *   English:    "On 23/05/2026, 14:58:42, email@x.com wrote:"  (bare email, no name)
 *   Italian:    "Il 18 mag 2026, 15:51 +0200, Studio Fraietta <i@x.com>, ha scritto:"
 *   French:     "Le 20 mai 2025 à 10:08, Jean Dupont <j@x.com> a écrit :"
 *   Spanish:    "El 20 de mayo de 2025, 10:08, Juan <j@x.com> escribió:"
 *   Portuguese: "Em 20 de maio de 2025, João <j@x.com> escreveu:"
 *
 * Strategy: greedy (.+) before the last ", NAME <email>" or bare email, so date ends at
 * the rightmost comma+space before the sender. Two alternatives in the sender group:
 *   • Name <email>  (groups 2 + 3)
 *   • bare email@domain  (group 4)
 */
const ATTRIB_RE =
  /^(?:on|il|le|am|el|em)\s+(.+),\s+(?:(.+?)\s+<([^>@\s]+@[^>\s]+)>|([^@\s<>]+@[^@\s<>,]+))\s*,?\s*(?:wrote|ha scritto|a [eé]crit|schrieb|escribi[oó]|escreveu)\s*:[ \t]*$/i;

function parseAttribution(text: string): Attribution | null {
  // Outlook's HTML→text conversion appends the link target after the address:
  // "Name <addr@x.it<mailto:addr@x.it>>". The trailing ">" left over from the inner
  // angle brackets breaks the sender group, so drop the "<mailto:…>" artifact first.
  const m = text.trim().replace(/<mailto:[^<>]*>/gi, "").match(ATTRIB_RE);
  if (!m) return null;
  // m[2]+m[3] = Name <email>; m[4] = bare email (no name)
  const email = (m[3] ?? m[4] ?? "").trim();
  const name = m[4] ? email : (m[2] ?? "").trim();
  return { date: (m[1] ?? "").trim(), name, email };
}

function buildAttributionBlock(attr: Attribution): string {
  const headers: Array<[string, string]> = [
    ["From", `${esc(attr.name)} &lt;${esc(attr.email)}&gt;`],
  ];
  if (attr.date) headers.push(["Date", esc(attr.date)]);
  return buildBlock(headers, "In reply to");
}

function innerToPlain(inner: string): string {
  return decodeEntities(
    inner.replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").trim(),
  );
}

// ---------------------------------------------------------------------------
// Plain-text transform
// ---------------------------------------------------------------------------

const PRE = (s: string) =>
  s ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${esc(s)}</pre>` : "";

// Source string for attribution detection in plain text (recreated per call to reset lastIndex).
// Matches both "Name <email>" and bare "email@x.com" sender formats.
const ATTRIB_LINE_SRC =
  /^[ \t]*(?:on|il|le|am|el|em)\s+.+,\s+(?:.+<[^>]+@[^>]+>|[^@\s<>]+@[^@\s<>]+).*?(?:wrote|ha scritto|a [eé]crit|schrieb|escribi[oó]|escreveu)\s*:[ \t]*$/.source;

function segToHtml(seg: string): string {
  if (!seg) return "";
  const re = new RegExp(ATTRIB_LINE_SRC, "gim");
  const parts: string[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(seg)) !== null) {
    parts.push(PRE(seg.slice(last, m.index)));
    const attr = parseAttribution(m[0].trim());
    parts.push(attr ? buildAttributionBlock(attr) : PRE(m[0]));
    last = m.index + m[0].length;
  }
  parts.push(PRE(seg.slice(last)));
  return parts.join("");
}

/**
 * Collapses consecutive ">"-prefixed lines (standard plain-text quoting) behind
 * a three-dots toggle. Each contiguous block of ">" lines becomes one toggle.
 */
function collapseGtQuotes(html: string): string {
  // Operates on <pre>-wrapped segments produced by segToHtml.
  // Replace each <pre> whose content has any ">"-prefixed lines, splitting at the
  // first such line so everything from that point folds behind the toggle.
  return html.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (full, inner) => {
    const lines = inner.split(/\r?\n/);
    const firstQuote = lines.findIndex((l: string) => /^&gt;/.test(l.trimStart()));
    if (firstQuote < 0) return full;
    // Must have some visible text before the quote.
    const before = lines.slice(0, firstQuote).join("\n");
    if (!before.trim()) return full;
    const quoted = lines.slice(firstQuote).join("\n");
    const lineCount = quoted.split("\n").filter((l: string) => l.trim().length > 0).length;
    const btnLabel = lineCount > 0
      ? t("email.renderer.showNQuotedLines", { count: lineCount })
      : t("email.renderer.showQuotedText");
    const btn = `<button class="q-tgl" type="button" aria-expanded="false" aria-label="${esc(btnLabel)}" title="${esc(btnLabel)}">${DOTS_HTML}<span class="q-label">${esc(btnLabel)}</span></button>`;
    return (
      `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${before}</pre>` +
      btn +
      `<pre class="q-quote q-hidden" style="white-space:pre-wrap;font-family:inherit;margin:0;">${quoted}</pre>`
    );
  });
}

/**
 * Transforms forwarded blocks in plain-text emails.
 * Returns HTML with <pre> segments interleaved with fw-blk components.
 */
export function transformPlainText(text: string): string {
  // Matches various separator formats used by different clients:
  // Gmail/Apple: "---------- Forwarded message ---------"
  // Outlook:     "-----Original Message-----" / "-----Original Email-----"
  // Thunderbird: "-------- Forwarded Message --------"
  // Apple Mail:  "Begin forwarded message:"
  const FW_RE =
    /(?:[ \t]*-{3,}[ \t]*(?:Forwarded\s+(?:message|mail|email)|Original\s+(?:message|mail|email)|Messaggio\s+inoltrato|Message\s+(?:transmis|transf[eé]r[eé])|Mensaje\s+reenviado)[ \t]*-{3,}[ \t]*|Begin\s+forwarded\s+message:[ \t]*)\r?\n\r?\n?((?:[ \t]*(?:From|Da|De|Von|Date|Data|Inviato|Sent|Gesendet|Subject|Oggetto|Objet|Asunto|Betreff|To|A|An|Cc|Bcc|Reply-To)[ \t]*:[^\n]+\r?\n?)+)/gi;

  const segments: string[] = [];
  const blocks: Array<Array<[string, string]>> = [];
  let last = 0;
  let m: RegExpExecArray | null;

  while ((m = FW_RE.exec(text)) !== null) {
    segments.push(text.slice(last, m.index));
    const headers: Array<[string, string]> = (m[1] ?? "")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => parseHeaderLine(line.trim()))
      .filter((h): h is [string, string] => h !== null)
      .map(([k, v]) => [k, esc(v)]);
    blocks.push(headers);
    last = m.index + m[0].length;
  }
  segments.push(text.slice(last));

  if (!blocks.length) {
    // No forwarded blocks — still scan for attribution lines, then ">"-quotes.
    return collapseGtQuotes(segToHtml(text));
  }

  // segments[0] = preamble; segments[i+1] = body of blocks[i]
  const parts: string[] = [segToHtml(segments[0] ?? "")];
  for (let i = 0; i < blocks.length; i++) {
    parts.push(buildBlock(blocks[i] ?? [], "Forwarded message", segToHtml(segments[i + 1] ?? "")));
  }
  return collapseGtQuotes(parts.join(""));
}

// ---------------------------------------------------------------------------
// HTML transform
// ---------------------------------------------------------------------------

/** Returns the canonical key if a trimmed line begins with a recognized header key. */
function headerKeyOf(line: string): string | null {
  const i = line.indexOf(":");
  // Allow i >= 1 for single-char locale keys like "A:" (Italian To);
  // allow up to 25 chars to cover "Enviado el" / "Rispondi a" multi-word keys
  if (i < 1 || i > 25) return null;
  const norm = normalizeKey(line.slice(0, i).trim());
  return HEADER_KEYS.has(norm) ? norm : null;
}

function parseHtmlHeaders(block: string): Array<[string, string]> {
  const text = block
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;|&#160;| /g, " ");

  // Hanging value: some Outlook variants put the key ("Da:") on its own line and the
  // value ("Mirko Landenna <m@x>") on the next — common in deeply nested forwards. We
  // adopt the next line as the value when that next line isn't itself a header line.
  const lines = text.split(/\n+/).map((l) => l.trim()).filter(Boolean);
  const out: Array<[string, string]> = [];
  for (let li = 0; li < lines.length; li++) {
    const norm = headerKeyOf(lines[li]!);
    if (!norm) continue;
    let val = lines[li]!.slice(lines[li]!.indexOf(":") + 1).trim();
    if (!val && li + 1 < lines.length && !headerKeyOf(lines[li + 1]!)) {
      val = lines[li + 1]!;
      li++;
    }
    if (val) out.push([norm.charAt(0).toUpperCase() + norm.slice(1), val]);
  }
  return out;
}

const WROTE_RE = /(?:wrote|ha scritto|a [eé]crit|schrieb|escribi[oó]|escreveu)\s*:/i;

// Recognizes a reply-attribution LINE: a leading date keyword (On / Il [giorno] /
// Le / Am / El / Em / Den), then somewhere a year, an email "@", or a clock time,
// then the "wrote:" verb. The leading-keyword anchor (^) plus the date/@/time guard
// keep ordinary prose like "Il libro che ha scritto:" from matching.
const ATTR_LINE_RE =
  /^\s*(?:on|il(?:\s+giorno)?|le|am|el|em|den)\b[\s\S]{0,250}?(?:\d{4}|@|\d{1,2}:\d{2})[\s\S]{0,160}?(?:wrote|ha scritto|a [eé]crit|schrieb|escribi[oó]|escreveu)\s*:/i;

// Forwarded-message separators across clients ("---------- Forwarded message ---------",
// "Messaggio inoltrato", "Begin forwarded message", etc.).
const FW_SEP_RE =
  /(?:-{2,}\s*(?:forwarded\s+(?:message|mail|email)|original\s+(?:message|mail|email)|messaggio\s+inoltrato|message\s+(?:transmis|transf[eé]r[eé])|mensaje\s+reenviado|weitergeleitete\s+nachricht)\b|begin\s+forwarded\s+message|inizio\s+messaggio\s+inoltrato)/i;

// The first header line of a forwarded/replied block (From:/Da:/De:/Date:/Subject:…),
// used together with a preceding <hr> as the Outlook reply signal.
const HEADER_LINE_RE =
  /^\s*(?:from|da|de|von|date|data|sent|inviato|envoy[eé]|gesendet|to|a\b|à|an|subject|oggetto|objet|asunto|betreff)\s*:/i;

// A run of Outlook/Word reply-header text: a From-equivalent key (From/Da/De/Von),
// then within a short span another header key (Sent/Date/To/Subject equivalents).
// Two keyed lines in close proximity reliably mark a forwarded/reply header block and
// won't fire on ordinary prose. Used to recognise a border-top divider whose fw-blk
// was not built by the regex passes.
const FW_HEADER_BLOCK_RE =
  /\b(?:from|da|de|von)\s*:[\s\S]{0,400}?\b(?:sent|inviato|envoy[eé]|gesendet|date|data|to|oggetto|subject|objet|asunto|betreff)\s*:/i;

function makeToggle(doc: Document, label: string, lineCount = 0): HTMLButtonElement {
  const btn = doc.createElement("button");
  btn.className = "q-tgl";
  btn.setAttribute("type", "button");
  btn.setAttribute("aria-expanded", "false");
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  const displayLabel = lineCount > 0
    ? t("email.renderer.showNQuotedLines", { count: lineCount })
    : label;
  btn.innerHTML = `${DOTS_HTML}<span class="q-label">${esc(displayLabel)}</span>`;
  return btn;
}

/** Next sibling that isn't whitespace text or a <br>. */
function nextSignificantSibling(node: ChildNode): ChildNode | null {
  let n = node.nextSibling;
  while (n && ((n.nodeType === Node.TEXT_NODE && !n.textContent?.trim())
    || (n.nodeType === Node.ELEMENT_NODE && (n as Element).tagName === "BR"))) {
    n = n.nextSibling;
  }
  return n;
}

/**
 * True if a node marks the start of quoted/forwarded history. Recognized signals,
 * all reliable enough not to fire on ordinary body content:
 *   • reply attribution line ("On … wrote:", "Il giorno … ha scritto:")
 *   • forwarded-message separator ("---------- Forwarded message ---------")
 *   • a styled fw-blk header already built by the regex passes
 *   • explicit quote markers: .gmail_quote, blockquote[type=cite]
 *   • an <hr> immediately followed by a header line (Outlook reply divider)
 */
function isQuoteStart(node: Node): boolean {
  if (node.nodeType === Node.TEXT_NODE) {
    const t = node.textContent ?? "";
    return ATTR_LINE_RE.test(t) || FW_SEP_RE.test(t);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const el = node as Element;
  const tag = el.tagName;

  if (el.classList.contains("fw-blk")) return true;
  if (el.classList.contains("gmail_quote")) return true;
  if (tag === "BLOCKQUOTE" && el.getAttribute("type") === "cite") return true;

  if (tag === "HR") {
    const next = nextSignificantSibling(el);
    return !!next && HEADER_LINE_RE.test((next.textContent ?? "").trim());
  }

  // Outlook reply divider: a <div> with border-top CSS that wraps a header block — either
  // a pre-built fw-blk OR raw Outlook header text ("Da: … Inviato: … Oggetto: …"). The raw
  // case matters because the regex passes sometimes fail to build the fw-blk (e.g. an empty
  // <p></p> right before the divider makes the Case-5 regex bridge across block boundaries).
  // Detecting the outer div (pre-order traversal finds it before the inner header) ensures
  // collapseQuotes moves the div PLUS all following siblings (old message body) into the
  // hidden wrapper — not just the inner siblings.
  if (tag === "DIV" && /border-top/i.test(el.getAttribute("style") ?? "")
    && (el.querySelector(".fw-blk") || FW_HEADER_BLOCK_RE.test(el.textContent ?? ""))) {
    return true;
  }

  // Outlook outer wrapper: a plain <div> that wraps a border-top header div as its last
  // meaningful element child. This div often also contains a preamble paragraph (e.g.
  // "Uso Interno / Internal Use") before the header, and the forwarded body lives as a
  // SIBLING of this wrapper — not inside it. Recognising the wrapper as the quote start
  // (pre-order traversal visits it first) means collapseQuotes moves the wrapper PLUS
  // its following siblings (the actual forwarded body) into the hidden section.
  if (tag === "DIV" && !el.getAttribute("style")?.match(/border-top/i)) {
    let lastEl: Element | null = null;
    for (let c = el.lastElementChild; c; c = c.previousElementSibling) {
      if (c.tagName !== "BR") { lastEl = c; break; }
    }
    if (lastEl && /border-top/i.test(lastEl.getAttribute("style") ?? "")
      && (lastEl.querySelector(".fw-blk") || FW_HEADER_BLOCK_RE.test(lastEl.textContent ?? ""))) {
      return true;
    }
  }

  // Fallback for consecutive single-header <p> elements not caught by Case 6 (e.g. no bold
  // tags). The first <p> whose text starts with a "From/Da/De/Von" key, whose next sibling
  // is also a header line, is treated as the quote start.
  if (tag === "P" || tag === "DIV") {
    const text = (el.textContent ?? "").trim();
    if (/^(?:from|da|de|von)\s*:/i.test(text)) {
      const next = nextSignificantSibling(el as ChildNode);
      if (next && HEADER_LINE_RE.test((next.textContent ?? "").trim())) {
        return true;
      }
    }
  }

  // Leaf-ish line whose own text is an attribution / separator. The length cap stops a
  // big wrapper (that also holds the new message above the quote) from matching — the
  // TreeWalker visits parents before children, so we still reach the tight inner line.
  const text = (el.textContent ?? "").trim();
  return text.length <= 600 && (ATTR_LINE_RE.test(text) || FW_SEP_RE.test(text));
}

/**
 * Promotes an anchor node upward through the DOM tree as long as:
 *   • the current node has no meaningful content BEFORE it in its parent
 *     (only whitespace text nodes or <br> elements)
 *   • the parent is not the document body
 *
 * Purpose: when the walker lands on a text node like "On DATE, Name wrote:" that
 * is the FIRST child of a <div style="border-left:..."> wrapper, we want the
 * collapse to fold the ENTIRE wrapper — not just the content inside it.
 *
 * Example: text node → <div style="border-left:2px solid #ccc"> → body
 *   • no content before the text node in its parent div → bubble up
 *   • div's parent is body → stop
 *   → anchor becomes the border-left div itself
 */
function promoteAnchor(anchor: Node, body: Element): ChildNode {
  let n: Node = anchor;
  while (true) {
    const parent = n.parentNode;
    if (!parent || parent === body) break;
    let sib = (n as ChildNode).previousSibling;
    let hasBefore = false;
    while (sib) {
      if (sib.nodeType === Node.TEXT_NODE && (sib.textContent ?? "").trim()) { hasBefore = true; break; }
      if (sib.nodeType === Node.ELEMENT_NODE && (sib as Element).tagName !== "BR") { hasBefore = true; break; }
      sib = sib.previousSibling;
    }
    if (hasBefore) break;
    n = parent;
  }
  return n as ChildNode;
}

// Whether ≥`min` non-whitespace characters of visible text appear BEFORE `anchor`
// within `root`. This is the guard that stops collapseQuotes from folding a message
// to nothing (a top-posted quote with no reply above it).
//
// It replaces an earlier `range.toString()` approach: jsdom's Range.toString() is
// pathologically slow (~hundreds of ms) on a large container even when the range is
// short, and it was called once per quote-start candidate — the single dominant cost
// of collapseQuotes on big reply chains (seconds of main-thread jank per message).
// A TreeWalker over text nodes short-circuits the instant it has counted `min` chars;
// because the reply body precedes the quote in document order, that is almost always
// the very first text node.
function hasVisibleTextBefore(root: Element, anchor: Node, min = 2): boolean {
  try {
    const doc = root.ownerDocument;
    const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let count = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // TreeWalker yields document order; once a node is no longer strictly before the
      // anchor, nothing after it is either — stop.
      if ((anchor.compareDocumentPosition(n) & Node.DOCUMENT_POSITION_PRECEDING) === 0) break;
      count += (n.textContent ?? "").replace(/\s/g, "").length;
      if (count >= min) return true;
    }
    return count >= min;
  } catch {
    return false;
  }
}

/**
 * Collapses quoted reply / forwarded history behind a three-dots toggle (Gmail-style).
 * The cut lands AT the attribution / forward separator (not after it), so it folds
 * together with the quote.
 *
 * Safety rails — this runs on every rendered message, so it must never hide real
 * content or corrupt layout:
 *   • only fires on the explicit quote signals in isQuoteStart (no bare-<blockquote>
 *     guessing, which used to swallow received messages whose body is a blockquote);
 *   • refuses to collapse when there is no visible content ABOVE the quote (otherwise
 *     a reply with the quote on top would render as nothing but "…");
 *   • leaves table-structured layouts alone (moving cells/rows would break them);
 *   • wrapped in try/catch so a parsing hiccup can never blank out the message.
 */
const QUOTE_MARKER_RE = /<blockquote|gmail_quote|fw-blk|<hr|ha scritto|wrote\s*:|a [eé]crit|schrieb|escrib|escreveu|forwarded message|messaggio inoltrato|original message|inizio messaggio inoltrato|border-left|border-top/i;

/**
 * DOM-based pass that converts Outlook/Word "border-top" divider blocks whose header was
 * NOT already turned into an fw-blk by the regex passes into a formatted fw-blk box — so
 * the styled box appears UNIFORMLY for every forwarded/reply header, regardless of how
 * deeply the divider is nested.
 *
 * Why a DOM pass instead of more regex: Case 5's <p> regex is bounded ({1,1500}) and
 * desyncs on long quoted-body paragraphs in deep reply chains, so nested Outlook headers
 * were left as raw "Da: … Inviato: …" text. Walking the DOM finds every divider reliably.
 *
 * Conservative: only replaces the single header-bearing <p> inside the divider (leaving
 * any surrounding structure intact), and only when that <p> parses to a real header block
 * (a From-equivalent key plus at least one more). Idempotent — skips dividers already
 * holding an fw-blk.
 */
function boxOutlookHeaders(html: string): string {
  if (!/border-top/i.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    let changed = false;
    doc.querySelectorAll("div").forEach((div) => {
      if (!/border-top/i.test(div.getAttribute("style") ?? "")) return;
      if (div.querySelector(".fw-blk")) return; // already boxed by a regex pass
      // Locate the header-bearing <p> (the divider may hold a preamble <p> too).
      let target: Element | null = null;
      for (const p of Array.from(div.querySelectorAll("p"))) {
        if (FW_HEADER_BLOCK_RE.test(p.textContent ?? "")) { target = p; break; }
      }
      if (!target) return;
      const headers = parseHtmlHeaders(target.innerHTML);
      if (headers.length < 2 || !headers.some(([k]) => k.toLowerCase() === "from")) return;
      const holder = doc.createElement("div");
      holder.innerHTML = buildBlock(headers, "Forwarded message");
      const blk = holder.firstElementChild;
      if (!blk) return;
      target.replaceWith(blk);
      changed = true;
    });
    return changed ? doc.body.innerHTML : html;
  } catch {
    return html; // never let a parsing hiccup blank out the message body
  }
}

/**
 * DOM-based pass that converts a reply-attribution line ("Il DATE, NAME <email>, ha
 * scritto:" and locale variants) into an "In reply to" fw-blk box — for the case where
 * the attribution is a bare TEXT NODE sitting next to a <blockquote> inside the same
 * container (Apple Mail / mobile / `<div name="messageReplySection">`).
 *
 * The regex Case 4 can't handle these: its container also holds the quoted <blockquote>,
 * which trips the nested-block guard, so the attribution stayed as raw text. Walking text
 * nodes finds the attribution directly and boxes only it, leaving the quote intact next to
 * the new box so collapseQuotes can still fold both behind the three-dots toggle.
 */
function boxReplyAttributions(html: string): string {
  if (!WROTE_RE.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const txt = (n.textContent ?? "").trim();
      if (txt && WROTE_RE.test(txt) && parseAttribution(txt)) targets.push(n as Text);
    }
    if (!targets.length) return html;
    let changed = false;
    for (const node of targets) {
      if (node.parentElement?.closest(".fw-blk")) continue; // already boxed
      // Leave table-structured quote layouts untouched (boxing a cell's text could
      // disrupt the table); collapseQuotes also refuses to restructure tables.
      if (node.parentElement?.closest("table")) continue;
      const attr = parseAttribution((node.textContent ?? "").trim());
      if (!attr) continue;
      const holder = doc.createElement("div");
      holder.innerHTML = buildAttributionBlock(attr);
      const blk = holder.firstElementChild;
      if (!blk) continue;
      const next = node.nextSibling;
      node.replaceWith(blk);
      // Drop a trailing <br> that used to separate the attribution from the quote.
      if (next && next.nodeType === Node.ELEMENT_NODE && (next as Element).tagName === "BR") {
        next.remove();
      }
      changed = true;
    }
    return changed ? doc.body.innerHTML : html;
  } catch {
    return html; // never let a parsing hiccup blank out the message body
  }
}

// Cheap pre-filter for a text node that may hold a plain-text Outlook header run
// ("Da: … / Inviato: … / A: …"). Only the From-equivalent key is checked here; the
// per-line scan does the real validation.
const PLAIN_HEADER_HINT_RE = /(?:^|\n)[ \t]*(?:from|da|de|von)[ \t]*:/i;

/**
 * Builds the replacement for one multi-line plain-text node: the attribution lines
 * ("On … wrote:") and Outlook header runs ("Da:/Inviato:/A:/Oggetto:") inside it become
 * fw-blk boxes, every other line survives verbatim as text. Returns null when the node
 * holds nothing to box, so the caller can leave it untouched.
 */
function fragmentFromPlainLines(doc: Document, text: string): DocumentFragment | null {
  const lines = text.split("\n");
  const frag = doc.createDocumentFragment();
  let pending: string[] = [];
  let blocks = 0;

  const flush = () => {
    if (!pending.length) return;
    frag.appendChild(doc.createTextNode(pending.join("\n")));
    pending = [];
  };
  const appendBlock = (blockHtml: string) => {
    const holder = doc.createElement("div");
    holder.innerHTML = blockHtml;
    while (holder.firstChild) frag.appendChild(holder.firstChild);
    blocks++;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.trim();

    // No cap on how many boxes one node may yield: a partial pass would box the first
    // N headers of a long chain and leave the rest as raw text, which reads as a bug.
    if (trimmed) {
      if (WROTE_RE.test(trimmed)) {
        const attr = parseAttribution(trimmed);
        if (attr) {
          flush();
          appendBlock(buildAttributionBlock(attr));
          continue;
        }
      }

      // Outlook header run: a From-equivalent key followed by more header lines,
      // each on its own line. Same two-keys-in-a-row heuristic the HTML passes use.
      // Blank lines between fields are tolerated, and a key whose value hangs on the
      // next line ("Da:" alone, sender below) is joined — both shapes appear in the
      // text/plain rendering of an Outlook forward, exactly as parseHtmlHeaders
      // already handles them for the markup version.
      if (headerKeyOf(trimmed) === "from") {
        const headers: Array<[string, string]> = [];
        let j = i;
        for (; j < lines.length; j++) {
          const l = lines[j]!.trim();
          if (!l) continue;
          const key = headerKeyOf(l);
          if (!key) break;
          let val = l.slice(l.indexOf(":") + 1).trim();
          if (!val) {
            let k = j + 1;
            while (k < lines.length && !lines[k]!.trim()) k++;
            const hanging = k < lines.length ? lines[k]!.trim() : "";
            if (hanging && !headerKeyOf(hanging)) {
              val = hanging;
              j = k;
            }
          }
          val = val.replace(/<mailto:[^<>]*>/gi, "");
          if (val) headers.push([key.charAt(0).toUpperCase() + key.slice(1), esc(val)]);
        }
        if (headers.length >= 2) {
          flush();
          appendBlock(buildBlock(headers, "Forwarded message"));
          i = j - 1;
          continue;
        }
      }
    }

    pending.push(line);
  }

  flush();
  return blocks ? frag : null;
}

/**
 * DOM pass for quoted history that arrives as PLAIN TEXT inside a single HTML text node —
 * the shape our own composer produces when replying to a text-only message, and the shape
 * Outlook's HTML→text conversion leaves behind (`addr@x.it<mailto:addr@x.it>` artifacts and
 * "Da:/Inviato:" runs separated by newlines rather than markup).
 *
 * boxReplyAttributions can't touch these: it requires the WHOLE text node to be one
 * attribution, whereas here a single ~1 MB node holds an entire nested conversation. This
 * pass scans such nodes line by line and splits them, so every attribution and header run
 * gets the same styled box as its markup-based equivalent.
 */
function boxPlainTextQuoteLines(html: string): string {
  if (!WROTE_RE.test(html) && !PLAIN_HEADER_HINT_RE.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
    const targets: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const txt = n.textContent ?? "";
      // Single-line nodes are boxReplyAttributions' job; only multi-line ones land here.
      if (!txt.includes("\n")) continue;
      if (!WROTE_RE.test(txt) && !PLAIN_HEADER_HINT_RE.test(txt)) continue;
      // Leave table-structured layouts alone, as the other passes do.
      if ((n as Text).parentElement?.closest("table")) continue;
      targets.push(n as Text);
    }
    if (!targets.length) return html;

    let changed = false;
    for (const node of targets) {
      const frag = fragmentFromPlainLines(doc, node.textContent ?? "");
      if (!frag) continue;
      node.replaceWith(frag);
      changed = true;
    }
    return changed ? doc.body.innerHTML : html;
  } catch {
    return html; // never let a parsing hiccup blank out the message body
  }
}

function collapseQuotes(html: string): string {
  // Cheap guard: skip the DOM round-trip for emails with no quote/forward markers.
  if (!QUOTE_MARKER_RE.test(html)) return html;

  try {
    // Parse ONCE and serialize ONCE. Nested collapsing recurses on the live wrapper
    // node (collapseInContainer), NOT by re-serializing + re-parsing wrapper.innerHTML
    // at each level. The old string round-trip was pathologically slow on deeply
    // nested reply chains (100+ blockquotes): DOM parse/serialize is super-linear in
    // nesting depth, and it ran 3 extra times over a near-full-body payload — seconds
    // of main-thread jank per message. Working on the live DOM keeps it to one pass.
    const doc = new DOMParser().parseFromString(html, "text/html");
    // Return the ORIGINAL string when nothing collapsed, so we never leak the parser's
    // normalization (e.g. injected <tbody>) into an otherwise-untouched body.
    return collapseInContainer(doc.body, 0) ? doc.body.innerHTML : html;
  } catch {
    return html; // never let a quote-collapse failure blank out the message body
  }
}

/**
 * Collapses the first quoted/forwarded section found within `container` behind a
 * three-dots toggle, then recurses into the hidden wrapper for nested quotes (up to
 * 3 levels). Mutates the live DOM in place — no HTML round-trips. Scoping every check
 * (walker root, hasVisibleTextBefore, promoteAnchor) to `container` reproduces exactly what the
 * old `collapseQuotes(wrapper.innerHTML, depth+1)` recursion did, where each wrapper's
 * innerHTML became its own document body.
 */
function collapseInContainer(container: Element, depth: number): boolean {
  const doc = container.ownerDocument;

  // Walk the tree looking for the first quote-start node that has real visible
  // content BEFORE it (so we never fold to nothing). When promoteAnchor bubbles
  // a candidate up to an ancestor that has no visible text before it (e.g. the anchor is the
  // very first element in a wrapper), we skip it and keep scanning — this lets us
  // reach a later quote-start that does have content above it.
  let anchor: ChildNode | null = null;
  const walker = doc.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
  );
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!isQuoteStart(n)) continue;
    const promoted = promoteAnchor(n, container);
    if (!promoted.parentNode) continue;
    if (!hasVisibleTextBefore(container, promoted)) continue;  // no visible content above — keep scanning
    const candidateParent = promoted.parentNode as Element;
    if (["TABLE", "TBODY", "THEAD", "TFOOT", "TR"].includes(candidateParent.tagName)) continue;
    anchor = promoted;
    break;
  }
  if (!anchor || !anchor.parentNode) return false;

  const parent = anchor.parentNode as Element;

  // Move the anchor + every following sibling into one hidden wrapper, toggle in front.
  const toMove: ChildNode[] = [];
  for (let n: ChildNode | null = anchor as ChildNode; n; n = n.nextSibling) {
    toMove.push(n);
  }

  // At depth > 0 (inside an already-hidden wrapper), skip a collapse that would
  // wrap only a single fw-blk header with no body content after it. The fw-blk
  // already has its own internal toggle; adding an outer one is redundant and
  // visually confusing.  Depth-0 always collapses regardless.
  if (depth > 0) {
    const hasBodyAfter = toMove.slice(1).some(
      (nd) => (nd.textContent ?? "").trim().length > 0
    );
    if (!hasBodyAfter) return false;
  }
  const lineCount = toMove.reduce((acc, n) => {
    return acc + (n.nodeType === Node.ELEMENT_NODE
      ? (n as Element).querySelectorAll("p,div,li,br,pre").length + 1
      : ((n.textContent ?? "").trim() ? 1 : 0));
  }, 0);
  const btn = makeToggle(doc, t("email.renderer.showQuotedText"), lineCount);
  const wrapper = doc.createElement("div");
  wrapper.className = "q-quote q-hidden";
  parent.insertBefore(btn, anchor);
  parent.insertBefore(wrapper, anchor);
  for (const n of toMove) wrapper.appendChild(n);

  // At depth 0, also sweep up body-level trailing nodes that live outside the
  // anchor's immediate container (footers, disclaimers in a sibling div).
  // We stop as soon as a node triggers isQuoteStart — that would be a NEW message.
  if (depth === 0 && parent !== container) {
    let topAncestor: Node = parent;
    while (topAncestor.parentNode && topAncestor.parentNode !== container) {
      topAncestor = topAncestor.parentNode;
    }
    if (topAncestor.parentNode === container) {
      let n: ChildNode | null = (topAncestor as ChildNode).nextSibling;
      while (n) {
        if (isQuoteStart(n)) break;
        const next = n.nextSibling;
        wrapper.appendChild(n);
        n = next;
      }
    }
  }

  // Recursively collapse nested quotes inside the hidden wrapper (up to 3 levels),
  // operating on the live wrapper node — no re-parse.
  if (depth < 3) {
    collapseInContainer(wrapper, depth + 1);
  }
  return true;
}

/**
 * DOM pass: absorbs the sibling nodes that follow each top-level fw-blk (up to the
 * next fw-blk or end-of-parent) into a .fw-body div appended to that block, so the
 * forwarded header and its body share the same background surface.
 */
function mergeBodyIntoBlocks(html: string): string {
  if (!html.includes("fw-blk")) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const blocks = Array.from(doc.querySelectorAll(".fw-blk"));
    if (!blocks.length) return html;

    let changed = false;
    for (const blk of blocks) {
      // Find the node whose *following siblings* contain the body. When fw-blk is
      // the only meaningful child of a wrapper div (common in Outlook), the body
      // content lives as a sibling of the wrapper — not of fw-blk itself. Bubble
      // up through parents (while fw-blk is the last meaningful child at each
      // level) until we find a level with actual following content or reach body.
      // Stop at fw-blk/fw-body boundaries so nested blocks don't steal outer content.
      let ref: ChildNode = blk;
      while (ref.parentNode && ref.parentNode !== doc.body) {
        const parentEl = ref.parentNode as Element;
        if (parentEl.classList?.contains("fw-blk") || parentEl.classList?.contains("fw-body")) break;
        let sib: ChildNode | null = ref.nextSibling;
        let hasFollowing = false;
        while (sib) {
          if (sib.nodeType === Node.ELEMENT_NODE || (sib.nodeType === Node.TEXT_NODE && (sib.textContent ?? "").trim())) {
            hasFollowing = true;
            break;
          }
          sib = sib.nextSibling;
        }
        if (hasFollowing) break;
        ref = ref.parentNode as unknown as ChildNode;
      }

      // Collect following siblings of `ref` up to the next fw-blk.
      const bodyNodes: ChildNode[] = [];
      let n: ChildNode | null = ref.nextSibling;
      while (n) {
        if (n.nodeType === Node.ELEMENT_NODE && (n as Element).classList.contains("fw-blk")) break;
        bodyNodes.push(n);
        n = n.nextSibling;
      }

      const hasContent = bodyNodes.some(
        (nd) => nd.nodeType !== Node.TEXT_NODE || (nd.textContent ?? "").trim().length > 0,
      );
      if (!hasContent) continue;

      const wrapper = doc.createElement("div");
      wrapper.className = "fw-body";
      for (const nd of bodyNodes) wrapper.appendChild(nd);
      blk.appendChild(wrapper);

      // If the block was built as fw-plain (no meta, no toggle) but now has a
      // body, upgrade it: remove the plain marker and inject the chevron.
      if (blk.classList.contains("fw-plain")) {
        blk.classList.remove("fw-plain");
        const hd = blk.querySelector(".fw-hd");
        if (hd) hd.insertAdjacentHTML("afterbegin", CHEVRON);
      }

      changed = true;
    }

    return changed ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

/**
 * DOM pass: converts <hr>-separated header blocks that Case 3 regex missed because
 * Outlook nests bold keys inside <span> elements (<b><span>Key:</span></b>). Walking
 * the DOM and calling parseHtmlHeaders (which strips all tags) handles any nesting.
 */
function boxHrHeaders(html: string): string {
  if (!/<hr/i.test(html)) return html;
  try {
    const doc = new DOMParser().parseFromString(html, "text/html");
    const hrs = Array.from(doc.querySelectorAll("hr"));
    if (!hrs.length) return html;

    let changed = false;
    for (const hr of hrs) {
      // Find the next meaningful sibling (skip whitespace/br).
      let next = nextSignificantSibling(hr);
      if (!next || next.nodeType !== Node.ELEMENT_NODE) continue;
      const nextEl = next as Element;
      // Quick guard: must contain a recognisable header block.
      if (!FW_HEADER_BLOCK_RE.test(nextEl.textContent ?? "")) continue;
      const headers = parseHtmlHeaders(nextEl.innerHTML);
      if (headers.length < 2 || !headers.some(([k]) => k.toLowerCase() === "from")) continue;

      const holder = doc.createElement("div");
      holder.innerHTML = buildBlock(headers, "Forwarded message");
      const blk = holder.firstElementChild;
      if (!blk) continue;
      nextEl.replaceWith(blk);
      hr.remove();
      changed = true;
    }

    return changed ? doc.body.innerHTML : html;
  } catch {
    return html;
  }
}

/**
 * Transforms forwarded blocks in HTML emails.
 * Handles Gmail's .gmail_attr div, inline <br>-separated header lines,
 * Outlook <hr>-separated blocks, and locale-aware reply attribution lines.
 */
export function transformHtml(html: string): string {
  // Case 1: Gmail .gmail_attr wrapper div
  // Handles both forwarded header blocks (From:/Date:/Subject:) and
  // reply attributions ("Il DATE, NAME <email>, ha scritto:")
  html = html.replace(
    /<div[^>]*class="[^"]*gmail_attr[^"]*"[^>]*>([\s\S]*?)<\/div>/gi,
    (full, inner) => {
      const headers = parseHtmlHeaders(inner);
      if (headers.some(([k]) => k.toLowerCase() === "from")) {
        return buildBlock(headers);
      }
      const attr = parseAttribution(innerToPlain(inner));
      if (attr) return buildAttributionBlock(attr);
      return full;
    },
  );

  // Case 2: Inline dashed separator + <br>-separated header lines (various clients)
  // Handles: "Forwarded message", "Original Message", "Messaggio inoltrato", etc.
  html = html.replace(
    /-{3,}\s*(?:Forwarded\s+(?:message|mail|email)|Original\s+(?:message|mail|email)|Messaggio\s+inoltrato|Message\s+(?:transmis|transf[eé]r[eé])|Mensaje\s+reenviado)\s*-{3,}(?:<br\s*\/?>|<\/[a-z]+>|\s)*?((?:(?:From|Da|De|Von|Date|Data|Inviato|Sent|Gesendet|Subject|Oggetto|Objet|Asunto|Betreff|To|A|An|Cc|Bcc|Reply-To)\s*:[^<\n]+(?:<br\s*\/?>)?\s*)+)/gi,
    (full, headerBlock) => {
      const headers = parseHtmlHeaders(headerBlock);
      return headers.length ? buildBlock(headers) : full;
    },
  );

  // Case 3: Outlook-style <hr> separator followed by a bold key/value header paragraph.
  // Outlook wraps forward/reply headers in <p> or <div> with <b>Key:</b> Value <br> pairs.
  html = html.replace(
    /<hr[^>]*\/?>\s*<(p|div)([^>]*)>((?:(?:<b>|<strong>)[^<]+(?:<\/b>|<\/strong>)[^<]*(?:<br\s*\/?>)?[ \t\r\n]*){2,})<\/\1>/gi,
    (full, _tag, _attrs, headerBlock) => {
      const headers = parseHtmlHeaders(headerBlock);
      if (headers.length < 2 || !headers.some(([k]) => k.toLowerCase() === "from")) return full;
      return buildBlock(headers, "Original message");
    },
  );

  // Case 5: Outlook/Word <p> containing reply headers. Outlook wraps keys in
  // <b><span style='...'>Key:</span></b> with values in <span>, email addresses as
  // <a href="mailto:...">, and appends <o:p></o:p> before </p>. The old structural
  // regex couldn't handle these; we strip all markup and let parseHtmlHeaders decide.
  //
  // The inner uses a TEMPERED token `(?:(?!<\/p>)[\s\S])` so it can never bridge across a
  // </p> boundary. Without this, an empty <p></p> right before the header <p> (common in
  // Outlook: `<p style="MARGIN-BOTTOM:5pt"></p>`) would force the {1,…} minimum to consume
  // the empty close + the next opening, merging two paragraphs — the merged inner then
  // starts with </p> and trips the nested-block guard, so the fw-blk was never built.
  html = html.replace(
    /<p([^>]*)>((?:(?!<\/p>)[\s\S]){1,1500}?)<\/p>/gi,
    (full, _attrs, inner) => {
      // Fast-skip: no bold tag means no header block
      if (!/<b\b|<strong\b/i.test(inner)) return full;
      // Skip containers with nested block elements
      if (/<\/(?:div|p|table|ul|ol|li|blockquote|h[1-6])/i.test(inner)) return full;
      const headers = parseHtmlHeaders(inner);
      if (headers.length < 3 || !headers.some(([k]) => k.toLowerCase() === "from")) return full;
      return buildBlock(headers);
    },
  );

  // Case 4: Attribution line in a bare <p> or <div> element.
  // Covers Apple Mail (<div>), webmail, and clients that don't use gmail_attr.
  // Guards: must contain "ha scritto:" / "wrote:" etc., must NOT contain nested block
  // elements (to avoid matching large container divs), and must be ≤ 500 chars.
  //
  // Like Case 5, the inner uses a TEMPERED token — here one that can never cross ANY
  // block-level closing tag, so the match is structurally guaranteed to be a leaf
  // element. Both failure modes below ended with the attribution swallowed by a
  // *containing* match that the nested-block guard then rejected — and because the
  // regex is global, lastIndex had already moved past the attribution, so it was
  // never reconsidered:
  //   • an Outlook spacer paragraph (`<p class="MsoNormal">&nbsp;</p>`) is shorter
  //     than the {15,…} minimum, so the lazy quantifier ran past its own </p> and
  //     absorbed the attribution <p> that followed;
  //   • a short quote wrapper (`<div style="border-left:…">` around the attribution
  //     <p> plus a line or two of quoted text) matched as a whole before the inner
  //     <p> was ever tried.
  // With the tempered token neither container can match, and the scan reaches the
  // attribution paragraph itself.
  html = html.replace(
    /<(p|div)[^>]*>((?:(?!<\/(?:p|div|table|ul|ol|li|blockquote|h[1-6])\b)[\s\S]){15,500}?)<\/\1>/gi,
    (full, _tag, inner) => {
      if (!WROTE_RE.test(inner)) return full;
      // Skip if inner contains nested block elements — this is a container, not a leaf
      if (/<\/(?:div|p|table|ul|ol|li|blockquote|h[1-6])/i.test(inner)) return full;
      const attr = parseAttribution(innerToPlain(inner));
      return attr ? buildAttributionBlock(attr) : full;
    },
  );

  // Case 6: Consecutive <p> elements each containing a single bold key/value header.
  // New Outlook / Outlook 365 sometimes emits one <p> per field instead of grouping
  // them in a single <p> with <br> separators (which Case 5 handles). Require 3+
  // consecutive such <p>s including a From/Da equivalent to avoid false positives.
  html = html.replace(
    /((?:<p[^>]*>[ \t\r\n]*(?:<b>|<strong>)[^:<]{1,30}:(?:<\/b>|<\/strong>)[^<]*<\/p>[ \t\r\n]*){3,})/gi,
    (full) => {
      // Convert </p> to <br> so parseHtmlHeaders can split on newlines
      const normalized = full.replace(/<\/p[^>]*>[ \t\r\n]*/gi, "<br>").replace(/<p[^>]*>/gi, "");
      const headers = parseHtmlHeaders(normalized);
      if (headers.length < 3 || !headers.some(([k]) => k.toLowerCase() === "from")) return full;
      return buildBlock(headers);
    },
  );

  // DOM pass: box <hr>-separated header blocks that the Case 3 regex missed because
  // Outlook nests the bold keys inside <span> elements (<b><span>De :</span></b>),
  // which trips the [^<]+ anchor. Walking the DOM and calling parseHtmlHeaders
  // (which strips all tags) handles any level of nesting reliably.
  html = boxHrHeaders(html);

  // DOM pass: box any Outlook border-top header dividers the regex passes missed
  // (deeply nested ones), so the formatted fw-blk appears uniformly everywhere.
  html = boxOutlookHeaders(html);

  // DOM pass: box reply-attribution lines ("Il … ha scritto:") that sit as a bare text
  // node next to their quote (Apple Mail / messageReplySection), which the regex missed.
  html = boxReplyAttributions(html);

  // DOM pass: box attributions and header runs that live as PLAIN TEXT lines inside a
  // single text node (plain-text quote embedded in HTML), which the passes above skip
  // because they expect one attribution per node / per element.
  html = boxPlainTextQuoteLines(html);

  // DOM pass: absorb the content that follows each fw-blk (up to the next fw-blk)
  // into a .fw-body div inside the block, so header + body share the same background.
  html = mergeBodyIntoBlocks(html);

  // Finally, collapse the quoted citation body behind a three-dots toggle.
  // Runs last so any fw-blk attribution headers built above end up nested
  // inside the collapsed quote container where applicable.
  return collapseQuotes(html);
}
