import type { AiProviderClient } from "../types";
import { NVIDIA_BASE_URL } from "../modelCatalog";
import { createGatewayProviderFactory } from "./openAiGateway";

/**
 * NVIDIA NIM API catalog (https://build.nvidia.com) — OpenAI-compatible chat
 * completions at integrate.api.nvidia.com, key `nvapi-…`. Hosted models are free
 * on the developer tier and rate-limited per key (~40 requests/min), which the
 * provider manager enforces up-front (RPM_CAPS) instead of waiting for a 429.
 * Like Kilo it answers CORS preflights without Access-Control-Allow-Origin:
 * `openAiGateway` goes through the Tauri HTTP fetch.
 */
export { NVIDIA_BASE_URL };

const gateway = createGatewayProviderFactory({ name: "NVIDIA", baseURL: NVIDIA_BASE_URL });

export function createNvidiaProvider(apiKey: string, model: string): AiProviderClient {
  return gateway.create(apiKey, model);
}

export function clearNvidiaProvider(): void {
  gateway.clear();
}
