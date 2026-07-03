// Detects an "unusual sender account" for a brand-new compose message: the
// recipient's domain has an established history (>= MIN_HISTORY_COUNT SENT
// messages) that is *exclusively* from one account, and the currently
// selected account is a different one. Mixed history (the domain has been
// emailed from more than one account before) is left alone — that's normal
// multi-account use, not an evident mistake. Only applies to "new" messages;
// replies/forwards keep the account the thread was already using.
import { getSentAccountIdsForDomain } from "../db/search";

const MIN_HISTORY_COUNT = 8;

export interface UnusualAccountWarning {
  domain: string;
  usualAccountId: string;
}

export async function findUnusualAccountForNewMessage(params: {
  mode: string;
  to: string[];
  currentAccountId: string | null;
}): Promise<UnusualAccountWarning | null> {
  if (params.mode !== "new" || !params.currentAccountId || params.to.length === 0) {
    return null;
  }

  const domains = [
    ...new Set(
      params.to
        .map((addr) => addr.split("@")[1]?.toLowerCase())
        .filter((d): d is string => Boolean(d)),
    ),
  ];

  for (const domain of domains) {
    const history = await getSentAccountIdsForDomain(domain);
    if (history.length !== 1) continue; // no history, or already multi-account
    const [only] = history;
    if (!only || only.count < MIN_HISTORY_COUNT) continue;
    if (only.account_id === params.currentAccountId) continue;
    return { domain, usualAccountId: only.account_id };
  }
  return null;
}
