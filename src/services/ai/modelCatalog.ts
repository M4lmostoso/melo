/**
 * Live model catalogs for every AI provider, so the model list in Settings and
 * the configured model follow the providers instead of a hardcoded list that
 * rots (gemini-3-flash / gemini-3-pro vanished from Google's catalog while Melo
 * still defaulted to them; Ollama dropped its free cloud models).
 *
 * - Each provider's own "list models" endpoint is queried with the stored
 *   credentials and cached in `settings` (`ai_model_catalog_<provider>`) for 24h.
 * - `healActiveModel()` checks the configured model against a FRESH catalog and,
 *   when the provider no longer serves it, switches to the best available one.
 * - The curated `PROVIDER_MODELS` stay as preferred picks and as the offline
 *   fallback when a catalog can't be fetched.
 *
 * All calls go through the Tauri HTTP plugin: several gateways (Kilo) send no
 * CORS headers, and this keeps every provider on one code path.
 */
import { fetch } from "@tauri-apps/plugin-http";
import { getSetting, setSetting, getSecureSetting } from "@/services/db/settings";
import { logToFile } from "@/utils/fileLog";
import {
  API_KEY_SETTINGS,
  DEFAULT_MODELS,
  MODEL_SETTINGS,
  PROVIDER_MODELS,
  resolveModelId,
  type AiProvider,
  type ModelOption,
} from "./types";

export interface CatalogModel extends ModelOption {
  /** Zero-cost model (Kilo free tier, Ollama local). */
  free?: boolean;
}

export interface ModelCatalog {
  provider: AiProvider;
  models: CatalogModel[];
  /** epoch ms of the successful fetch; 0 when this is the built-in fallback. */
  fetchedAt: number;
  /** true when `models` is the curated list because no live catalog is available. */
  fallback: boolean;
}

export const CATALOG_TTL_MS = 24 * 60 * 60 * 1000;
export const KILO_BASE_URL = "https://api.kilo.ai/api/gateway";
export const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
export const NVIDIA_BASE_URL = "https://integrate.api.nvidia.com/v1";

const cacheKey = (p: AiProvider) => `ai_model_catalog_${p}`;

export function modelSettingKey(provider: AiProvider): string {
  return provider === "ollama" ? "ollama_model" : MODEL_SETTINGS[provider];
}

// ---------------------------------------------------------------------------
// Fetchers — one per provider, each returns the chat-capable models only.
// ---------------------------------------------------------------------------

interface Credentials {
  apiKey?: string | null;
  serverUrl?: string | null;
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { method: "GET", headers });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.json();
}

function requireKey(creds: Credentials, provider: AiProvider): string {
  if (!creds.apiKey) throw new Error(`${provider}: no API key`);
  return creds.apiKey;
}

/** Version-aware descending sort: gemini-3.8-flash before gemini-3.6-flash. */
const byIdDesc = (a: CatalogModel, b: CatalogModel) =>
  b.id.localeCompare(a.id, undefined, { numeric: true });

async function fetchClaude(creds: Credentials): Promise<CatalogModel[]> {
  const body = (await getJson("https://api.anthropic.com/v1/models?limit=1000", {
    "x-api-key": requireKey(creds, "claude"),
    "anthropic-version": "2023-06-01",
  })) as { data?: { id: string; display_name?: string; created_at?: string }[] };
  return (body.data ?? [])
    .sort((a, b) => (b.created_at ?? "").localeCompare(a.created_at ?? ""))
    .map((m) => ({ id: m.id, label: m.display_name ?? m.id }));
}

const OPENAI_NON_CHAT =
  /(audio|realtime|tts|transcribe|image|search|embedding|moderation|instruct|dall-e|whisper|computer-use|codex|sora)/;

async function fetchOpenAI(creds: Credentials): Promise<CatalogModel[]> {
  const body = (await getJson("https://api.openai.com/v1/models", {
    Authorization: `Bearer ${requireKey(creds, "openai")}`,
  })) as { data?: { id: string; created?: number }[] };
  return (body.data ?? [])
    .filter((m) => /^(gpt-|o\d|chatgpt-)/.test(m.id) && !OPENAI_NON_CHAT.test(m.id))
    .sort((a, b) => (b.created ?? 0) - (a.created ?? 0))
    .map((m) => ({ id: m.id, label: m.id }));
}

const GOOGLE_NON_CHAT = /(tts|image|live|embedding|transcribe|robotics|audio|banana|lyria|omni|veo|imagen)/;

async function fetchGemini(creds: Credentials): Promise<CatalogModel[]> {
  const key = requireKey(creds, "gemini");
  const out: CatalogModel[] = [];
  let pageToken = "";
  for (let page = 0; page < 10; page++) {
    const url =
      "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000" +
      (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
    const body = (await getJson(url, { "x-goog-api-key": key })) as {
      models?: { name: string; displayName?: string; supportedGenerationMethods?: string[] }[];
      nextPageToken?: string;
    };
    for (const m of body.models ?? []) {
      const id = m.name.replace(/^models\//, "");
      if (!/^(gemini|gemma)-/.test(id) || GOOGLE_NON_CHAT.test(id)) continue;
      if (m.supportedGenerationMethods && !m.supportedGenerationMethods.includes("generateContent")) continue;
      out.push({ id, label: m.displayName ?? id });
    }
    if (!body.nextPageToken) break;
    pageToken = body.nextPageToken;
  }
  return out.sort(byIdDesc);
}

async function fetchCopilot(creds: Credentials): Promise<CatalogModel[]> {
  const body = (await getJson("https://models.github.ai/catalog/models", {
    Authorization: `Bearer ${requireKey(creds, "copilot")}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  })) as { id: string; name?: string; supported_output_modalities?: string[] }[];
  if (!Array.isArray(body)) throw new Error("models.github.ai: unexpected catalog shape");
  return body
    .filter((m) => !m.supported_output_modalities || m.supported_output_modalities.includes("text"))
    .filter((m) => !/embedding/.test(m.id))
    .map((m) => ({ id: m.id, label: m.name ?? m.id }));
}

interface GatewayEntry {
  id: string;
  name?: string;
  pricing?: { prompt?: string | number; completion?: string | number };
  architecture?: { output_modalities?: string[] };
}

function isGatewayFree(m: GatewayEntry): boolean {
  if (m.id.endsWith(":free") || m.id.endsWith("/free")) return true;
  const zero = (v: string | number | undefined) => v !== undefined && v !== "" && Number(v) === 0;
  return !!m.pricing && zero(m.pricing.prompt) && zero(m.pricing.completion);
}

/**
 * OpenRouter-style `/models` (Kilo) — public, works without a key.
 * Text-output models only (OpenRouter lists zero-priced music models like Lyria
 * that would pass as "free"). Free models first.
 */
async function fetchGatewayModels(baseUrl: string): Promise<CatalogModel[]> {
  const body = (await getJson(`${baseUrl}/models`)) as { data?: GatewayEntry[] } | GatewayEntry[];
  const entries = Array.isArray(body) ? body : (body.data ?? []);
  return entries
    .filter((m) => typeof m?.id === "string" && m.id.length > 0)
    .filter((m) => !m.architecture?.output_modalities || m.architecture.output_modalities.includes("text"))
    .map((m) => ({ id: m.id, label: m.name ?? m.id, free: isGatewayFree(m) }))
    .sort((a, b) => Number(b.free) - Number(a.free) || a.id.localeCompare(b.id));
}

/**
 * NVIDIA NIM `/models` — public, OpenAI-shaped (`{ data: [{ id, owned_by }] }`,
 * no names, no pricing, no modalities). It lists embedders, rerankers, safety
 * guards, parsers and detectors next to the chat models; none of those can
 * answer a chat completion, so they are dropped by id. Everything is free on
 * the developer tier.
 */
const NVIDIA_NON_CHAT = /embed|retriever|rerank|guard|safety|reward|parse|nvclip|detector|deplot|calibration/i;

export async function fetchNvidiaModels(): Promise<CatalogModel[]> {
  const body = (await getJson(`${NVIDIA_BASE_URL}/models`)) as { data?: { id?: unknown }[] };
  return (body.data ?? [])
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !NVIDIA_NON_CHAT.test(id))
    .map((id) => ({ id, label: id, free: true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Groq `/models` — needs the key, OpenAI-shaped plus `active`/`context_window`.
 * Speech (whisper, orpheus) and classifier (prompt-guard, safeguard) models sit
 * next to the chat ones and are dropped by id, and so is ALLaM (Arabic-only, it
 * rejects Melo's max_tokens with a 400). All usable on the free plan.
 */
const GROQ_NON_CHAT = /whisper|orpheus|tts|guard|safeguard|embed|allam/i;

async function fetchGroqModels(creds: Credentials): Promise<CatalogModel[]> {
  const body = (await getJson(`${GROQ_BASE_URL}/models`, {
    Authorization: `Bearer ${requireKey(creds, "groq")}`,
  })) as { data?: { id?: unknown; active?: boolean }[] };
  return (body.data ?? [])
    .filter((m) => m?.active !== false)
    .map((m) => m?.id)
    .filter((id): id is string => typeof id === "string" && id.length > 0 && !GROQ_NON_CHAT.test(id))
    .map((id) => ({ id, label: id, free: true }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

async function fetchOllama(creds: Credentials): Promise<CatalogModel[]> {
  const base = (creds.serverUrl ?? "http://localhost:11434").replace(/\/+$/, "");
  const body = (await getJson(`${base}/api/tags`)) as { models?: { name: string }[] } | { name: string }[];
  const models = Array.isArray(body) ? body : (body.models ?? []);
  return models.map((m) => ({ id: m.name, label: m.name, free: true }));
}

export async function fetchProviderModels(provider: AiProvider, creds: Credentials): Promise<CatalogModel[]> {
  switch (provider) {
    case "claude":
      return fetchClaude(creds);
    case "openai":
      return fetchOpenAI(creds);
    case "gemini":
      return fetchGemini(creds);
    case "copilot":
      return fetchCopilot(creds);
    case "kilo":
      return fetchGatewayModels(KILO_BASE_URL);
    case "groq":
      return fetchGroqModels(creds);
    case "nvidia":
      return fetchNvidiaModels();
    case "ollama":
      return fetchOllama(creds);
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

async function storedCredentials(provider: AiProvider): Promise<Credentials> {
  if (provider === "ollama") return { serverUrl: await getSetting("ollama_server_url") };
  return { apiKey: await getSecureSetting(API_KEY_SETTINGS[provider]) };
}

function builtInCatalog(provider: AiProvider): ModelCatalog {
  const models =
    provider === "ollama"
      ? [{ id: DEFAULT_MODELS.ollama, label: DEFAULT_MODELS.ollama }]
      : PROVIDER_MODELS[provider].map((m) => ({ ...m, free: provider === "kilo" || provider === "groq" || provider === "nvidia" }));
  return { provider, models, fetchedAt: 0, fallback: true };
}

async function readCache(provider: AiProvider): Promise<ModelCatalog | null> {
  try {
    const raw = await getSetting(cacheKey(provider));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as ModelCatalog;
    if (!Array.isArray(parsed.models) || parsed.models.length === 0) return null;
    return { ...parsed, provider, fallback: false };
  } catch {
    return null;
  }
}

/**
 * The provider's model catalog: cached if younger than 24h, otherwise fetched.
 * Never throws — on any failure it returns the last good cache, then the
 * built-in list (`fallback: true`).
 *
 * `creds` lets the Settings UI list models for a key that isn't saved yet.
 */
export async function getModelCatalog(
  provider: AiProvider,
  opts: { force?: boolean; creds?: Credentials } = {},
): Promise<ModelCatalog> {
  const cached = await readCache(provider);
  if (!opts.force && !opts.creds && cached && Date.now() - cached.fetchedAt < CATALOG_TTL_MS) return cached;

  try {
    const models = await fetchProviderModels(provider, opts.creds ?? (await storedCredentials(provider)));
    if (models.length === 0) throw new Error(`${provider}: empty catalog`);
    const catalog: ModelCatalog = { provider, models, fetchedAt: Date.now(), fallback: false };
    await setSetting(cacheKey(provider), JSON.stringify({ models, fetchedAt: catalog.fetchedAt }));
    return catalog;
  } catch (err) {
    console.warn(`[models] ${provider} catalog unavailable:`, err);
    return cached ?? builtInCatalog(provider);
  }
}

// ---------------------------------------------------------------------------
// Self-healing of the configured model
// ---------------------------------------------------------------------------

/** Patterns tried in order when none of the curated picks is still served. */
const PREFERENCES: Record<AiProvider, RegExp[]> = {
  claude: [/haiku/, /sonnet/],
  openai: [/^gpt-[\d.]+-mini$/, /mini/],
  gemini: [/^gemini-[\d.]+-flash$/, /^gemini-[\d.]+-flash/],
  copilot: [/mini/],
  kilo: [/^kilo-auto\/free$/, /:free$/],
  groq: [/qwen/, /gpt-oss-120b/, /gpt-oss/],
  nvidia: [/nemotron-3\.5/, /nemotron/, /gemma-4/],
  ollama: [],
};

/** Best replacement model in `catalog`: curated pick first, then a provider heuristic. */
export function pickReplacement(provider: AiProvider, catalog: CatalogModel[]): string | null {
  if (catalog.length === 0) return null;
  const ids = new Set(catalog.map((m) => m.id));
  const curated = provider === "ollama" ? [] : PROVIDER_MODELS[provider].map((m) => m.id);
  const pick = curated.find((id) => ids.has(id));
  if (pick) return pick;
  for (const re of PREFERENCES[provider]) {
    const hit = catalog.find((m) => re.test(m.id));
    if (hit) return hit.id;
  }
  return catalog[0]!.id;
}

export interface HealResult {
  provider: AiProvider;
  from: string;
  to: string;
}

/**
 * If the active provider's configured model is no longer served, switch the
 * setting to the best available model. Two conditions, both required:
 *  1. the model is missing from a FRESHLY fetched, non-empty catalog (a fallback
 *     or stale list never overrides the user's choice), and
 *  2. a real test call with it fails — catalogs are filtered (OpenAI drops
 *     codex/audio ids, Google drops live/tts…), so absence alone is not proof.
 */
export async function healActiveModel(opts: { force?: boolean } = {}): Promise<HealResult | null> {
  const { getActiveProviderName, getActiveProvider, clearProviderClients } = await import("./providerManager");
  const provider = await getActiveProviderName();
  const catalog = await getModelCatalog(provider, { force: opts.force });
  if (catalog.fallback || Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) return null;

  const key = modelSettingKey(provider);
  const stored = await getSetting(key);
  const current = provider === "ollama" ? (stored ?? DEFAULT_MODELS.ollama) : resolveModelId(provider, stored);
  if (catalog.models.some((m) => m.id === current)) {
    // A retired id silently remapped by resolveModelId: persist the new id.
    if (stored && stored !== current) await setSetting(key, current);
    return null;
  }

  try {
    if (await (await getActiveProvider()).testConnection()) return null;
  } catch {
    /* not configured / unreachable — fall through to the switch */
  }

  const to = pickReplacement(provider, catalog.models);
  if (!to || to === current) return null;
  await setSetting(key, to);
  clearProviderClients();
  logToFile("warn", `[models] ${provider}: "${current}" is no longer offered — switched to "${to}"`);
  return { provider, from: current, to };
}

/** Background refresh of the active provider (startup + every few hours). */
export async function refreshActiveProviderModels(): Promise<void> {
  if ((await getSetting("ai_enabled")) === "false") return;
  await healActiveModel();
}

let checker: { stop(): void } | null = null;

/** Started from App.tsx with the other background checkers. */
export function startModelCatalogChecker(): void {
  if (checker) return;
  void import("@/services/backgroundCheckers").then(({ createBackgroundChecker }) => {
    if (checker) return;
    const c = createBackgroundChecker("model-catalog", refreshActiveProviderModels, 6 * 60 * 60 * 1000);
    checker = c;
    c.start();
  });
}

export function stopModelCatalogChecker(): void {
  checker?.stop();
  checker = null;
}
