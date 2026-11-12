export type AiProvider = "claude" | "openai" | "gemini" | "ollama" | "copilot" | "kilo" | "openrouter";

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
  openrouter: "openrouter/free",
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
  // OpenRouter free tier (`:free`, rate-limited). Like Kilo the list rotates;
  // `openrouter/free` routes to whatever free model is currently up.
  openrouter: [
    { id: "openrouter/free", label: "Free Models Router" },
    { id: "google/gemma-4-31b-it:free", label: "Gemma 4 31B (Free)" },
    { id: "nvidia/nemotron-3.5-super-vl:free", label: "Nemotron 3.5 Super (Free)" },
    { id: "nvidia/nemotron-3.5-lightning:free", label: "Nemotron 3.5 Lightning (Free)" },
    { id: "google/gemma-4-26b-a4b-it:free", label: "Gemma 4 26B A4B (Free)" },
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
  openrouter: "openrouter_api_key",
};

export const MODEL_SETTINGS: Record<Exclude<AiProvider, "ollama">, string> = {
  claude: "claude_model",
  openai: "openai_model",
  gemini: "gemini_model",
  copilot: "copilot_model",
  kilo: "kilo_model",
  openrouter: "openrouter_model",
};
