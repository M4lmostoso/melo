import type { AiProviderClient } from "../types";
import { OPENROUTER_BASE_URL } from "../modelCatalog";
import { createGatewayProviderFactory } from "./openAiGateway";

/**
 * OpenRouter — OpenAI-compatible router (https://openrouter.ai/docs).
 * Free models end in `:free`; `openrouter/free` routes to whichever is up.
 */
export { OPENROUTER_BASE_URL };

const gateway = createGatewayProviderFactory({
  name: "OpenRouter",
  baseURL: OPENROUTER_BASE_URL,
  // Optional app attribution (shown in the user's OpenRouter activity page).
  defaultHeaders: { "HTTP-Referer": "https://github.com/M4lmostoso/melo", "X-Title": "Melo" },
});

export function createOpenRouterProvider(apiKey: string, model: string): AiProviderClient {
  return gateway.create(apiKey, model);
}

export function clearOpenRouterProvider(): void {
  gateway.clear();
}
