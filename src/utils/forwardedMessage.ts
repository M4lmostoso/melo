/**
 * Transforms raw "---------- Forwarded message ---------" blocks into
 * styled collapsible components, for both plain-text and HTML emails.
 *
 * CSS/JS constants are injected into the iframe srcdoc by EmailRenderer.
 */

const HEADER_KEYS = new Set([
  "from", "date", "subject", "to", "cc", "bcc", "reply-to",
  "sent", "mailed-by", "signed-by", "delivered-to",
]);

const CHEVRON = `<svg class="fw-chv" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

export const FW_CSS = `
.fw-blk{margin:10px 0;overflow:hidden;border:1px solid rgba(99,102,241,.2);border-left:3px solid #6366f1;border-radius:0 6px 6px 0}
.fw-hd{display:flex;align-items:center;gap:6px;padding:7px 10px;cursor:pointer;user-select:none;background:rgba(99,102,241,.07);font-size:11px;font-weight:600;color:#6366f1;font-family:system-ui,-apple-system,sans-serif;line-height:1.4}
.fw-hd:hover{background:rgba(99,102,241,.12)}
.fw-chv{transition:transform .15s;flex-shrink:0}
.fw-blk:not(.fw-open) .fw-chv{transform:rotate(-90deg)}
.fw-snip{color:#9ca3af;font-weight:400;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0;padding-left:4px}
.fw-meta{display:grid;grid-template-columns:auto 1fr;gap:2px 10px;padding:6px 10px;font-size:11px;background:rgba(99,102,241,.02);border-bottom:1px solid rgba(99,102,241,.12);font-family:system-ui,-apple-system,sans-serif}
.fw-lbl{color:#9ca3af;font-weight:500;white-space:nowrap;padding-top:1px}
.fw-val{color:#374151;word-break:break-word}
.fw-blk:not(.fw-open) .fw-meta{display:none}
`;

export const FW_DARK_CSS = `
.fw-blk{border-color:rgba(129,140,248,.25);border-left-color:#818cf8}
.fw-hd{color:#818cf8;background:rgba(99,102,241,.12)}
.fw-hd:hover{background:rgba(99,102,241,.18)}
.fw-meta{background:rgba(99,102,241,.05);border-bottom-color:rgba(129,140,248,.2)}
.fw-lbl{color:#6b7280}.fw-val{color:#d1d5db}
`;

export const FW_JS = `document.querySelectorAll('.fw-hd').forEach(function(h){h.addEventListener('click',function(){h.closest('.fw-blk').classList.toggle('fw-open')})});`;

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function parseHeaderLine(line: string): [string, string] | null {
  const i = line.indexOf(":");
  if (i < 2 || i > 20) return null;
  const key = line.slice(0, i).trim();
  if (!HEADER_KEYS.has(key.toLowerCase())) return null;
  const val = line.slice(i + 1).trim();
  return val ? [key, val] : null;
}

function buildBlock(headers: Array<[string, string]>): string {
  if (!headers.length) return "";
  const from = headers.find(([k]) => k.toLowerCase() === "from")?.[1] ?? "";
  const subject = headers.find(([k]) => k.toLowerCase() === "subject")?.[1] ?? "";
  const snip = [from, subject ? `· ${subject}` : ""].filter(Boolean).join(" ");
  const rows = headers
    .map(([k, v]) => `<div class="fw-lbl">${k}</div><div class="fw-val">${v}</div>`)
    .join("");
  return (
    `<div class="fw-blk fw-open">` +
    `<div class="fw-hd">${CHEVRON}<span>Forwarded message</span>` +
    (snip ? `<span class="fw-snip">${snip}</span>` : "") +
    `</div><div class="fw-meta">${rows}</div></div>`
  );
}

/**
 * Transforms forwarded blocks in plain-text emails.
 * Returns HTML with <pre> segments interleaved with fw-blk components.
 */
export function transformPlainText(text: string): string {
  // Matches: dashes + "Forwarded message" + dashes, then header lines
  // Also matches "Begin forwarded message:" (Apple Mail)
  const FW_RE =
    /(?:[ \t]*-{4,}[ \t]*Forwarded message[ \t]*-{4,}[ \t]*|Begin forwarded message:[ \t]*)\r?\n\r?\n?((?:[ \t]*(?:From|Date|Subject|To|Cc|Bcc|Reply-To|Sent|Mailed-By|Signed-By)[ \t]*:[^\n]+\r?\n?)+)/gi;

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
    return `<pre style="white-space:pre-wrap;font-family:inherit;">${esc(text)}</pre>`;
  }

  return segments
    .map((seg, i) => {
      const pre = seg
        ? `<pre style="white-space:pre-wrap;font-family:inherit;margin:0;">${esc(seg)}</pre>`
        : "";
      const block = i < blocks.length ? buildBlock(blocks[i] ?? []) : "";
      return pre + block;
    })
    .join("");
}

/**
 * Transforms forwarded blocks in HTML emails.
 * Handles Gmail's .gmail_attr div and inline <br>-separated header lines.
 */
export function transformHtml(html: string): string {
  // Case 1: Gmail .gmail_attr wrapper div
  html = html.replace(
    /<div[^>]*class="[^"]*gmail_attr[^"]*"[^>]*>[\s\S]*?Forwarded message[\s\S]*?<br\s*\/?>([^<]*(?:<(?!\/div)[^>]*>[^<]*)*)<\/div>/gi,
    (full, _inner) => {
      const headers = parseHtmlHeaders(full);
      return headers.length ? buildBlock(headers) : full;
    },
  );

  // Case 2: Inline separator + <br>-separated header lines
  html = html.replace(
    /-{4,}\s*Forwarded message\s*-{4,}(?:<br\s*\/?>|<\/[a-z]+>|\s)*?((?:(?:From|Date|Subject|To|Cc|Bcc|Reply-To|Sent|Mailed-By|Signed-By)\s*:[^<\n]+(?:<br\s*\/?>)?\s*)+)/gi,
    (full, headerBlock) => {
      const headers = parseHtmlHeaders(headerBlock);
      return headers.length ? buildBlock(headers) : full;
    },
  );

  return html;
}

function parseHtmlHeaders(block: string): Array<[string, string]> {
  // Strip <br> → newlines, strip remaining tags
  const text = block
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ");

  return text
    .split(/\n+/)
    .filter(Boolean)
    .map((line): [string, string] | null => {
      const trimmed = line.trim();
      const i = trimmed.indexOf(":");
      if (i < 2 || i > 20) return null;
      const key = trimmed.slice(0, i).trim();
      if (!HEADER_KEYS.has(key.toLowerCase())) return null;
      const val = trimmed.slice(i + 1).trim();
      if (!val) return null;
      // Values from sanitized HTML already have entities; don't double-encode
      return [key, val];
    })
    .filter((h): h is [string, string] => h !== null);
}
