import type { SendAsAlias } from "@/services/db/sendAsAliases";
import { parseAddressList, normalizeEmail } from "@/utils/emailUtils";

/**
 * Resolve which send-as alias to use as the "From" address.
 *
 * When replying: checks if any alias email matches an address in the
 * To or CC fields of the original message. If found, uses that alias
 * so the reply comes from the address the message was originally sent to.
 *
 * Falls back to the default alias (isDefault), then primary alias.
 * Returns null if no aliases are available.
 */
export function resolveFromAddress(
  aliases: SendAsAlias[],
  toAddresses: string | null,
  ccAddresses: string | null,
): SendAsAlias | null {
  if (aliases.length === 0) return null;

  // Collect all addresses from To and CC into a normalized set.
  // parseAddressList, not split(","): the alias is matched against the bare
  // mailbox, so a header entry like "Melki, Benjamin <b@x>" (display name and
  // brackets included) has to be parsed, not compared as a raw string.
  const recipientEmails = new Set<string>();
  for (const header of [toAddresses, ccAddresses]) {
    for (const addr of parseAddressList(header)) {
      const normalized = normalizeEmail(addr.email);
      if (normalized) recipientEmails.add(normalized);
    }
  }

  // Check if any alias matches a recipient address
  if (recipientEmails.size > 0) {
    const match = aliases.find((a) =>
      recipientEmails.has(a.email.toLowerCase()),
    );
    if (match) return match;
  }

  // Fall back to default alias
  const defaultAlias = aliases.find((a) => a.isDefault);
  if (defaultAlias) return defaultAlias;

  // Fall back to primary alias
  const primaryAlias = aliases.find((a) => a.isPrimary);
  if (primaryAlias) return primaryAlias;

  // Last resort: return first alias
  return aliases[0] ?? null;
}
