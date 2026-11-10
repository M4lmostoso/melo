import OpenAI from "openai";
import { fetch } from "@tauri-apps/plugin-http";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

/**
 * Shared client for OpenAI-compatible routers (Kilo, OpenRouter): same chat
 * completions API, different base URL.
 *
 * Requests go through the Tauri HTTP plugin, not the webview fetch: Kilo answers
 * CORS preflights without Access-Control-Allow-* headers, and the plugin also
 * keeps these hosts out of the webview CSP.
 */
export interface GatewayConfig {
  /** Name used in logs. */
  name: string;
  baseURL: string;
  /** Extra headers on every request (e.g. OpenRouter app attribution). */
  defaultHeaders?: Record<string, string>;
}

/** Free reasoning models may inline their chain of thought — keep only the answer. */
function stripThinking(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function createGatewayProviderFactory(config: GatewayConfig): {
  create: (apiKey: string, model: string) => AiProviderClient;
  clear: () => void;
} {
  const factory = createProviderFactory(
    (apiKey) =>
      new OpenAI({
        apiKey,
        baseURL: config.baseURL,
        dangerouslyAllowBrowser: true,
        fetch,
        ...(config.defaultHeaders ? { defaultHeaders: config.defaultHeaders } : {}),
      }),
  );

  const create = (apiKey: string, model: string): AiProviderClient => {
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
          console.error(`${config.name} connection test failed:`, err);
          return false;
        }
      },
    };
  };

  return { create, clear: factory.clear };
}
