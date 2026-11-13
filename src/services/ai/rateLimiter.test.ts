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
  setRateLimitOwner,
  setRequestCap,
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

  it("backs off exponentially across pauses and relaxes on success", () => {
    expect(report429(rl429())).toBe(30_000);
    vi.advanceTimersByTime(30_001);
    expect(report429(rl429())).toBe(60_000);
    vi.advanceTimersByTime(60_001);
    expect(report429(rl429())).toBe(120_000);
    vi.advanceTimersByTime(120_001);
    reportSuccess();
    reportSuccess();
    expect(report429(rl429())).toBe(60_000);
  });

  it("a 429 while already paused neither escalates nor renews the pause", () => {
    // 2026-11-12: quick replies on every opened thread drove 30s → 1h and kept
    // renewing the hour while the user read mail.
    report429(rl429());
    const until = laneReopensAt("live");
    const backlogUntil = laneReopensAt("backfill");
    vi.advanceTimersByTime(10_000);
    for (let i = 0; i < 20; i++) expect(report429(rl429())).toBe(20_000); // time left
    expect(laneReopensAt("live")).toBe(until);
    expect(laneReopensAt("backfill")).toBe(backlogUntil);
    // …and the next real one, after the pause, is level 1 — not level 21.
    vi.advanceTimersByTime(20_001);
    expect(report429(rl429())).toBe(60_000);
  });

  it("while paused, an explicit longer Retry-After still extends the pause", () => {
    report429(rl429());
    const headers = new Headers({ "retry-after": "600" });
    expect(report429(rl429("rate limited", { headers }))).toBe(600_000);
    expect(laneReopensAt("live")).toBe(Date.now() + 600_000);
  });

  it("auto calls (thread opened, nobody clicked) are refused while paused and never queued", async () => {
    await expect(acquire("auto")).resolves.toBeUndefined();
    report429(rl429()); // gap → 2s: a live call would now wait for its slot
    await expect(acquire("auto")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(acquire("interactive")).resolves.toBeUndefined();
    vi.advanceTimersByTime(30_001);
    await acquire("live"); // claims the slot
    await expect(acquire("auto")).resolves.toBeUndefined(); // no spacing for auto
  });

  it("a pause persisted by another provider/key/model is not reloaded after a restart", async () => {
    setRateLimitOwner("openrouter|key|model-a");
    report429(rl429());
    __resetForTests(); // restart…
    setRateLimitOwner("kilo|key|model-b"); // …on a different provider
    await expect(acquire("live")).resolves.toBeUndefined();

    __resetForTests();
    setRateLimitOwner("kilo|key|model-b");
    report429(rl429());
    __resetForTests(); // restart on the SAME provider keeps the pause
    setRateLimitOwner("kilo|key|model-b");
    await expect(acquire("live")).rejects.toMatchObject({ code: "RATE_LIMITED" });
  });

  it("a request cap holds background calls in a 60 s window without a 429", async () => {
    setRequestCap(3);
    const t0 = Date.now();
    for (let i = 0; i < 3; i++) {
      const p = acquire("live"); // live calls are also spaced 250 ms apart
      await vi.advanceTimersByTimeAsync(300);
      await p;
    }
    let fourth = false;
    const pending = acquire("live").then(() => (fourth = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fourth).toBe(false); // still inside the minute
    await vi.advanceTimersByTimeAsync(31_000);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(60_000);
    await pending;
    expect(fourth).toBe(true);
    expect(isLaneOpen("live")).toBe(true); // waited, never paused
  });

  it("under the cap: auto is refused once the minute is spent, interactive is not held but counts", async () => {
    setRequestCap(2);
    await acquire("interactive");
    await acquire("auto");
    await expect(acquire("auto")).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(acquire("interactive")).resolves.toBeUndefined();
    vi.advanceTimersByTime(60_001);
    await expect(acquire("auto")).resolves.toBeUndefined();
  });

  it("a token cap holds a big call until the window has room, settled with the real usage", async () => {
    setRequestCap(null, 8_000);
    const first = { at: 0, tokens: 0 };
    await acquire("live", 2_000, first);
    first.tokens = 6_500; // the provider reported more than estimated
    await vi.advanceTimersByTimeAsync(300);
    let second = false;
    const pending = acquire("live", 2_000).then(() => (second = true));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(second).toBe(false); // 6.5K + 2K > 8K: waits for the first to leave the window
    await vi.advanceTimersByTimeAsync(31_000);
    await pending;
    expect(second).toBe(true);
  });

  it("a token cap refuses auto calls that don't fit and never blocks an empty window", async () => {
    setRequestCap(null, 1_000);
    await expect(acquire("auto", 5_000)).resolves.toBeUndefined(); // empty window: admitted
    await expect(acquire("auto", 100)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    await expect(acquire("interactive", 100)).resolves.toBeUndefined();
  });

  it("without a cap nothing is held", async () => {
    setRequestCap(null);
    for (let i = 0; i < 100; i++) await acquire("auto");
  });

  it("changing owner in-session drops the pause; the API key is not persisted in clear", () => {
    setRateLimitOwner("openai|sk-secret|m");
    report429(rl429());
    expect(store.get("ai_rate_limit_state")).not.toContain("sk-secret");
    setRateLimitOwner("openai|sk-other|m");
    expect(isLaneOpen("live")).toBe(true);
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
    // The quota resets at the same time for both lanes — the backlog is not doubled to 40h.
    expect(laneReopensAt("backfill")).toBe(laneReopensAt("live"));
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
