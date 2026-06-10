// Win-1252 code points that map to bytes above 0x7F but outside normal Latin-1.
const WIN1252_EXTRA: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85,
  0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A,
  0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92,
  0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C,
  0x017E: 0x9E, 0x0178: 0x9F,
};

/**
 * Fix Windows-1252 mojibake in email header strings.
 * Some clients send UTF-8 bytes labeled as Latin-1; this reverses that up to 3 iterations.
 * Mirrors the `fix_mojibake` function in the Rust IMAP backend.
 */
export function fixMojibake(s: string): string {
  let current = s;
  for (let iter = 0; iter < 3; iter++) {
    const bytes: number[] = [];
    let canConvert = true;
    for (const c of current) {
      const cp = c.codePointAt(0) ?? 0;
      if (cp <= 0xFF) {
        bytes.push(cp);
      } else {
        const b = WIN1252_EXTRA[cp];
        if (b !== undefined) {
          bytes.push(b);
        } else {
          canConvert = false;
          break;
        }
      }
    }
    if (!canConvert || !bytes.some((b) => b > 0x7F)) break;
    try {
      const decoded = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(bytes));
      if (decoded !== current) { current = decoded; continue; }
    } catch { /* not valid UTF-8 */ }
    break;
  }
  return current;
}

/**
 * Normalize an email address for case-insensitive comparison.
 * Email addresses are case-insensitive per RFC 5321.
 */
export function normalizeEmail(email: string | null | undefined): string {
  if (!email) return "";
  const match = email.match(/<([^>]+)>/);
  const target = (match ? match[1] : email) || "";
  return target.toLowerCase().trim();
}

export interface ParsedAddress {
  /** Display name from the header (e.g. the part before <...>), or null if absent. */
  name: string | null;
  email: string;
}

/**
 * Parse an RFC 2822 address-list header (To/Cc/Bcc) into individual addresses.
 * Splits on commas while respecting quoted display names and angle-bracketed addresses,
 * so `"Doe, John" <j@x.com>, plain@y.com` yields two entries, not three.
 */
export function parseAddressList(header: string | null | undefined): ParsedAddress[] {
  if (!header) return [];
  const parts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;
  for (const ch of header) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (ch === "," && !inQuote && angleDepth === 0) {
      parts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) parts.push(current);

  const result: ParsedAddress[] = [];
  for (const raw of parts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const angleMatch = trimmed.match(/^(.*?)<([^>]+)>\s*$/);
    if (angleMatch) {
      const name = angleMatch[1]!.trim().replace(/^"(.*)"$/, "$1").trim();
      result.push({ name: name || null, email: angleMatch[2]!.trim() });
    } else {
      result.push({ name: null, email: trimmed });
    }
  }
  return result;
}

/**
 * Resolve the best display label for a recipient, using the priority:
 * 1) stored contact name (DB), 2) name associated with the email in the header,
 * 3) the raw email address.
 */
export function resolveRecipientLabel(
  addr: ParsedAddress,
  contactsMap: Record<string, string>,
): string {
  return contactsMap[addr.email.toLowerCase()] || addr.name || addr.email;
}
