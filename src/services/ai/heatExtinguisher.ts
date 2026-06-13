import { getSetting } from "@/services/db/settings";
import { setHeatExtinguished, setManualUrgencyOverride, setThreadUrgency, getThreadById } from "@/services/db/threads";
import { useThreadStore } from "@/stores/threadStore";
import { logInteraction } from "./reputationEngine";
import { getMessagesForThread } from "@/services/db/messages";

// ---------------------------------------------------------------------------
// Extinguish — marks a thread as resolved (heat = 0)
// ---------------------------------------------------------------------------

export async function extinguishThread(
  accountId: string,
  threadId: string,
): Promise<void> {
  await setHeatExtinguished(accountId, threadId, true);
  useThreadStore.getState().updateThread(threadId, { isHeatExtinguished: true });
}

// ---------------------------------------------------------------------------
// Mute urgency — zeroes urgency, logs MUTE_URGENCY for reputation tracking
// ---------------------------------------------------------------------------

export async function muteUrgency(
  accountId: string,
  threadId: string,
  fromAddress: string,
): Promise<void> {
  await setManualUrgencyOverride(accountId, threadId, 1);
  await logInteraction(accountId, fromAddress, "MUTE_URGENCY", threadId);
  useThreadStore.getState().updateThread(threadId, {
    urgencyScore: 0,
    isHeatExtinguished: true,
  });
}

// ---------------------------------------------------------------------------
// Auto-extinguish — called after a reply is sent (Smart Judge)
// ---------------------------------------------------------------------------

/**
 * Fetches the most recent received message in the thread to use as context
 * for the Smart Judge. Returns null if no received message is found.
 */
async function fetchUrgentContext(accountId: string, threadId: string): Promise<string | null> {
  try {
    const messages = await getMessagesForThread(accountId, threadId);
    // Find last message not sent by the account owner (i.e. received, not sent)
    // Messages from SENT label have labelIds, but DbMessage doesn't carry them.
    // Best heuristic: skip the last message (likely the just-sent reply), use the one before.
    const candidates = messages.slice(0, -1);
    const last = candidates[candidates.length - 1];
    if (!last) return null;
    return [last.subject ?? "", (last.body_text ?? last.snippet ?? "").slice(0, 600)].join("\n");
  } catch {
    return null;
  }
}

// Replying that does NOT close the topic still reduces urgency by 30%.
const REPLY_URGENCY_DECAY = 0.7;

/**
 * If ai_urgency_auto_extinguish is enabled, the Smart Judge (AI) evaluates whether the
 * user's reply closes the thread:
 *   - RESOLVED  → urgency is brought to zero (and the thread is marked resolved).
 *   - PENDING   → urgency is reduced by 30% (the reply still lowers it, just not to zero).
 * The AI verdict is the only thing that can zero the urgency. When the AI can't be
 * consulted (not configured / unavailable / no context), we conservatively apply the
 * 30% reduction rather than assuming the topic is closed.
 */
export async function autoExtinguishOnReply(
  accountId: string,
  threadId: string,
  replyText?: string,
): Promise<void> {
  const autoEnabled = await getSetting("ai_urgency_auto_extinguish");
  if (autoEnabled !== "true") return;

  // Read urgency state from the DB rather than the in-memory store. The thread may have
  // been archived (and removed from the list) right after sending — relying on the store
  // would make this bail before lowering the urgency. The DB is the source of truth.
  const thread = await getThreadById(accountId, threadId);
  const currentScore = thread?.urgency_score ?? 0;
  const isExtinguished = thread?.is_heat_extinguished === 1;
  const isManualOverride = (thread?.manual_urgency_override ?? 0) === 1;
  if (!thread || currentScore <= 0 || isExtinguished || isManualOverride) return;

  // The reply must pass through an AI evaluation to decide whether it closes the topic.
  // Only zero the urgency when the AI is available, we have context, and it judges RESOLVED.
  let resolved = false;
  const { isAiAvailable } = await import("./providerManager");
  if (await isAiAvailable()) {
    const urgentContext = await fetchUrgentContext(accountId, threadId);
    if (urgentContext) {
      try {
        const { judgeUrgencyResolved } = await import("./aiService");
        resolved = await judgeUrgencyResolved(urgentContext, replyText);
      } catch {
        // AI call failed — conservatively fall back to the 30% reduction.
        resolved = false;
      }
    }
  }

  if (resolved) {
    // The reply closed the topic → bring urgency to zero and mark the thread resolved.
    await setThreadUrgency(accountId, threadId, 0);
    await extinguishThread(accountId, threadId);
    useThreadStore.getState().updateThread(threadId, { urgencyScore: 0 });
  } else {
    // Topic still open → reduce urgency by 30%.
    const decayedScore = currentScore * REPLY_URGENCY_DECAY;
    await setThreadUrgency(accountId, threadId, decayedScore);
    useThreadStore.getState().updateThread(threadId, { urgencyScore: decayedScore });
  }

  // Always log the reply interaction (contributes to reputation)
  if (thread.from_address) {
    await logInteraction(accountId, thread.from_address, "REPLY_SENT", threadId);
  }
}
