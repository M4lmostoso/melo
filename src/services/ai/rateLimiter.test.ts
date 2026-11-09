import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

const store = new Map<string, string>();
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (k: string) => store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void store.set(k, v)),
}));
vi.mock("@/utils/fileLog", () => ({ logToFile: vi.fn() }));

import {
  acquire,
  report429,
  reportSuccess,
  isLaneOpen,
  laneReopensAt,
  parseRetryAfterMs,
  msUntilPacificMidnight,
  onBacklogResume,
  resetRateLimit,
  getRateLimitStatus,
  __resetForTests,
} from "./rateLimiter";

const rl429 = (message = "429 Too Many Requests", extra: object = {}) =>
  Object.assign(new Error(message), { status: 429 }, extra);

describe("rateLimiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-09T12:00:00Z"));
    store.clear();
    __resetForTests();
  });
  afterEach(() => vi.useRealTimers());

  it("lets every lane through when nothing went wrong", async () => {
    await expect(acquire("interactive")).resolves.toBeUndefined();
    await expect(acquire("live")).resolves.toBeUndefined();
    expect(isLaneOpen("backfill")).toBe(true);
  });

  it("after a 429 pauses new mail briefly and OLD mail twice as long; interactive is never blocked", async () => {
    const pause = report429(rl429());
    expect(pause).toBe(30_000);

    await expect(acquire("live")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(acquire("backfill")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(acquire("interactive")).resolves.toBeUndefined();

    vi.advanceTimersByTime(30_001);
    expect(isLaneOpen("live")).toBe(true);
    expect(isLaneOpen("backfill")).toBe(false); // old mail still waiting
    vi.advanceTimersByTime(30_000);
    expect(isLaneOpen("backfill")).toBe(true);
  });

  it("backs off exponentially and relaxes on success", () => {
    expect(report429(rl429())).toBe(30_000);
    expect(report429(rl429())).toBe(60_000);
    expect(report429(rl429())).toBe(120_000);
    reportSuccess();
    reportSuccess();
    expect(report429(rl429())).toBe(60_000);
  });

  it("honours the provider's Retry-After when longer than the backoff", () => {
    const headers = new Headers({ "retry-after": "90" });
    expect(report429(rl429("rate limited", { headers }))).toBe(90_000);
  });

  it("parses Google's retryDelay and 'retry in Ns' hints", () => {
    expect(parseRetryAfterMs(new Error('{"error":{"details":[{"retryDelay":"37s"}]}}'))).toBe(37_000);
    expect(parseRetryAfterMs(new Error("Quota exceeded. Please retry in 12.5s."))).toBe(12_500);
    expect(parseRetryAfterMs(new Error("nothing here"))).toBeNull();
  });

  it("a Google daily-quota 429 pauses until midnight Pacific", () => {
    // 12:00Z = 04:00 PST → 20h to midnight (+1 min margin)
    expect(msUntilPacificMidnight(new Date())).toBe(20 * 3_600_000 + 60_000);
    const pause = report429(
      rl429("RESOURCE_EXHAUSTED quotaId: GenerateRequestsPerDayPerProjectPerModel-FreeTier"),
      "gemini",
    );
    expect(pause).toBe(20 * 3_600_000 + 60_000);
  });

  it("spaces background calls, and new mail jumps ahead of waiting backlog calls", async () => {
    report429(rl429()); // gap → 2s
    vi.advanceTimersByTime(60_001); // both lanes open again, spacing still wide

    const order: string[] = [];
    await acquire("live"); // takes the slot now
    order.push("live-1");
    const backlog = acquire("backfill").then(() => order.push("backfill"));
    const live2 = acquire("live").then(() => order.push("live-2"));

    await vi.advanceTimersByTimeAsync(10_000);
    await Promise.all([backlog, live2]);
    expect(order).toEqual(["live-1", "live-2", "backfill"]);
  });

  it("persists the pause so a restart doesn't hammer the provider", async () => {
    report429(rl429());
    expect(store.get("ai_rate_limit_state")).toBeTruthy();
    __resetForTests(); // simulate a fresh window/app start
    await expect(acquire("live")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("notifies backlog listeners when the backlog lane reopens", async () => {
    const cb = vi.fn();
    onBacklogResume(cb);
    report429(rl429());
    await vi.advanceTimersByTimeAsync(59_000);
    expect(cb).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(3_000);
    expect(cb).toHaveBeenCalledOnce();
  });

  it("reset clears the pause (new provider/key/model) and wakes the backlog", () => {
    const cb = vi.fn();
    onBacklogResume(cb);
    report429(rl429());
    expect(getRateLimitStatus()).not.toBeNull();
    resetRateLimit();
    expect(getRateLimitStatus()).toBeNull();
    expect(laneReopensAt("backfill")).toBe(0);
    expect(cb).toHaveBeenCalledOnce();
  });
});
