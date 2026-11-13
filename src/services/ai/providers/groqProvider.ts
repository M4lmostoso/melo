import type { AiProviderClient } from "../types";
import { GROQ_BASE_URL } from "../modelCatalog";
import { createGatewayProviderFactory } from "./openAiGateway";

/**
 * Groq (https://console.groq.com) — OpenAI-compatible chat completions, key
 * `gsk_…`. The free plan is limited per model (~30 requests/min, 1K/day, 8K
 * tokens/min on the chat models): the provider manager caps Melo below it
 * (RPM_CAPS) and a 429 still pauses the background lanes via the rate limiter.
 * Requests go through the Tauri HTTP fetch like every gateway in `openAiGateway`.
 */
export { GROQ_BASE_URL };

const gateway = createGatewayProviderFactory({ name: "Groq", baseURL: GROQ_BASE_URL });

export function createGroqProvider(apiKey: string, model: string): AiProviderClient {
  return gateway.create(apiKey, model);
}

export function clearGroqProvider(): void {
  gateway.clear();
}
