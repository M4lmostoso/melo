import { describe, it, expect, beforeEach, vi } from "vitest";

const { generateContent } = vi.hoisted(() => ({ generateContent: vi.fn() }));

vi.mock("@google/genai", () => ({
  GoogleGenAI: vi.fn(function () {
    return { models: { generateContent } };
  }),
  ThinkingLevel: { MINIMAL: "MINIMAL" },
}));

import { GoogleGenAI } from "@google/genai";
import { createGeminiProvider, clearGeminiProvider, buildConfig } from "./geminiProvider";
import { resolveModelId, PROVIDER_MODELS, DEFAULT_MODELS } from "../types";

describe("geminiProvider (Google AI Studio, @google/genai)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGeminiProvider();
  });

  it("offers Gemma 4 31B and defaults to a model still in the catalog", () => {
    const ids = PROVIDER_MODELS.gemini.map((m) => m.id);
    expect(ids).toContain("gemma-4-31b-it");
    expect(ids).toContain(DEFAULT_MODELS.gemini);
    expect(ids).not.toContain("gemini-3-flash");
  });

  it("creates the client with the API key", () => {
    createGeminiProvider("k", "gemini-3.6-flash");
    expect(GoogleGenAI).toHaveBeenCalledWith({ apiKey: "k" });
  });

  it("turns Gemma thinking off, leaves Gemini config untouched", () => {
    expect(buildConfig("gemma-4-31b-it", "s")).toEqual({
      systemInstruction: "s",
      thinkingConfig: { thinkingLevel: "MINIMAL" },
    });
    expect(buildConfig("gemini-3.6-flash", "s")).toEqual({ systemInstruction: "s" });
  });

  it("sends history + user turn as contents and returns the cleaned answer", async () => {
    generateContent.mockResolvedValue({ text: "<think>hmm</think>  Answer " });
    const out = await createGeminiProvider("k", "gemini-3.6-flash").complete({
      systemPrompt: "sys",
      userContent: "now",
      conversationHistory: [
        { role: "user", content: "q" },
        { role: "assistant", content: "a" },
      ],
    });

    expect(out).toBe("Answer");
    expect(generateContent).toHaveBeenCalledWith({
      model: "gemini-3.6-flash",
      contents: [
        { role: "user", parts: [{ text: "q" }] },
        { role: "model", parts: [{ text: "a" }] },
        { role: "user", parts: [{ text: "now" }] },
      ],
      config: { systemInstruction: "sys" },
    });
  });

  it("returns an empty string when the response has no text", async () => {
    generateContent.mockResolvedValue({ text: undefined });
    expect(await createGeminiProvider("k", "gemini-3.6-flash").complete({ systemPrompt: "s", userContent: "u" })).toBe("");
  });

  it("testConnection reports failure instead of throwing", async () => {
    generateContent.mockRejectedValue(new Error("404 model not found"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createGeminiProvider("k", "gone").testConnection()).toBe(false);
  });
});

describe("resolveModelId", () => {
  it("remaps retired Gemini ids that may still be stored in settings", () => {
    expect(resolveModelId("gemini", "gemini-3-flash")).toBe("gemini-3.6-flash");
    expect(resolveModelId("gemini", "gemini-3-pro")).toBe("gemini-3.1-pro-preview");
  });

  it("keeps valid ids and falls back to the default when unset", () => {
    expect(resolveModelId("gemini", "gemma-4-31b-it")).toBe("gemma-4-31b-it");
    expect(resolveModelId("kilo", "minimax/minimax-m3")).toBe("minimax/minimax-m3");
    expect(resolveModelId("gemini", null)).toBe(DEFAULT_MODELS.gemini);
  });
});
