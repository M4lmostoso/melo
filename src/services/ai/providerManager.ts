import { getSetting, getSecureSetting } from "@/services/db/settings";
import { AiError } from "./errors";
import type { AiCompletionRequest, AiProvider, AiProviderClient } from "./types";
import { API_KEY_SETTINGS, MODEL_SETTINGS, resolveModelId } from "./types";
import { createClaudeProvider, clearClaudeProvider } from "./providers/claudeProvider";
import { createOpenAIProvider, clearOpenAIProvider } from "./providers/openaiProvider";
import { createGeminiProvider, clearGeminiProvider } from "./providers/geminiProvider";
import { createOllamaProvider, clearOllamaProvider } from "./providers/ollamaProvider";
import { createCopilotProvider, clearCopilotProvider } from "./providers/copilotProvider";
import { createKiloProvider, clearKiloProvider } from "./providers/kiloProvider";
import { createGroqProvider, clearGroqProvider } from "./providers/groqProvider";
import { createNvidiaProvider, clearNvidiaProvider } from "./providers/nvidiaProvider";
import { acquire, report429, reportSuccess, setRateLimitOwner, setRequestCap, type CapSlot } from "./rateLimiter";
import { isRateLimitError } from "./errors";


const cachedClients = new Map<string, AiProviderClient>();

const PROVIDERS: ReadonlySet<string> = new Set<AiProvider>([
  "claude", "openai", "gemini", "ollama", "copilot", "kilo", "groq", "nvidia",
]);

/**
 * Providers with a published per-minute quota: calls are capped BELOW it so the
 * background lanes never earn a 429 and clicks keep some headroom. NVIDIA NIM's
 * developer tier allows 40/min per key, Groq's free plan 30/min per model.
 */
export const RPM_CAPS: Partial<Record<AiProvider, number>> = { nvidia: 30, groq: 24 };

/**
 * Token-per-minute caps, below the provider's quota. Groq's free plan allows 8K
 * tokens/min per model and that is what binds (measured 2026-11-13: one 20-thread
 * categorisation = 3.5K tokens on Qwen 3.8 27B, 4.8K on GPT-OSS 120B).
 */
export const TPM_CAPS: Partial<Record<AiProvider, number>> = { groq: 6_800 };

/**
 * Expected size of a call before it is sent: input at ~3.5 chars/token (measured
 * on Melo's Italian mail: 11.5K chars → 3.1K tokens) plus a typical answer.
 * Corrected with the real usage when the provider reports it.
 */
function estimateTokens(req: AiCompletionRequest): number {
  const chars =
    req.systemPrompt.length +
    req.userContent.length +
    (req.conversationHistory ?? []).reduce((n, m) => n + m.content.length, 0);
  return Math.ceil(chars / 3.5) + 400;
}

/**
 * Every completion goes through the rate limiter: background lanes wait for a
 * slot (or fail fast while paused), and a 429 pauses them. testConnection is
 * left alone — it is an explicit user check.
 */
function withRateLimit(name: AiProvider, ownerKey: string, client: AiProviderClient): AiProviderClient {
  // A different provider/key/main model has its own quota: this drops the old pause.
  setRateLimitOwner(`${name}|${ownerKey}`);
  setRequestCap(RPM_CAPS[name] ?? null, TPM_CAPS[name] ?? null);

  return {
    async complete(req) {
      const slot: CapSlot = { at: 0, tokens: 0 };
      await acquire(req.priority ?? "interactive", estimateTokens(req), slot);
      try {
        const out = await client.complete({
          ...req,
          onUsage: (total) => {
            slot.tokens = total;
            req.onUsage?.(total);
          },
        });
        reportSuccess();
        return out;
      } catch (err) {
        if (isRateLimitError(err)) report429(err, name);
        throw err;
      }
    },
    testConnection: () => client.testConnection(),
  };
}

export async function getActiveProviderName(): Promise<AiProvider> {
  const setting = await getSetting("ai_provider");
  return setting && PROVIDERS.has(setting) ? (setting as AiProvider) : "claude";
}

/** What a call is for: `composer` may run on its own provider/model (see COMPOSER_*_SETTING). */
export type AiPurpose = "default" | "composer";

/**
 * Optional composer provider and model ("" = same as the main one). Writing
 * quality and background cost pull in opposite directions: on Groq (2026-11-13)
 * Qwen 3.8 27B categorised 20 threads in 1.1 s for 3.5K tokens but invented
 * commitments in reply drafts and flattened them into one paragraph, while
 * GPT-OSS 120B wrote faithful drafts at 5x the tokens. The composer may sit on
 * another provider altogether (e.g. NVIDIA Nemotron while Groq does the rest).
 */
export const COMPOSER_PROVIDER_SETTING = "ai_composer_provider";
export const COMPOSER_MODEL_SETTING = "ai_composer_model";

/** Provider credentials as stored, or null when the provider is not set up. */
async function providerCredentials(name: AiProvider): Promise<{ apiKey: string } | { serverUrl: string } | null> {
  if (name === "ollama") {
    const serverUrl = await getSetting("ollama_server_url");
    return serverUrl ? { serverUrl } : null;
  }
  const apiKey = await getSecureSetting(API_KEY_SETTINGS[name]);
  return apiKey ? { apiKey } : null;
}

/** The model configured as `name`'s main model. */
async function mainModelOf(name: AiProvider): Promise<string> {
  if (name === "ollama") return (await getSetting("ollama_model")) ?? "llama3.3";
  return resolveModelId(name, await getSetting(MODEL_SETTINGS[name]));
}

/** Providers that have credentials, in settings order — the composer can pick among these. */
export async function getConfiguredProviders(): Promise<AiProvider[]> {
  const out: AiProvider[] = [];
  for (const name of PROVIDERS) if (await providerCredentials(name as AiProvider)) out.push(name as AiProvider);
  return out;
}

function createClient(name: AiProvider, creds: { apiKey: string } | { serverUrl: string }, model: string): AiProviderClient {
  if (name === "ollama") return createOllamaProvider((creds as { serverUrl: string }).serverUrl, model);
  const { apiKey } = creds as { apiKey: string };
  switch (name) {
    case "claude":
      return createClaudeProvider(apiKey, model);
    case "openai":
      return createOpenAIProvider(apiKey, model);
    case "gemini":
      return createGeminiProvider(apiKey, model);
    case "copilot":
      return createCopilotProvider(apiKey, model);
    case "kilo":
      return createKiloProvider(apiKey, model);
    case "groq":
      return createGroqProvider(apiKey, model);
    case "nvidia":
      return createNvidiaProvider(apiKey, model);
  }
}

const credsKey = (creds: { apiKey: string } | { serverUrl: string }) =>
  "apiKey" in creds ? creds.apiKey : creds.serverUrl;

/**
 * The client for a call. `purpose: "composer"` honours the composer provider and
 * model when set:
 * - same provider as the main one → its own model, SAME limiter state (the owner
 *   is provider + credentials + MAIN model, so alternating never resets a pause);
 * - another provider → kept OUT of the limiter entirely: composer calls are clicks
 *   (`interactive`, never held), and that provider's 429s must not pause the
 *   background lanes of the main one, nor may its owner/caps replace them.
 * A composer provider without credentials falls back to the main one (logged).
 */
export async function getActiveProvider(purpose: AiPurpose = "default"): Promise<AiProviderClient> {
  const mainName = await getActiveProviderName();

  if (purpose === "composer") {
    const wanted = ((await getSetting(COMPOSER_PROVIDER_SETTING)) ?? "").trim();
    const composerModel = ((await getSetting(COMPOSER_MODEL_SETTING)) ?? "").trim();
    const name = wanted && PROVIDERS.has(wanted) ? (wanted as AiProvider) : mainName;
    if (name !== mainName) {
      const creds = await providerCredentials(name);
      if (creds) {
        const model = composerModel || (await mainModelOf(name));
        const slot = `composer|${name}|${credsKey(creds)}|${model}`;
        let client = cachedClients.get(slot);
        if (!client) {
          client = outsideLimiter(createClient(name, creds, model));
          cachedClients.set(slot, client);
        }
        return client;
      }
      console.warn(`[ai] composer provider ${name} has no credentials — using ${mainName}`);
    } else if (composerModel) {
      return mainClient(mainName, composerModel);
    }
  }

  return mainClient(mainName);
}

/** Main provider's client, optionally on another of its models (shares the limiter). */
async function mainClient(name: AiProvider, modelOverride?: string): Promise<AiProviderClient> {
  // Ollama works with the default local URL even when none is stored.
  const creds =
    (await providerCredentials(name)) ?? (name === "ollama" ? { serverUrl: "http://localhost:11434" } : null);
  if (!creds) throw new AiError("NOT_CONFIGURED", `${name} API key not configured`);
  const mainModel = await mainModelOf(name);
  const model = modelOverride || mainModel;
  const key = credsKey(creds);
  return cachedClient(name, `${key}|${model}`, `${key}|${mainModel}`, () => createClient(name, creds, model));
}

/**
 * A client outside the shared limiter (composer on another provider): no lane,
 * no pause, no cap — the user clicked and gets the provider's answer or error.
 */
function outsideLimiter(client: AiProviderClient): AiProviderClient {
  return {
    complete: (req) => client.complete(req),
    testConnection: () => client.testConnection(),
  };
}

/** One wrapped client per provider|credentials|model (main and composer may both be live). */
function cachedClient(
  name: AiProvider,
  cacheKey: string,
  ownerKey: string,
  create: () => AiProviderClient,
): AiProviderClient {
  const slot = `${name}|${cacheKey}`;
  const hit = cachedClients.get(slot);
  if (hit) {
    // Re-assert the owner/caps: another provider may have been active in between.
    setRateLimitOwner(`${name}|${ownerKey}`);
    setRequestCap(RPM_CAPS[name] ?? null, TPM_CAPS[name] ?? null);
    return hit;
  }
  // Other providers' main clients are stale now; keep this provider's pair and
  // any composer client on another provider (it never touches the limiter).
  for (const k of cachedClients.keys()) if (!k.startsWith(`${name}|`) && !k.startsWith("composer|")) cachedClients.delete(k);
  const client = withRateLimit(name, ownerKey, create());
  cachedClients.set(slot, client);
  return client;
}

export async function isAiAvailable(): Promise<boolean> {
  try {
    const enabled = await getSetting("ai_enabled");
    if (enabled === "false") return false;
    const providerName = await getActiveProviderName();

    if (providerName === "ollama") {
      const serverUrl = await getSetting("ollama_server_url");
      return !!serverUrl;
    }

    const keySetting = API_KEY_SETTINGS[providerName];
    const key = await getSecureSetting(keySetting);
    return !!key;
  } catch {
    return false;
  }
}

export function clearProviderClients(): void {
  cachedClients.clear();
  clearClaudeProvider();
  clearOpenAIProvider();
  clearGeminiProvider();
  clearOllamaProvider();
  clearCopilotProvider();
  clearKiloProvider();
  clearGroqProvider();
  clearNvidiaProvider();
}
