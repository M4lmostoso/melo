import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/services/db/phishingAllowlist", () => ({ isPhishingAllowlisted: vi.fn() }));
vi.mock("@/services/db/linkScanResults", () => ({
  getCachedScanResult: vi.fn(),
  cacheScanResult: vi.fn(() => Promise.resolve()),
}));
vi.mock("@/services/ai/providerManager", () => ({ isAiAvailable: vi.fn() }));
vi.mock("@/services/ai/aiService", () => ({ judgePhishingRisk: vi.fn() }));

import { scanMessageLinks } from "./phishingScanner";
import { getSetting } from "@/services/db/settings";
import { isPhishingAllowlisted } from "@/services/db/phishingAllowlist";
import { getCachedScanResult } from "@/services/db/linkScanResults";
import { isAiAvailable } from "@/services/ai/providerManager";
import { judgePhishingRisk } from "@/services/ai/aiService";

// Soft heuristic hit: tracking-style subdomains (excessive-subdomains) + "verify"/"token"
// (suspicious-keywords) → score 40 → banner under default sensitivity, but NO hard rule.
const SOFT_FP_HTML =
  '<a href="https://click.e.marketing.shop.com/verify?token=abc123">View your order</a>';

// Hard signal: visible text shows paypal.com but href points to evil.com (display-mismatch).
const HARD_PHISH_HTML = '<a href="https://evil.example.com/login">https://paypal.com/account</a>';

describe("scanMessageLinks — AI arbitration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: feature enabled, default sensitivity, AI verdict enabled (null !== "false").
    vi.mocked(getSetting).mockResolvedValue(null as never);
    vi.mocked(isPhishingAllowlisted).mockResolvedValue(false);
    vi.mocked(getCachedScanResult).mockResolvedValue(null);
    vi.mocked(isAiAvailable).mockResolvedValue(true);
  });

  it("suppresses the banner on a soft heuristic hit the AI judges SAFE (e.g. newsletter)", async () => {
    vi.mocked(judgePhishingRisk).mockResolvedValue({ verdict: "safe", reason: "legitimate marketing email" });

    const result = await scanMessageLinks("acct-1", "m1", SOFT_FP_HTML, "news@shop.com");

    expect(judgePhishingRisk).toHaveBeenCalledTimes(1);
    expect(result?.aiVerdict).toBe("safe");
    expect(result?.showBanner).toBe(false);
  });

  it("keeps the banner when the AI confirms phishing on a soft hit", async () => {
    vi.mocked(judgePhishingRisk).mockResolvedValue({ verdict: "phishing", reason: "credential-harvesting page" });

    const result = await scanMessageLinks("acct-1", "m1", SOFT_FP_HTML, "news@shop.com");

    expect(result?.showBanner).toBe(true);
    expect(result?.aiVerdict).toBe("phishing");
    expect(result?.aiReason).toContain("credential");
  });

  it("always shows the banner for HARD signals without calling the AI", async () => {
    const result = await scanMessageLinks("acct-1", "m2", HARD_PHISH_HTML, "scam@evil.example.com");

    expect(judgePhishingRisk).not.toHaveBeenCalled();
    expect(result?.showBanner).toBe(true);
  });

  it("falls back to the heuristic verdict when AI is unavailable", async () => {
    vi.mocked(isAiAvailable).mockResolvedValue(false);

    const result = await scanMessageLinks("acct-1", "m1", SOFT_FP_HTML, "news@shop.com");

    expect(judgePhishingRisk).not.toHaveBeenCalled();
    expect(result?.showBanner).toBe(true); // heuristic banner preserved
  });

  it("does not run AI arbitration when the AI verdict setting is disabled", async () => {
    vi.mocked(getSetting).mockImplementation((key: string) =>
      Promise.resolve(key === "phishing_ai_verdict_enabled" ? "false" : null) as never,
    );

    const result = await scanMessageLinks("acct-1", "m1", SOFT_FP_HTML, "news@shop.com");

    expect(judgePhishingRisk).not.toHaveBeenCalled();
    expect(result?.showBanner).toBe(true);
  });

  it("keeps the heuristic verdict if the AI call throws", async () => {
    vi.mocked(judgePhishingRisk).mockRejectedValue(new Error("AI down"));

    const result = await scanMessageLinks("acct-1", "m1", SOFT_FP_HTML, "news@shop.com");

    expect(result?.showBanner).toBe(true);
  });
});
