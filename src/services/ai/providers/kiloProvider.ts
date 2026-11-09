import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { KILO_BASE_URL } from "../modelCatalog";
import { createProviderFactory } from "../providerFactory";

/**
 * Kilo AI Gateway — OpenAI-compatible router (https://kilo.ai/docs/gateway).
 * Exposes free models (`kilo-auto/free`, `*:free`) alongside paid ones.
 *
 * The gateway answers CORS preflights without Access-Control-Allow-* headers,
 * so the webview's own fetch is blocked: route through the Tauri HTTP plugin
 * (same as Ollama), whose scope already allows https://*.
 */
export { KILO_BASE_URL };

const factory = createProviderFactory(
  (apiKey) =>
    new OpenAI({
      apiKey,
      baseURL: KILO_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch,
    }),
);

/** Free reasoning models may inline their chain of thought — keep only the answer. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function createKiloProvider(apiKey: string, model: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const history = (req.conversationHistory ?? []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));
      const response = await client.chat.completions.create({
        model,
        max_tokens: req.maxTokens ?? 1024,
        messages: [
          { role: "system", content: req.systemPrompt },
          ...history,
          { role: "user", content: req.userContent },
        ],
      });

      return stripThinking(response.choices[0]?.message?.content ?? "");
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.chat.completions.create({
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Say hi" }],
        });
        return true;
      } catch (err) {
        console.error("Kilo connection test failed:", err);
        return false;
      }
    },
  };
}

export function clearKiloProvider(): void {
  factory.clear();
}
