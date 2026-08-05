/**
 * Stable synthetic RFC Message-ID for IMAP messages that have no Message-ID header.
 *
 * Why this exists: ~4000 messages of the DavMail/Exchange account carry no
 * `Message-ID` header at all. The old fallback was `synthetic-{account}-{folder}-{uid}`,
 * i.e. derived from the IMAP UID — the least stable identifier there is. Every UID
 * renumber or folder move produced a brand-new identity, which meant:
 *   - the cross-folder/cross-cycle dedup could not recognise the message → duplicate rows;
 *   - JWZ threading re-keyed the thread → tasks linked to that thread became orphans.
 *
 * The identity is now derived from content that does not move with the UID: send
 * timestamp, sender, recipients, subject and exact byte size. Two messages colliding
 * on all five are, for every practical purpose, the same message.
 *
 * The hash is FNV-1a 64-bit, chosen because it is trivial to implement identically in
 * Rust (see `src-tauri/src/imap/synthetic_id.rs`) and synchronously in TypeScript.
 * Both sides MUST produce the same digest — the shared test vector in
 * syntheticMessageId.test.ts and the Rust unit test lock them together. Never change
 * the canonical form or the hash without re-keying stored ids in the same release.
 */

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

export interface SyntheticIdFields {
  /** Message date in milliseconds (the `date` column / ImapMessage.date). */
  date: number;
  fromAddress: string | null;
  toAddresses: string | null;
  subject: string | null;
  /** RFC822.SIZE in bytes (the `raw_size` column). */
  rawSize: number;
}

/** ASCII unit separator (U+001F) — cannot appear inside any of the joined fields. */
const SEP = "\u001f";

/** Canonical string that gets hashed. Kept byte-identical with the Rust side. */
export function syntheticCanonicalForm(f: SyntheticIdFields): string {
  const norm = (s: string | null) => (s ?? "").trim().toLowerCase();
  return [
    f.date,
    norm(f.fromAddress),
    norm(f.toAddresses),
    (f.subject ?? "").trim(),
    f.rawSize,
  ].join(SEP);
}

function fnv1a64(input: string): bigint {
  const bytes = new TextEncoder().encode(input);
  let hash = FNV_OFFSET_BASIS;
  for (const b of bytes) {
    hash = (hash ^ BigInt(b)) & MASK_64;
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/** `synthetic-<16 hex digits>@melo.local` — stable across UID renumbers and folder moves. */
export function syntheticMessageId(f: SyntheticIdFields): string {
  return `synthetic-${fnv1a64(syntheticCanonicalForm(f)).toString(16).padStart(16, "0")}@melo.local`;
}

/** True for ids this module minted. Such ids are internal and must never leave the app. */
export function isSyntheticMessageId(id: string | null | undefined): boolean {
  return !!id && /^synthetic-[0-9a-f]{16}@melo\.local$/.test(id);
}

/**
 * True for any internal placeholder id, including the legacy UID-derived form
 * (`synthetic-{account}-{folder}-{uid}@melo.local`) still present on older rows.
 * Use this — not isSyntheticMessageId — whenever the question is "may this id be
 * sent to a mail server?".
 */
export function isInternalPlaceholderId(id: string | null | undefined): boolean {
  return !!id && id.startsWith("synthetic-") && id.endsWith("@melo.local");
}
