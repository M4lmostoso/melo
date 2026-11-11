import { getSetting } from "@/services/db/settings";
import { setThreadUrgency, setHeatExtinguished, setThreadUrgencyReason, setUrgencyReplyDecayed } from "@/services/db/threads";
import { getDb } from "@/services/db/connection";
import {
  scoreUrgencyFromText,
  adjustUrgencyWithReputation,
  ragPriorityDomainBoost,
  sanitizeForUrgencyScoring,
  logInteraction,
} from "./reputationEngine";
import { scoreUrgencyWithAi } from "./aiService";
import { isAiAvailable } from "./providerManager";
import { AiError } from "./errors";
import { isLaneOpen, onBacklogResume, waitForLane } from "./rateLimiter";

/** Mail older than this is backlog: it goes in the rate limiter's slowest lane. */
const LIVE_MAX_AGE_MS = 24 * 60 * 60 * 1000;

const SKIP_LABELS = new Set(["SENT", "DRAFT", "TRASH", "SPAM"]);
// Gmail category labels that indicate non-Primary threads — urgency is suppressed for these.
const NON_PRIMARY_GMAIL_LABELS = new Set([
  "CATEGORY_UPDATES",
  "CATEGORY_PROMOTIONS",
  "CATEGORY_SOCIAL",
  "CATEGORY_FORUMS",
]);
const EXTINGUISH_RESET_THRESHOLD = 0.3;

interface UrgencySettings {
  behaviorEnabled: boolean;
  urgencyEnabled: boolean;
  priorityDomains: string;
  decayStartDays: number;
  decayFloorDays: number;
  autoLabelEnabled: boolean;
  autoLabelThreshold: number;
}

let _cache: UrgencySettings | null = null;
let _cacheTime = 0;
const CACHE_TTL = 60_000;

async function getUrgencySettings(): Promise<UrgencySettings> {
  const now = Date.now();
  if (_cache && now - _cacheTime < CACHE_TTL) return _cache;
  const [behaviorEnabled, urgencyEnabled, priorityDomains, decayStart, decayFloor, autoLabel, autoLabelThreshold] = await Promise.all([
    getSetting("ai_behavior_enabled"),
    getSetting("ai_urgency_enabled"),
    getSetting("rag_priority_domains"),
    getSetting("ai_urgency_decay_start_days"),
    getSetting("ai_urgency_decay_floor_days"),
    getSetting("ai_auto_label_enabled"),
    getSetting("ai_auto_label_threshold"),
  ]);
  _cache = {
    behaviorEnabled: behaviorEnabled !== "false",
    urgencyEnabled: urgencyEnabled !== "false",
    priorityDomains: priorityDomains ?? "",
    decayStartDays: parseInt(decayStart ?? "20", 10),
    decayFloorDays: parseInt(decayFloor ?? "30", 10),
    autoLabelEnabled: autoLabel === "true",
    autoLabelThreshold: parseInt(autoLabelThreshold ?? "75", 10),
  };
  _cacheTime = now;
  return _cache;
}

export async function getDecaySettings(): Promise<{ decayStartDays: number; decayFloorDays: number }> {
  const s = await getUrgencySettings();
  return { decayStartDays: s.decayStartDays, decayFloorDays: s.decayFloorDays };
}

/** Invalidate the settings cache — call whenever urgency-related settings change. */
export function invalidateUrgencySettingsCache(): void {
  _cache = null;
}

export interface ThreadUrgencyParams {
  accountId: string;
  threadId: string;
  subject: string | null;
  bodyText: string | null;
  fromAddress: string | null;
  fromName?: string | null;
  lastMessageAt: number; // ms since epoch
  labelIds: string[];
  /** True when called from a backfill job — skips auto-labeling to avoid overloading the AI on re-sync. */
  isBackfill?: boolean;
}

/**
 * Score urgency for a newly synced thread and persist the result.
 * Uses the active AI provider when available; falls back to keyword heuristics.
 * All errors are swallowed — urgency is best-effort and must never block sync.
 */
export async function processThreadUrgency(params: ThreadUrgencyParams): Promise<void> {
  try {
    const settings = await getUrgencySettings();
    if (!settings.behaviorEnabled || !settings.urgencyEnabled) return;

    // Thread labels are the UNION over its messages: a conversation the user
    // replied to carries SENT, one with a trashed copy carries TRASH. Skipping on
    // any of them excluded every conversation the user had ever answered — the
    // work threads — from urgency altogether. Skip spam, and threads that are not
    // in the inbox at all (sent-only, trashed, drafts).
    if (params.labelIds.includes("SPAM")) return;
    if (!params.labelIds.includes("INBOX") && params.labelIds.some((l) => SKIP_LABELS.has(l))) return;
    if (params.labelIds.some((l) => NON_PRIMARY_GMAIL_LABELS.has(l))) return;

    // Skip muted threads — their urgency score is managed by the mute action
    const db = await getDb();
    const rows = await db.select<{ is_muted: number }[]>(
      "SELECT is_muted FROM threads WHERE account_id = ?1 AND id = ?2",
      [params.accountId, params.threadId],
    );
    if (rows[0]?.is_muted === 1) return;

    const ageDays = (Date.now() - params.lastMessageAt) / 86_400_000;
    if (ageDays > settings.decayFloorDays) return;

    const subject = params.subject ?? "";
    const bodyText = params.bodyText ?? "";
    const fromAddress = params.fromAddress ?? "";
    const fromName = params.fromName ?? "";

    let rawScore: number;
    let reason: string | null = null;

    // Resolve labels (with few-shot examples) for the unified AI call
    let autoLabelLabels: { id: string; name: string; examples: { subject: string; fromAddress: string }[] }[] | undefined;
    if (!params.isBackfill && settings.autoLabelEnabled) {
      try {
        const { getAccountAutoLabelEnabled } = await import("@/services/db/accounts");
        const accountEnabled = await getAccountAutoLabelEnabled(params.accountId);
        if (accountEnabled) {
          const { getUserLabelsForAccount, getLabelExamples } = await import("@/services/db/userLabels");
          const userLabels = await getUserLabelsForAccount(params.accountId);
          if (userLabels.length > 0) {
            autoLabelLabels = await Promise.all(
              userLabels.map(async (l) => ({
                id: l.id,
                name: l.name,
                examples: await getLabelExamples(params.accountId, l.id, 3),
              })),
            );
          }
        }
      } catch {
        // Non-fatal — auto-label is best-effort
      }
    }

    // Latest message of the thread: who sent it (a reply of ours?) and whether
    // the account is a direct recipient.
    const recipientRows = await db.select<{
      email: string;
      from_address: string | null;
      to_addresses: string | null;
      cc_addresses: string | null;
      bcc_addresses: string | null;
    }[]>(
      `SELECT a.email, m.from_address, m.to_addresses, m.cc_addresses, m.bcc_addresses
       FROM accounts a
       JOIN messages m ON m.account_id = a.id AND m.thread_id = ?2
       WHERE a.id = ?1
       ORDER BY m.date DESC LIMIT 1`,
      [params.accountId, params.threadId],
    );
    const recipientRow = recipientRows[0];
    const latestInbound =
      !!recipientRow &&
      (recipientRow.from_address ?? "").toLowerCase() !== recipientRow.email.toLowerCase();
    // The user answered last: the ball is in the other court. Keep whatever score
    // the thread has (the extinguish judge lowers it) — scoring the user's own
    // reply as if it were incoming mail would be meaningless.
    if (recipientRow && !latestInbound) return;

    const aiAvailable = await isAiAvailable();
    if (aiAvailable) {
      const aiResult = await scoreUrgencyWithAi(
        params.accountId,
        params.threadId,
        subject,
        sanitizeForUrgencyScoring(bodyText),
        fromAddress,
        fromName,
        autoLabelLabels,
        // Old mail is slowed first when the provider pushes back (rateLimiter.ts).
        params.isBackfill || Date.now() - params.lastMessageAt > LIVE_MAX_AGE_MS ? "backfill" : "live",
        // A new inbound message invalidates the cached score; our own reply doesn't
        // (the extinguish judge handles replies).
        latestInbound ? params.lastMessageAt : undefined,
      );
      if (aiResult !== null) {
        rawScore = aiResult.score;
        reason = aiResult.reason ?? null;
        // Apply auto-label if suggestion meets the confidence threshold
        if (
          autoLabelLabels &&
          aiResult.labelId &&
          (aiResult.confidence ?? 0) >= settings.autoLabelThreshold
        ) {
          try {
            const { addThreadLabel } = await import("@/services/emailActions");
            await addThreadLabel(params.accountId, params.threadId, aiResult.labelId);
            window.dispatchEvent(new CustomEvent("melo-sync-done"));
          } catch {
            // Non-fatal — label application is best-effort
          }
        }
      } else {
        // AI call failed — fall back to keywords
        rawScore = scoreUrgencyFromText(subject, sanitizeForUrgencyScoring(bodyText));
      }
    } else {
      rawScore = scoreUrgencyFromText(subject, sanitizeForUrgencyScoring(bodyText));
    }

    // Skip threads with no urgency signal at all
    if (rawScore === 0) return;

    // Apply user-configured priority domain boost (context AI doesn't have)
    const boost = ragPriorityDomainBoost(fromAddress, bodyText, settings.priorityDomains);
    const boostedScore = Math.min(1, rawScore + boost);

    // Apply behavioral reputation penalty (history AI doesn't have)
    const finalScore = fromAddress
      ? await adjustUrgencyWithReputation(params.accountId, fromAddress, boostedScore)
      : boostedScore;

    // Reduce urgency by 50% when the account is in CC/BCC but not a direct TO recipient
    let adjustedScore = finalScore;
    // Whether the most recent message in the thread was sent by the account owner (a reply).
    let latestFromOwner = false;
    if (recipientRow) {
      const email = recipientRow.email.toLowerCase();
      latestFromOwner = (recipientRow.from_address ?? "").toLowerCase() === email;
      const inTo = (recipientRow.to_addresses ?? "").toLowerCase().includes(email);
      const inCcOrBcc =
        (recipientRow.cc_addresses ?? "").toLowerCase().includes(email) ||
        (recipientRow.bcc_addresses ?? "").toLowerCase().includes(email);
      if (!inTo && inCcOrBcc) {
        adjustedScore = finalScore * 0.5;
      }
    }

    await setThreadUrgency(params.accountId, params.threadId, adjustedScore);
    // Fresh inbound scoring: persist the AI rationale and clear any prior
    // "lowered by partial reply" flag (this score reflects new activity).
    await setThreadUrgencyReason(params.accountId, params.threadId, reason);
    await setUrgencyReplyDecayed(params.accountId, params.threadId, false);

    // Re-ignite a previously-resolved thread only when genuinely new INBOUND activity
    // arrives. If the latest message is the user's own reply, leave it extinguished —
    // otherwise re-scoring on every sync would undo the urgency drop from replying.
    if (adjustedScore >= EXTINGUISH_RESET_THRESHOLD && !latestFromOwner) {
      await setHeatExtinguished(params.accountId, params.threadId, false);
    }
  } catch {
    // Urgency scoring is best-effort — never propagate errors to the caller
  }
}

// ---------------------------------------------------------------------------
// Backfill: score all recent un-scored threads on first activation
// ---------------------------------------------------------------------------

type BackfillRow = {
  id: string;
  account_id: string;
  subject: string | null;
  last_message_at: number | null;
  from_address: string | null;
  from_name: string | null;
  body_text: string | null;
  label_ids: string | null; // GROUP_CONCAT of thread_labels
};

const BACKFILL_BATCH = 20;
const BACKFILL_DELAY_MS = 30;

let urgencyBackfillRun: Promise<void> | null = null;
let resumeHookInstalled = false;

/**
 * Score urgency for all recent un-scored threads across all accounts.
 * Runs at startup, and again whenever the AI backlog lane reopens after a
 * provider rate limit (threads skipped while paused keep urgency_score = 0, so
 * they are picked up here). Emits "melo-sync-done" on completion.
 *
 * Newest first: when the provider limits us, the OLDEST mail is what waits.
 * Keyset pagination — the old OFFSET skipped rows, because every thread scored
 * in a batch leaves the `urgency_score = 0` set and shifts the next page.
 */
export function runUrgencyBackfill(): Promise<void> {
  if (!resumeHookInstalled) {
    resumeHookInstalled = true;
    onBacklogResume(() => {
      runUrgencyBackfill().catch(() => {});
    });
  }
  urgencyBackfillRun ??= doUrgencyBackfill().finally(() => {
    urgencyBackfillRun = null;
  });
  return urgencyBackfillRun;
}

async function doUrgencyBackfill(): Promise<void> {
  const settings = await getUrgencySettings();
  if (!settings.behaviorEnabled || !settings.urgencyEnabled) return;

  const cutoffMs = Date.now() - settings.decayFloorDays * 86_400_000;
  const db = await getDb();
  const aiAvailable = await isAiAvailable();
  let cursor: { at: number; id: string } | null = null;

  while (true) {
    const rows: BackfillRow[] = await db.select<BackfillRow[]>(
      `SELECT t.id, t.account_id, t.subject, t.last_message_at,
              m.from_address, m.from_name, m.body_text,
              (SELECT GROUP_CONCAT(tl.label_id) FROM thread_labels tl
               WHERE tl.account_id = t.account_id AND tl.thread_id = t.id) AS label_ids
       FROM threads t
       LEFT JOIN messages m ON m.account_id = t.account_id
         AND m.thread_id = t.id AND m.date = t.last_message_at
       LEFT JOIN thread_categories tc ON tc.account_id = t.account_id AND tc.thread_id = t.id
       WHERE t.urgency_score = 0
         AND (t.manual_urgency_override IS NULL OR t.manual_urgency_override = 0)
         AND t.last_message_at IS NOT NULL
         AND t.last_message_at >= $1
         AND (tc.category IS NULL OR tc.category = 'Primary')
         AND ($2 IS NULL OR t.last_message_at < $2 OR (t.last_message_at = $2 AND t.id < $3))
       GROUP BY t.id, t.account_id
       ORDER BY t.last_message_at DESC, t.id DESC
       LIMIT $4`,
      [cutoffMs, cursor?.at ?? null, cursor?.id ?? "", BACKFILL_BATCH],
    );

    if (rows.length === 0) break;

    for (const row of rows) {
      // Provider said "slow down": wait for the backlog lane instead of firing
      // calls that are refused anyway (they used to retry forever).
      if (aiAvailable && !isLaneOpen("backfill")) await waitForLane("backfill");

      await processThreadUrgency({
        accountId: row.account_id,
        threadId: row.id,
        subject: row.subject,
        bodyText: row.body_text,
        fromAddress: row.from_address,
        fromName: row.from_name,
        lastMessageAt: row.last_message_at ?? 0,
        labelIds: row.label_ids ? row.label_ids.split(",") : [],
        isBackfill: true,
      });

      // This very call hit the limit: the thread is still unscored. Don't move
      // the cursor past it — re-query from here once the lane reopens.
      if (aiAvailable && !isLaneOpen("backfill")) break;
      cursor = { at: row.last_message_at ?? 0, id: row.id };
      await new Promise<void>((r) => setTimeout(r, BACKFILL_DELAY_MS));
    }

    if (aiAvailable && !isLaneOpen("backfill")) continue;
    if (rows.length < BACKFILL_BATCH) break;
  }

  window.dispatchEvent(new CustomEvent("melo-sync-done"));
}

// ---------------------------------------------------------------------------
// Extinguish backfill: retroactively resolve threads already replied to
// ---------------------------------------------------------------------------

/**
 * For each urgent unextinguished thread within the decay window where a reply
 * from the account owner is present, run the Smart Judge and extinguish (or decay) it.
 *
 * The reply is detected from the DB (latest message whose from_address == the account
 * email), so it fires regardless of where the reply was sent from — replying via Melo
 * OR from an external client (Gmail web, phone, etc.) both feed reputation once the
 * sent message syncs in. Threads already reply-processed are skipped via the
 * is_heat_extinguished / urgency_reply_decayed flags, so this is safe to run after
 * every sync cycle; a fresh inbound message resets urgency_reply_decayed (see
 * scoreThreadUrgency) so a later reply is re-evaluated.
 */
export async function runExtinguishBackfill(): Promise<void> {
  const settings = await getUrgencySettings();
  if (!settings.behaviorEnabled || !settings.urgencyEnabled) return;

  const autoExtinguish = await getSetting("ai_urgency_auto_extinguish");
  if (autoExtinguish !== "true") return;

  const cutoffMs = Date.now() - settings.decayFloorDays * 86_400_000;
  const db = await getDb();

  // Threads urgent + not extinguished + within decay window + user has already replied
  const rows = await db.select<{
    thread_id: string;
    account_id: string;
    urgency_score: number;
    from_address: string | null;
    received_subject: string | null;
    received_text: string | null;
    reply_text: string | null;
  }[]>(
    `SELECT
       t.id            AS thread_id,
       t.account_id,
       t.urgency_score,
       t.from_address,
       (SELECT m.subject FROM messages m
        WHERE m.account_id = t.account_id AND m.thread_id = t.id
        ORDER BY m.date ASC LIMIT 1)                              AS received_subject,
       (SELECT m.body_text FROM messages m
        WHERE m.account_id = t.account_id AND m.thread_id = t.id
          AND LOWER(m.from_address) != LOWER(a.email)
        ORDER BY m.date DESC LIMIT 1)                             AS received_text,
       (SELECT m.body_text FROM messages m
        WHERE m.account_id = t.account_id AND m.thread_id = t.id
          AND LOWER(m.from_address) = LOWER(a.email)
        ORDER BY m.date DESC LIMIT 1)                             AS reply_text
     FROM threads t
     JOIN accounts a ON a.id = t.account_id
     WHERE t.urgency_score > 0
       AND t.is_heat_extinguished = 0
       AND (t.manual_urgency_override IS NULL OR t.manual_urgency_override = 0)
       AND (t.urgency_reply_decayed IS NULL OR t.urgency_reply_decayed = 0)
       AND t.last_message_at IS NOT NULL
       AND t.last_message_at >= $1`,
    [cutoffMs],
  );

  // Only act where the user has actually sent a reply
  const replied = rows.filter((r) => (r.reply_text ?? "").trim().length > 10);
  if (replied.length === 0) return;

  const aiAvailable = await isAiAvailable();
  const { judgeUrgencyResolved } = await import("./aiService");

  for (const row of replied) {
    // Backlog lane paused by a provider rate limit: stop. The remaining rows keep
    // their flags and are retried on the next run (after every sync cycle).
    if (aiAvailable && !isLaneOpen("backfill")) break;
    try {
      const receivedText = [row.received_subject ?? "", (row.received_text ?? "").slice(0, 600)]
        .filter(Boolean)
        .join("\n");
      const replyText = (row.reply_text ?? "").slice(0, 400);

      // Only the AI verdict can zero the urgency. Without AI/context, conservatively
      // apply the 30% reduction rather than assuming the topic is closed.
      let resolved = false;
      if (aiAvailable && receivedText) {
        try {
          resolved = await judgeUrgencyResolved(receivedText, replyText, "backfill");
        } catch (err) {
          // Rate limited: no verdict — leave the thread untouched for a later run
          // rather than decaying it on a non-answer.
          if (err instanceof AiError && err.code === "RATE_LIMITED") break;
          resolved = false;
        }
      }

      if (resolved) {
        // Reply closed the topic → urgency to zero + mark resolved.
        await setThreadUrgency(row.account_id, row.thread_id, 0);
        await setHeatExtinguished(row.account_id, row.thread_id, true);
        await setUrgencyReplyDecayed(row.account_id, row.thread_id, false);
      } else {
        // Topic still open → reduce urgency by 30% and flag the partial-reply decay.
        const decayed = row.urgency_score * 0.7;
        await setThreadUrgency(row.account_id, row.thread_id, decayed);
        await setUrgencyReplyDecayed(row.account_id, row.thread_id, true);
      }

      if (row.from_address) {
        await logInteraction(row.account_id, row.from_address, "REPLY_SENT", row.thread_id);
      }
    } catch {
      // best-effort — never block
    }
    await new Promise<void>((r) => setTimeout(r, BACKFILL_DELAY_MS));
  }

  window.dispatchEvent(new CustomEvent("melo-sync-done"));
}
