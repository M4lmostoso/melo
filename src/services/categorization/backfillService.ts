import { getUncategorizedInboxThreadIds, setThreadCategory } from "@/services/db/threadCategories";
import { getThreadLabelIds } from "@/services/db/threads";
import { getMessagesForThread } from "@/services/db/messages";
import { getSetting } from "@/services/db/settings";
import { archiveThread } from "@/services/emailActions";
import { categorizeByRules } from "./ruleEngine";

/**
 * Categories the user wants kept out of the inbox.
 *
 * The Gmail sync applies this itself while storing a thread
 * (`gmail/sync.ts`), a path IMAP accounts never take — so on IMAP the setting
 * did nothing at all. Applying it here covers every provider, because this
 * backfill is what categorizes IMAP mail.
 */
async function loadAutoArchiveCategories(): Promise<Set<string>> {
  const raw = await getSetting("auto_archive_categories");
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

/**
 * Backfill uncategorized inbox threads with rule-based categorization.
 *
 * 1. Query inbox threads that have no entry in thread_categories
 * 2. For each, get labels and last message to run rule engine
 * 3. Insert the resulting category
 * 4. Return count of categorized threads
 */
export async function backfillUncategorizedThreads(
  accountId: string,
  batchSize = 50,
): Promise<number> {
  let totalCategorized = 0;
  let batch: Awaited<ReturnType<typeof getUncategorizedInboxThreadIds>>;
  const autoArchiveCategories = await loadAutoArchiveCategories();

  do {
    batch = await getUncategorizedInboxThreadIds(accountId, batchSize);

    await Promise.all(batch.map(async (thread) => {
      const [labelIds, messages] = await Promise.all([
        getThreadLabelIds(accountId, thread.id),
        getMessagesForThread(accountId, thread.id),
      ]);
      const lastMessage = messages[messages.length - 1];

      const category = categorizeByRules({
        labelIds,
        fromAddress: lastMessage?.from_address ?? thread.fromAddress ?? null,
        listUnsubscribe: lastMessage?.list_unsubscribe ?? null,
      });

      await setThreadCategory(accountId, thread.id, category, false);
      totalCategorized++;

      // Skip the inbox for categories the user opted out of. Never for
      // Primary — that would archive ordinary mail.
      if (category !== "Primary" && autoArchiveCategories.has(category)) {
        const messageIds = messages.map((m) => m.id);
        if (messageIds.length > 0) {
          try {
            await archiveThread(accountId, thread.id, messageIds);
          } catch (err) {
            console.error(
              `[categorization] auto-archive of thread ${thread.id} failed:`,
              err,
            );
          }
        }
      }
    }));
  } while (batch.length === batchSize);

  return totalCategorized;
}
