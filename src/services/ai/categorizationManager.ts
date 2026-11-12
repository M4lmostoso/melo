import { isAiAvailable } from "./providerManager";
import { categorizeThreads } from "./aiService";
import { getSetting } from "@/services/db/settings";
import { isRateLimitError } from "./errors";
import {
  getRecentRuleCategorizedThreadIds,
  markThreadsAiCategorized,
  setThreadCategoriesBatch,
} from "@/services/db/threadCategories";

export async function categorizeNewThreads(accountId: string): Promise<void> {
  try {
    // Check if AI and auto-categorize are enabled
    const aiAvail = await isAiAvailable();
    if (!aiAvail) return;

    const autoCat = await getSetting("ai_auto_categorize");
    if (autoCat === "false") return;

    // Get recently rule-categorized inbox threads (AI refines, not replaces)
    const threads = await getRecentRuleCategorizedThreadIds(accountId, 20);
    if (threads.length === 0) return;

    // Categorize via AI (refines rule-based results)
    const categories = await categorizeThreads(
      threads.map((t) => ({
        id: t.id,
        subject: t.subject ?? "",
        snippet: t.snippet ?? "",
        fromAddress: t.fromAddress ?? "",
      })),
    );

    // The call went through: never send these threads again, including the
    // ones the model left out of its answer (they would be re-sent forever).
    // A thrown call (429, network) skips this, so those are retried.
    await markThreadsAiCategorized(
      accountId,
      threads.map((t) => t.id),
    );

    if (categories.size === 0) return;

    // Store results (setThreadCategoriesBatch respects manual overrides)
    await setThreadCategoriesBatch(accountId, categories);
  } catch (err) {
    // Rate limited: the limiter already logged the pause once — don't add a
    // console.error per sync cycle while it lasts.
    if (isRateLimitError(err)) return;
    // Non-blocking — log and continue
    console.error("Auto-categorization failed:", err);
  }
}
