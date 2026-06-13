import { scanMessage, HARD_PHISHING_RULES } from "@/utils/phishingDetector";
import type { LinkAnalysis, MessageScanResult, PhishingSensitivity } from "@/utils/phishingDetector";
import { getSetting } from "@/services/db/settings";
import { isPhishingAllowlisted } from "@/services/db/phishingAllowlist";
import { getCachedScanResult, cacheScanResult } from "@/services/db/linkScanResults";

/**
 * Build a compact, literal context for the AI phishing judge: the sender, the
 * heuristically-flagged links (display text → destination host + which rules fired),
 * and a short plain-text excerpt of the body.
 */
function buildPhishingContext(
  senderAddress: string | null,
  bodyHtml: string | null,
  links: LinkAnalysis[],
): string {
  const suspicious = links.filter((l) => l.riskScore >= 20).slice(0, 8);
  const linkLines = suspicious
    .map((l) => {
      let host = l.url;
      try {
        host = new URL(l.url).hostname;
      } catch {
        // keep raw url
      }
      const rules = l.triggeredRules.map((r) => r.ruleId).join(", ");
      const text = (l.displayText || "").trim().replace(/\s+/g, " ").slice(0, 80);
      return `- text "${text}" -> ${host} [${rules}]`;
    })
    .join("\n");

  let bodyText = "";
  if (bodyHtml) {
    try {
      const doc = new DOMParser().parseFromString(bodyHtml, "text/html");
      bodyText = (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 600);
    } catch {
      // ignore — body excerpt is best-effort
    }
  }

  return [
    `Sender: ${senderAddress ?? "unknown"}`,
    "Flagged links:",
    linkLines || "(none)",
    "",
    "Body excerpt:",
    bodyText || "(empty)",
  ].join("\n");
}

/**
 * Orchestrates phishing link scanning for a message.
 *
 * Flow:
 * 1. Check if feature is enabled (setting: phishing_detection_enabled)
 * 2. Check if sender is in the allowlist
 * 3. Check cache for existing result
 * 4. Scan the message HTML
 * 5. Cache the result
 */
export async function scanMessageLinks(
  accountId: string,
  messageId: string,
  bodyHtml: string | null,
  senderAddress: string | null,
): Promise<MessageScanResult | null> {
  // 1. Check if phishing detection is enabled
  const enabled = await getSetting("phishing_detection_enabled");
  if (enabled === "false") {
    return null;
  }

  // 2. Check if sender is allowlisted
  if (senderAddress) {
    const allowlisted = await isPhishingAllowlisted(accountId, senderAddress);
    if (allowlisted) {
      return null;
    }
  }

  // 3. Check cache
  const cached = await getCachedScanResult(accountId, messageId);
  if (cached) {
    try {
      return JSON.parse(cached) as MessageScanResult;
    } catch {
      // Invalid cache entry — proceed with fresh scan
    }
  }

  // 4. Read sensitivity setting and scan the message
  const sensitivityRaw = await getSetting("phishing_sensitivity");
  const sensitivity: PhishingSensitivity =
    sensitivityRaw === "low" || sensitivityRaw === "high" ? sensitivityRaw : "default";
  const result = scanMessage(messageId, bodyHtml, sensitivity);

  // 4b. AI arbitration — reduce false positives.
  // The heuristics over-flag ordinary mail (newsletters, marketing, tracking links).
  // When only soft heuristics fired, let the AI judge the message holistically and
  // suppress the banner when it's clearly safe. Hard, near-certain signals
  // (deceptive display/href mismatch, dangerous protocol, punycode) always show and
  // skip the AI step. Falls back to the heuristic verdict if AI is unavailable or errors.
  if (result.showBanner) {
    const hasHardSignal = result.links.some((l) =>
      l.triggeredRules.some((r) => HARD_PHISHING_RULES.has(r.ruleId)),
    );
    const aiVerdictEnabled = (await getSetting("phishing_ai_verdict_enabled")) !== "false";
    if (!hasHardSignal && aiVerdictEnabled) {
      try {
        const { isAiAvailable } = await import("@/services/ai/providerManager");
        if (await isAiAvailable()) {
          const { judgePhishingRisk } = await import("@/services/ai/aiService");
          const context = buildPhishingContext(senderAddress, bodyHtml, result.links);
          const { verdict, reason } = await judgePhishingRisk(context);
          result.aiVerdict = verdict;
          result.aiReason = reason;
          // The AI verdict is the arbiter for soft heuristic hits: only keep the
          // banner when it considers the message phishing or suspicious.
          result.showBanner = verdict !== "safe";
        }
      } catch (err) {
        // AI unavailable / failed — keep the heuristic verdict unchanged.
        console.error("Phishing AI verdict failed:", err);
      }
    }
  }

  // 5. Cache the result
  try {
    await cacheScanResult(accountId, messageId, JSON.stringify(result));
  } catch (err) {
    console.error("Failed to cache phishing scan result:", err);
  }

  return result;
}
