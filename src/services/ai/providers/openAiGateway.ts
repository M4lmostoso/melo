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

/**
 * Default output budget. The free models on these routers (Nemotron…) reason
 * before answering and the reasoning counts against max_tokens: with 1024,
 * Nemotron 3.5 Lightning ended EVERY urgency call with finish_reason "length"
 * and an empty answer (2026-11-11, 0/5 → 6/6 at 4096). Batch categorisation
 * (~11k chars in) still ran out at 4096, hence 8192.
 */
const GATEWAY_MAX_TOKENS = 8192;

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
          max_tokens: req.maxTokens ?? GATEWAY_MAX_TOKENS,
          messages: [
            { role: "system", content: req.systemPrompt },
            ...history,
            { role: "user", content: req.userContent },
          ],
        });
        const choice = response.choices[0];
        const text = stripThinking(choice?.message?.content ?? "");
        if (!text) {
          // An empty answer is a failure, not "nothing to say": urgency used to read
          // it as "not urgent", and the composer would have replaced the draft
          // with an empty body.
          const why = choice?.finish_reason === "length" ? "ran out of tokens while reasoning" : "returned no answer";
          throw new Error(`${config.name}: model ${model} ${why} (finish_reason: ${choice?.finish_reason ?? "none"})`);
        }
        return text;
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
