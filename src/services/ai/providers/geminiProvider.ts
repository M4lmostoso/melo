import { GoogleGenAI, ThinkingLevel, type GenerateContentConfig, type Content } from "@google/genai";
import type { AiProviderClient, AiCompletionRequest } from "../types";
import { createProviderFactory } from "../providerFactory";

/**
 * Google AI Studio (Gemini API, generativelanguage.googleapis.com) via the
 * current official SDK `@google/genai` (the old `@google/generative-ai` is
 * retired). Serves both Gemini and the open Gemma models (e.g.
 * `gemma-4-31b-it`) with the same API key.
 */
const factory = createProviderFactory((apiKey) => new GoogleGenAI({ apiKey }));

export function isGemmaModel(modelId: string): boolean {
  return modelId.startsWith("gemma-");
}

/**
 * Gemma 4 thinking is an on/off toggle: MINIMAL turns it off. Email tasks
 * (summaries, categories, drafts) don't need it and it only adds latency.
 */
export function buildConfig(modelId: string, systemPrompt?: string): GenerateContentConfig {
  const config: GenerateContentConfig = {};
  if (systemPrompt) config.systemInstruction = systemPrompt;
  if (isGemmaModel(modelId)) config.thinkingConfig = { thinkingLevel: ThinkingLevel.MINIMAL };
  return config;
}

/** `response.text` already drops `thought` parts; also strip inline <think> blocks. */
function cleanAnswer(text: string | undefined): string {
  return (text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

export function createGeminiProvider(apiKey: string, modelId: string): AiProviderClient {
  const client = factory.getClient(apiKey);

  return {
    async complete(req: AiCompletionRequest): Promise<string> {
      const contents: Content[] = [
        ...(req.conversationHistory ?? []).map((m) => ({
          role: m.role === "user" ? "user" : "model",
          parts: [{ text: m.content }],
        })),
        { role: "user", parts: [{ text: req.userContent }] },
      ];
      const response = await client.models.generateContent({
        model: modelId,
        contents,
        // No maxOutputTokens on purpose: on Gemini 3.x it also caps the thinking
        // budget, and a small cap returns an empty answer.
        config: buildConfig(modelId, req.systemPrompt),
      });
      return cleanAnswer(response.text);
    },

    async testConnection(): Promise<boolean> {
      try {
        await client.models.generateContent({
          model: modelId,
          contents: "Say hi",
          config: buildConfig(modelId),
        });
        return true;
      } catch (err) {
        console.error("Google AI Studio connection test failed:", err);
        return false;
      }
    },
  };
}

export function clearGeminiProvider(): void {
  factory.clear();
}
