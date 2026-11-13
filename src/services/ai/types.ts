export type AiProvider = "claude" | "openai" | "gemini" | "ollama" | "copilot" | "kilo" | "groq" | "nvidia";

export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

/**
 * Rate-limit lane (see rateLimiter.ts): `interactive` = the user asked for it,
 * `auto` = the UI asked by itself when a thread opened (refused while paused),
 * `live` = mail that just arrived, `backfill` = old mail — slowed first.
 */
export type AiPriority = "interactive" | "auto" | "live" | "backfill";

export interface AiCompletionRequest {
  /** Defaults to "interactive". */
  priority?: AiPriority;
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  conversationHistory?: ConversationMessage[];
  /**
   * Called with the provider's reported `usage.total_tokens` (gateway providers),
   * so the rate limiter's token cap counts what the call really cost.
   */
  onUsage?: (totalTokens: number) => void;
}

export interface AiProviderClient {
  complete(req: AiCompletionRequest): Promise<string>;
  testConnection(): Promise<boolean>;
}

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  claude: "claude-haiku-4-5-20251001",
  openai: "gpt-5-mini",
  gemini: "gemini-3.6-flash",
  ollama: "llama3.3",
  copilot: "openai/gpt-4o-mini",
  kilo: "kilo-auto/free",
  groq: "qwen/qwen3.8-27b",
  nvidia: "nvidia/nemotron-3.5-super-vl-120b-a12b",
};

export interface ModelOption {
  id: string;
  label: string;
}

export const PROVIDER_MODELS: Record<Exclude<AiProvider, "ollama">, ModelOption[]> = {
  claude: [
    { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
    { id: "claude-fable-5", label: "Claude Fable 5" },
  ],
  openai: [
    { id: "gpt-5-mini", label: "GPT-5 Mini" },
    { id: "gpt-5", label: "GPT-5" },
  ],
  // Google AI Studio (Gemini API): Gemini + open Gemma models, same key.
  gemini: [
    { id: "gemini-3.6-flash", label: "Gemini 3.6 Flash" },
    { id: "gemini-3.5-flash-lite", label: "Gemini 3.5 Flash-Lite" },
    { id: "gemini-3.8-flash", label: "Gemini 3.8 Flash" },
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
    { id: "gemma-4-31b-it", label: "Gemma 4 31B" },
    { id: "gemma-4-26b-a4b-it", label: "Gemma 4 26B A4B" },
  ],
  copilot: [
    { id: "openai/gpt-4o-mini", label: "GPT-4o Mini (Low)" },
    { id: "openai/gpt-4.1-nano", label: "GPT-4.1 Nano (Low)" },
    { id: "openai/gpt-4.1-mini", label: "GPT-4.1 Mini (High)" },
    { id: "openai/gpt-4o", label: "GPT-4o (High)" },
    { id: "openai/gpt-4.1", label: "GPT-4.1 (High)" },
  ],
  // Free tier of the Kilo gateway. The `:free` catalog rotates; `kilo-auto/free`
  // routes to whatever free model is currently up, so it is the safe default.
  kilo: [
    { id: "kilo-auto/free", label: "Kilo Auto (Free)" },
    { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (Free)" },
    { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super (Free)" },
    { id: "nvidia/nemotron-3-ultra-550b-a55b:free", label: "Nemotron 3 Ultra (Free)" },
    { id: "openrouter/free", label: "OpenRouter Free Router" },
  ],
  // Groq (console.groq.com): free plan per model, 1K requests/day and 8K
  // tokens/min (confirmed by the x-ratelimit headers on 2026-11-13) — RPM_CAPS and
  // TPM_CAPS keep Melo below it. No Gemma; Qwen 3.8 27B is the same size class as
  // Gemma 4 31B and, not reasoning, spends 1/5 of GPT-OSS's tokens per call.
  // GPT-OSS 120B wrote the most faithful reply drafts. Llama 3.3 70B is in Groq's
  // public docs but not in a free account's catalog.
  groq: [
    { id: "qwen/qwen3.8-27b", label: "Qwen 3.8 27B" },
    { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B" },
    { id: "openai/gpt-oss-20b", label: "GPT-OSS 20B" },
  ],
  // NVIDIA NIM API catalog (build.nvidia.com): every hosted model is free on the
  // developer tier, rate-limited per key (~40 requests/min) — see RPM_CAPS in
  // providerManager. Ids carry no `:free` suffix. Being listed is no promise of
  // service: on 2026-11-13 NVIDIA's own Nemotrons answered in 0.6 s while Gemma 4,
  // DeepSeek, GPT-OSS and GLM were accepted and never served, and Gemma 3 /
  // Nemotron 3 Super answered 404 "not found for account". Default = what answered.
  nvidia: [
    { id: "nvidia/nemotron-3.5-super-vl-120b-a12b", label: "Nemotron 3.5 Super" },
    { id: "nvidia/nemotron-3.5-lightning-30b-a3b", label: "Nemotron 3.5 Lightning" },
    { id: "google/gemma-4-31b-it", label: "Gemma 4 31B" },
  ],
};

/**
 * Model ids that were valid once and are now gone from the provider's catalog.
 * A stored setting pointing at one of these would make every AI call fail, so
 * it is remapped on read (provider manager and settings UI).
 */
const RETIRED_MODELS: Partial<Record<AiProvider, Record<string, string>>> = {
  gemini: {
    "gemini-3-flash": "gemini-3.6-flash",
    "gemini-3-pro": "gemini-3.1-pro-preview",
    "gemini-3-pro-preview": "gemini-3.1-pro-preview",
    "gemini-3.1-flash-lite-preview": "gemini-3.5-flash-lite",
    "gemini-2.0-flash": "gemini-3.6-flash",
    "gemini-2.0-flash-lite": "gemini-3.5-flash-lite",
  },
};

export function resolveModelId(provider: AiProvider, model: string | null | undefined): string {
  if (!model) return DEFAULT_MODELS[provider];
  return RETIRED_MODELS[provider]?.[model] ?? model;
}

/** Secure-setting key holding each provider's API key (Ollama needs none). */
export const API_KEY_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_api_key",
  openai: "openai_api_key",
  gemini: "gemini_api_key",
  copilot: "copilot_api_key",
  kilo: "kilo_api_key",
  groq: "groq_api_key",
  nvidia: "nvidia_api_key",
};

export const MODEL_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_model",
  openai: "openai_model",
  gemini: "gemini_model",
  copilot: "copilot_model",
  kilo: "kilo_model",
  groq: "groq_model",
  nvidia: "nvidia_model",
};
