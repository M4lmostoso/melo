import { getSetting, getSecureSetting } from "@/services/db/settings";
import { AiError } from "./errors";
import type { AiProvider, AiProviderClient } from "./types";
import { API_KEY_SETTINGS, MODEL_SETTINGS, resolveModelId } from "./types";
import { createClaudeProvider, clearClaudeProvider } from "./providers/claudeProvider";
import { createOpenAIProvider, clearOpenAIProvider } from "./providers/openaiProvider";
import { createGeminiProvider, clearGeminiProvider } from "./providers/geminiProvider";
import { createOllamaProvider, clearOllamaProvider } from "./providers/ollamaProvider";
import { createCopilotProvider, clearCopilotProvider } from "./providers/copilotProvider";
import { createKiloProvider, clearKiloProvider } from "./providers/kiloProvider";
import { acquire, report429, reportSuccess, resetRateLimit } from "./rateLimiter";
import { isRateLimitError } from "./errors";


let cachedProvider: { name: AiProvider; key: string; client: AiProviderClient } | null = null;
/** provider|credentials|model the rate limiter's current pause belongs to. */
let limiterOwner: string | null = null;

/**
 * Every completion goes through the rate limiter: background lanes wait for a
 * slot (or fail fast while paused), and a 429 pauses them. testConnection is
 * left alone — it is an explicit user check.
 */
function withRateLimit(name: AiProvider, key: string, client: AiProviderClient): AiProviderClient {
  const owner = `${name}|${key}`;
  // A different provider/key/model has its own quota: drop the old pause.
  if (limiterOwner !== null && limiterOwner !== owner) resetRateLimit();
  limiterOwner = owner;

  return {
    async complete(req) {
      await acquire(req.priority ?? "interactive");
      try {
        const out = await client.complete(req);
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
  if (setting === "openai" || setting === "gemini" || setting === "ollama" || setting === "copilot" || setting === "kilo") return setting;
  return "claude";
}

export async function getActiveProvider(): Promise<AiProviderClient> {
  const providerName = await getActiveProviderName();

  if (providerName === "ollama") {
    const serverUrl = (await getSetting("ollama_server_url")) ?? "http://localhost:11434";
    const model = (await getSetting("ollama_model")) ?? "llama3.3";
    const cacheKey = `${serverUrl}|${model}`;

    if (cachedProvider && cachedProvider.name === "ollama" && cachedProvider.key === cacheKey) {
      return cachedProvider.client;
    }

    const client = withRateLimit("ollama", cacheKey, createOllamaProvider(serverUrl, model));
    cachedProvider = { name: "ollama", key: cacheKey, client };
    return client;
  }

  const keySetting = API_KEY_SETTINGS[providerName];
  const apiKey = await getSecureSetting(keySetting);

  if (!apiKey) {
    throw new AiError("NOT_CONFIGURED", `${providerName} API key not configured`);
  }

  const model = resolveModelId(providerName, await getSetting(MODEL_SETTINGS[providerName]));
  const cacheKey = `${apiKey}|${model}`;

  if (cachedProvider && cachedProvider.name === providerName && cachedProvider.key === cacheKey) {
    return cachedProvider.client;
  }

  let client: AiProviderClient;
  switch (providerName) {
    case "claude":
      client = createClaudeProvider(apiKey, model);
      break;
    case "openai":
      client = createOpenAIProvider(apiKey, model);
      break;
    case "gemini":
      client = createGeminiProvider(apiKey, model);
      break;
    case "copilot":
      client = createCopilotProvider(apiKey, model);
      break;
    case "kilo":
      client = createKiloProvider(apiKey, model);
      break;
  }

  client = withRateLimit(providerName, cacheKey, client);
  cachedProvider = { name: providerName, key: cacheKey, client };
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
  cachedProvider = null;
  clearClaudeProvider();
  clearOpenAIProvider();
  clearGeminiProvider();
  clearOllamaProvider();
  clearCopilotProvider();
  clearKiloProvider();
}
