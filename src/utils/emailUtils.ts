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
 *
 * Also tolerates *unquoted* commas inside a display name (e.g. `Doe, John <j@x.com>`,
 * which many clients send despite RFC requiring quoting): a comma-separated fragment
 * that carries no address of its own is treated as a dangling name fragment and merged
 * into the *next angle-bracketed* segment (`<email>`), which is exactly the
 * "Lastname, Firstname <email>" shape. A bare email (no angle brackets) is always a
 * distinct recipient, so it never absorbs a preceding fragment — this prevents gluing
 * a name onto a standalone address and producing an unusable "Name, addr" email.
 */
export function parseAddressList(header: string | null | undefined): ParsedAddress[] {
  if (!header) return [];
  const rawParts: string[] = [];
  let current = "";
  let inQuote = false;
  let angleDepth = 0;
  for (const ch of header) {
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth = Math.max(0, angleDepth - 1);
    if (ch === "," && !inQuote && angleDepth === 0) {
      rawParts.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  if (current.trim()) rawParts.push(current);

  // Re-merge dangling name fragments (created by unquoted commas inside a display name)
  // with the next angle-bracketed segment. Only `<...>` segments absorb a pending
  // fragment; a bare email is a separate recipient and flushes any pending fragment first.
  const parts: string[] = [];
  let pending = "";
  for (const raw of rawParts) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const hasAngle = /<[^>]+>/.test(trimmed);
    const isBareEmail = !hasAngle && trimmed.includes("@");
    if (hasAngle) {
      parts.push(pending ? `${pending}, ${trimmed}` : trimmed);
      pending = "";
    } else if (isBareEmail) {
      if (pending) { parts.push(pending); pending = ""; }
      parts.push(trimmed);
    } else {
      // Name-only fragment — hold it and attach the next angle-bracketed address.
      pending = pending ? `${pending}, ${trimmed}` : trimmed;
    }
  }
  if (pending) parts.push(pending);

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
 * Build the To/Cc recipient lists for a "reply all".
 *
 * Uses {@link parseAddressList} so display names containing unquoted commas
 * (e.g. `Lastname, Firstname <email>`, common in corporate directories) are
 * kept intact instead of being split — a raw `header.split(",")` would break
 * `Chevalier, Francois <francois.chevalier@suez.com>` into two bogus chips.
 *
 * Excludes the user's own addresses and de-duplicates by email across To and
 * Cc (an address already in To won't be repeated in Cc). Each returned entry
 * is a single valid RFC address string (`Name <email>` when a name is present,
 * otherwise the bare email).
 */
export function buildReplyAllRecipients(opts: {
  replyTo: string | null | undefined;
  toHeader: string | null | undefined;
  ccHeader: string | null | undefined;
  selfEmails: Iterable<string>;
}): { to: string[]; cc: string[] } {
  const self = new Set<string>();
  for (const e of opts.selfEmails) {
    const n = normalizeEmail(e);
    if (n) self.add(n);
  }

  const seen = new Set<string>();
  const format = (addr: ParsedAddress): string =>
    addr.name ? `${addr.name} <${addr.email}>` : addr.email;

  const collect = (header: string | null | undefined, out: string[]) => {
    for (const addr of parseAddressList(header)) {
      const key = normalizeEmail(addr.email);
      if (!key || self.has(key) || seen.has(key)) continue;
      seen.add(key);
      out.push(format(addr));
    }
  };

  const to: string[] = [];
  const cc: string[] = [];
  collect(opts.replyTo, to);
  collect(opts.toHeader, to);
  collect(opts.ccHeader, cc);
  return { to, cc };
}

/**
 * Build the To recipient list for a single-sender "reply".
 *
 * Normally the reply goes back to the message's sender (`reply_to ?? from`).
 * But when replying to a message the user themselves sent (e.g. opened from the
 * Sent folder), replying to the sender would just email yourself — so instead
 * the reply targets the message's original recipients (its To header), matching
 * Gmail / Apple Mail behaviour. Self addresses are excluded and results are
 * de-duplicated by email. Uses {@link parseAddressList} so display names with
 * unquoted commas stay intact.
 */
export function buildReplyRecipients(opts: {
  replyTo: string | null | undefined;
  fromAddress: string | null | undefined;
  toHeader: string | null | undefined;
  selfEmails: Iterable<string>;
}): { to: string[] } {
  const self = new Set<string>();
  for (const e of opts.selfEmails) {
    const n = normalizeEmail(e);
    if (n) self.add(n);
  }

  const fromKey = normalizeEmail(opts.fromAddress);
  const sentBySelf = !!fromKey && self.has(fromKey);

  if (!sentBySelf) {
    // Normal reply — back to the sender.
    const replyTo = opts.replyTo ?? opts.fromAddress;
    return { to: replyTo ? [replyTo] : [] };
  }

  // Reply to a message I sent — continue the conversation with the original
  // recipients, not myself.
  const format = (addr: ParsedAddress): string =>
    addr.name ? `${addr.name} <${addr.email}>` : addr.email;
  const seen = new Set<string>();
  const to: string[] = [];
  for (const addr of parseAddressList(opts.toHeader)) {
    const key = normalizeEmail(addr.email);
    if (!key || self.has(key) || seen.has(key)) continue;
    seen.add(key);
    to.push(format(addr));
  }
  return { to };
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
