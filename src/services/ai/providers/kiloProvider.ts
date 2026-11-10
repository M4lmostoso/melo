import type { AiProviderClient } from "../types";
import { KILO_BASE_URL } from "../modelCatalog";
import { createGatewayProviderFactory } from "./openAiGateway";

/**
 * Kilo AI Gateway — OpenAI-compatible router (https://kilo.ai/docs/gateway).
 * Exposes free models (`kilo-auto/free`, `*:free`) alongside paid ones.
 * The gateway sends no CORS headers: `openAiGateway` uses the Tauri HTTP fetch.
 */
export { KILO_BASE_URL };

const gateway = createGatewayProviderFactory({ name: "Kilo", baseURL: KILO_BASE_URL });

export function createKiloProvider(apiKey: string, model: string): AiProviderClient {
  return gateway.create(apiKey, model);
}

export function clearKiloProvider(): void {
  gateway.clear();
}
