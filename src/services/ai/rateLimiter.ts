/**
 * Adaptive rate limiter for every AI call (wraps the active provider client in
 * providerManager, so nothing can bypass it).
 *
 * Why: with no backoff, one day of quota exhaustion produced 1517 requests of
 * which 1515 were rejected, in bursts of 5–10/s — the backfills retried forever
 * and burned whatever per-minute headroom was left.
 *
 * Three lanes, slowed in this order when the provider pushes back:
 *  - `backfill`    — old mail (urgency/extinguish backfills, threads older than a
 *                    day). Paused FIRST and LONGEST, spaced twice as wide, and
 *                    always yields to waiting `live` calls.
 *  - `live`        — mail that just arrived (sync-time urgency, categorisation,
 *                    smart labels, phishing judge). Paused for the provider's
 *                    retry window only.
 *  - `auto`        — something the UI asks for by itself when a thread opens
 *                    (auto summary, quick replies). Not queued — it is on
 *                    screen — but refused while `live` is paused: nobody clicked,
 *                    so it must not spend a request on a provider that said no.
 *  - `interactive` — something the user just asked for (summary, draft, Ask
 *                    Inbox…). Never queued or paused: the user clicked, they get
 *                    an answer or the provider's error.
 *
 * On a 429: exponential pause (30s → 1h, or the provider's Retry-After /
 * retryDelay if longer; a Google daily-quota error pauses until the quota resets
 * at midnight Pacific), background spacing doubles; successes relax it again.
 * The pause is persisted so a restart doesn't hammer a provider that said no.
 *
 * A 429 that arrives while the lanes are ALREADY paused never escalates: it can
 * only come from an `interactive` call or from one that was in flight when the
 * pause began, so it says nothing about whether the pause was long enough. On
 * 2026-11-12 quick replies firing on every opened thread took the pause from
 * 30s to 1h in 21 minutes and then renewed the full hour 20 more times — new
 * mail got no urgency/category for as long as the user kept reading.
 *
 * A provider with a published per-minute quota (NVIDIA NIM: 40/min) also gets a
 * request CAP (`setRequestCap`): `live`/`backfill` wait for a free slot in the
 * last 60 s and `auto` is refused when there is none — so the backfill, which
 * otherwise fires as fast as the model answers, never reaches the 429 at all.
 * Every call counts toward the window; `interactive` is never held by it (the
 * cap sits below the quota precisely to leave that headroom).
 *
 * The cap can also count TOKENS per minute (Groq's free plan: 8K/min per model,
 * which binds long before its 30 requests/min — one categorisation of 20 threads
 * is ~3.5K tokens on Qwen and ~6.5K on GPT-OSS 20B, soul.md alone ~1K). A call
 * enters the window with an estimate and is settled with the provider's real
 * `usage.total_tokens` when it completes (`CapSlot`).
 */
import { getSetting, setSetting } from "@/services/db/settings";
import { logToFile } from "@/utils/fileLog";
import { AiError } from "./errors";

export type AiPriority = "interactive" | "auto" | "live" | "backfill";

const BACKOFF_MS = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000, 3_600_000];
const BASE_GAP_MS = 250;
const MAX_GAP_MS = 30_000;
const STATE_KEY = "ai_rate_limit_state";

interface LimiterState {
  /** `live` calls are refused until then. */
  pausedUntil: number;
  /** `backfill` calls are refused until then (≥ pausedUntil). */
  backfillResumeAt: number;
  /** Index into BACKOFF_MS of the next 429. */
  level: number;
  /** Minimum spacing between background call starts. */
  gapMs: number;
  /** Earliest start of the next background call. */
  nextBackgroundAt: number;
  liveWaiting: number;
}

const fresh = (): LimiterState => ({
  pausedUntil: 0,
  backfillResumeAt: 0,
  level: 0,
  gapMs: BASE_GAP_MS,
  nextBackgroundAt: 0,
  liveWaiting: 0,
});

let state = fresh();
/** Max calls started in any 60 s window (null = no cap). */
let requestCap: number | null = null;
/** Max tokens (in + out) spent in any 60 s window (null = no cap). */
let tokenCap: number | null = null;

/** One call in the cap window. `tokens` starts as an estimate and is settled later. */
export interface CapSlot {
  at: number;
  tokens: number;
}

/** Calls started in the last 60 s, oldest first. */
let recentStarts: CapSlot[] = [];
const CAP_WINDOW_MS = 60_000;
/** Hash of provider|credentials|model the current pause belongs to. */
let owner: string | null = null;
let loaded: Promise<void> | null = null;
let resumeTimer: ReturnType<typeof setTimeout> | null = null;
const resumeListeners = new Set<() => void>();

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function loadPersisted(): Promise<void> {
  loaded ??= getSetting(STATE_KEY)
    .then((raw) => {
      if (!raw) return;
      const p = JSON.parse(raw) as Partial<LimiterState> & { owner?: string };
      // A pause earned by another provider/key/model is not ours to serve: the
      // in-session switch resets it, but a restart used to reload it blindly.
      if (p.owner && owner && p.owner !== owner) return;
      const now = Date.now();
      if ((p.backfillResumeAt ?? 0) > now) {
        state.pausedUntil = Math.max(state.pausedUntil, p.pausedUntil ?? 0);
        state.backfillResumeAt = Math.max(state.backfillResumeAt, p.backfillResumeAt ?? 0);
        state.level = Math.max(state.level, p.level ?? 0);
        scheduleResume();
      }
    })
    .catch(() => {});
  return loaded;
}

function persist(): void {
  const { pausedUntil, backfillResumeAt, level } = state;
  setSetting(STATE_KEY, JSON.stringify({ pausedUntil, backfillResumeAt, level, owner })).catch(() => {});
}

function scheduleResume(): void {
  if (resumeTimer) clearTimeout(resumeTimer);
  const delay = state.backfillResumeAt - Date.now();
  if (delay <= 0) return;
  resumeTimer = setTimeout(() => {
    resumeTimer = null;
    for (const cb of resumeListeners) {
      try {
        cb();
      } catch {
        /* a listener must not break the others */
      }
    }
  }, delay + 1_000);
}

/** ms until a call of ~`estTokens` may start without exceeding the caps (0 = now). */
function capWait(estTokens = 0, now = Date.now()): number {
  if (requestCap === null && tokenCap === null) return 0;
  while (recentStarts.length > 0 && recentStarts[0]!.at <= now - CAP_WINDOW_MS) recentStarts.shift();
  let wait = 0;
  if (requestCap !== null && recentStarts.length >= requestCap) {
    // The window drops below the cap once the (len − cap)-th oldest start expires.
    wait = recentStarts[recentStarts.length - requestCap]!.at + CAP_WINDOW_MS - now + 1;
  }
  // An empty window always admits one call, however big — otherwise a single
  // request larger than the cap would wait forever.
  if (tokenCap !== null && recentStarts.length > 0) {
    let used = recentStarts.reduce((sum, s) => sum + s.tokens, 0);
    for (const s of recentStarts) {
      if (used + estTokens <= tokenCap) break;
      used -= s.tokens;
      wait = Math.max(wait, s.at + CAP_WINDOW_MS - now + 1);
    }
  }
  return wait;
}

function noteStart(estTokens: number, slot?: CapSlot): void {
  const entry = slot ?? { at: 0, tokens: 0 };
  entry.at = Date.now();
  entry.tokens = Math.max(entry.tokens, estTokens);
  recentStarts.push(entry);
}

/**
 * Cap the calls (and optionally the tokens) per minute for the active provider
 * (null = no cap). Set by the provider manager from its tables whenever it builds
 * a client.
 */
export function setRequestCap(perMinute: number | null, tokensPerMinute: number | null = null): void {
  requestCap = perMinute && perMinute > 0 ? Math.floor(perMinute) : null;
  tokenCap = tokensPerMinute && tokensPerMinute > 0 ? Math.floor(tokensPerMinute) : null;
}

function rateLimited(until: number): AiError {
  const err = new AiError("RATE_LIMITED", `AI provider rate limit — paused until ${new Date(until).toISOString()}`);
  err.retryAt = until;
  return err;
}

/** `auto` shares the `live` pause; only `backfill` waits longer. */
const laneUntil = (lane: AiPriority): number =>
  lane === "backfill" ? state.backfillResumeAt : state.pausedUntil;

/** Whether `lane` may call the provider right now. */
export function isLaneOpen(lane: AiPriority, now = Date.now()): boolean {
  if (lane === "interactive") return true;
  return now >= laneUntil(lane);
}

/** When `lane` reopens (0 = open now). */
export function laneReopensAt(lane: AiPriority): number {
  if (lane === "interactive") return 0;
  const at = laneUntil(lane);
  return at > Date.now() ? at : 0;
}

/**
 * Wait for a slot in `lane`. Throws `AiError("RATE_LIMITED")` immediately —
 * without touching the network — while the lane is paused.
 *
 * `estTokens` is the call's expected size for the token cap; pass a `slot` to
 * correct it afterwards with the real usage (`slot.tokens = usage`).
 */
export async function acquire(lane: AiPriority, estTokens = 0, slot?: CapSlot): Promise<void> {
  if (lane === "interactive") {
    noteStart(estTokens, slot);
    return;
  }
  await loadPersisted();
  if (!isLaneOpen(lane)) throw rateLimited(laneReopensAt(lane));
  if (lane === "auto") {
    // On screen: refused while paused or while the minute's quota is spent, never queued.
    const wait = capWait(estTokens);
    if (wait > 0) throw rateLimited(Date.now() + wait);
    noteStart(estTokens, slot);
    return;
  }

  if (lane === "live") state.liveWaiting++;
  try {
    for (;;) {
      if (!isLaneOpen(lane)) throw rateLimited(laneReopensAt(lane));
      if (lane === "backfill" && state.liveWaiting > 0) {
        await sleep(Math.max(state.gapMs, 50));
        continue;
      }
      const wait = Math.max(state.nextBackgroundAt - Date.now(), capWait(estTokens));
      if (wait <= 0) break;
      // Re-check at least every 5 s: a pause, a reset or a waiting live call may
      // change the answer while a backfill call sleeps on the minute window.
      await sleep(Math.min(wait, 5_000));
    }
    // Claim the slot synchronously right after the check — no other waiter can
    // run between the two, so two calls never start in the same slot.
    state.nextBackgroundAt = Date.now() + (lane === "backfill" ? state.gapMs * 2 : state.gapMs);
    noteStart(estTokens, slot);
  } finally {
    if (lane === "live") state.liveWaiting--;
  }
}

/** Resolve once `lane` is open again (polls, so a reset wakes it within a minute). */
export async function waitForLane(lane: AiPriority): Promise<void> {
  await loadPersisted();
  for (;;) {
    const at = laneReopensAt(lane);
    if (!at) return;
    await sleep(Math.min(at - Date.now() + 250, 60_000));
  }
}

export function reportSuccess(): void {
  if (state.level > 0) state.level--;
  state.gapMs = Math.max(BASE_GAP_MS, Math.round(state.gapMs * 0.85));
}

/** Milliseconds the provider asked us to wait, if it said so. */
export function parseRetryAfterMs(err: unknown): number | null {
  const e = err as { headers?: unknown; message?: unknown } | null;
  const header = (name: string): string | null => {
    const h = e?.headers;
    if (!h) return null;
    if (typeof (h as Headers).get === "function") return (h as Headers).get(name);
    const v = (h as Record<string, unknown>)[name];
    return typeof v === "string" ? v : null;
  };

  const ms = header("retry-after-ms");
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const ra = header("retry-after");
  if (ra) {
    if (Number.isFinite(Number(ra))) return Number(ra) * 1000;
    const date = Date.parse(ra);
    if (Number.isFinite(date)) return Math.max(0, date - Date.now());
  }

  const message = typeof e?.message === "string" ? e.message : String(err ?? "");
  // Google: "retryDelay": "37s"  /  "Please retry in 37.2s"
  const m =
    message.match(/retryDelay\\?"?\s*[:=]\s*\\?"?(\d+(?:\.\d+)?)s/i) ??
    message.match(/retry (?:in|after) (\d+(?:\.\d+)?)\s*s/i);
  return m ? Math.round(Number(m[1]) * 1000) : null;
}

/** Google free-tier daily quota (resets at midnight Pacific). */
export function isDailyQuotaError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err ?? "");
  return /PerDay|per[\s_-]?day|daily/i.test(message);
}

/** ms until the next midnight in America/Los_Angeles (+1 min margin). */
export function msUntilPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour12: false,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(now);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0) % 24;
  const elapsed = (get("hour") * 3600 + get("minute") * 60 + get("second")) * 1000;
  return 86_400_000 - elapsed + 60_000;
}

/** Record a 429 and pause the background lanes. Returns the pause length. */
export function report429(err: unknown, provider?: string): number {
  const now = Date.now();
  const hinted = parseRetryAfterMs(err) ?? 0;
  const daily = provider === "gemini" && isDailyQuotaError(err);
  let pause: number;

  if (state.pausedUntil > now) {
    // Already paused: no escalation (see the header). Only an explicit, longer
    // wait from the provider may extend the pause.
    pause = daily ? Math.max(hinted, msUntilPacificMidnight()) : hinted;
    if (now + pause <= state.pausedUntil) return state.pausedUntil - now;
  } else {
    const backoff = BACKOFF_MS[Math.min(state.level, BACKOFF_MS.length - 1)]!;
    pause = Math.max(backoff, hinted);
    if (daily) pause = Math.max(pause, msUntilPacificMidnight());
    state.level = Math.min(state.level + 1, BACKOFF_MS.length - 1);
    state.gapMs = Math.min(MAX_GAP_MS, Math.max(2_000, state.gapMs * 2));
  }
  state.pausedUntil = Math.max(state.pausedUntil, now + pause);
  // Old mail waits twice as long as new mail before it may try again — except
  // after a daily quota: the quota resets at a fixed time for both lanes, and
  // doubling a ~15h pause kept the backlog stopped for 30h (2026-11-10).
  state.backfillResumeAt = Math.max(state.backfillResumeAt, now + (daily ? pause : pause * 2));
  persist();
  scheduleResume();
  logToFile(
    "warn",
    `[ai] ${provider ?? "provider"} rate-limited (429): new mail paused ${Math.round(pause / 1000)}s, ` +
      `backlog until ${new Date(state.backfillResumeAt).toISOString()}`,
  );
  return pause;
}

/** Called when the backlog lane reopens after a pause — used to restart backfills. */
export function onBacklogResume(cb: () => void): () => void {
  resumeListeners.add(cb);
  return () => resumeListeners.delete(cb);
}

/**
 * Declare which provider|credentials|model the limiter is serving. A change
 * drops the pause — the new one has its own quota. The id is stored hashed
 * (it contains the API key) so a restart can tell a stale pause from its own.
 */
export function setRateLimitOwner(id: string): void {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  const next = (h >>> 0).toString(36);
  if (owner !== null && owner !== next) resetRateLimit();
  owner = next;
}

/** Forget every pause (provider/key/model changed — the new one has its own quota). */
export function resetRateLimit(): void {
  const wasPaused = state.backfillResumeAt > Date.now();
  state = fresh();
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  if (wasPaused) {
    persist();
    for (const cb of resumeListeners) {
      try {
        cb();
      } catch {
        /* ignore */
      }
    }
  }
}

/** Current pause, for the Settings status line. */
export function getRateLimitStatus(): { pausedUntil: number; backfillResumeAt: number } | null {
  const now = Date.now();
  if (state.backfillResumeAt <= now) return null;
  return { pausedUntil: state.pausedUntil, backfillResumeAt: state.backfillResumeAt };
}

/** Test hook. */
export function __resetForTests(): void {
  state = fresh();
  owner = null;
  requestCap = null;
  tokenCap = null;
  recentStarts = [];
  loaded = null;
  if (resumeTimer) clearTimeout(resumeTimer);
  resumeTimer = null;
  resumeListeners.clear();
}
