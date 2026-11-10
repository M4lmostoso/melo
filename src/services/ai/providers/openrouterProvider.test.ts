import { describe, it, expect, beforeEach, vi } from "vitest";

const mockCreate = vi.fn();

vi.mock("openai", () => {
  const MockOpenAI = vi.fn(function () {
    return { chat: { completions: { create: mockCreate } } };
  });
  return { default: MockOpenAI };
});

const { tauriFetch } = vi.hoisted(() => ({ tauriFetch: vi.fn() }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));

import OpenAI from "openai";
import { createOpenRouterProvider, clearOpenRouterProvider, OPENROUTER_BASE_URL } from "./openrouterProvider";

describe("openrouterProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearOpenRouterProvider();
  });

  it("targets OpenRouter through the Tauri HTTP fetch with app attribution headers", () => {
    createOpenRouterProvider("sk-or-v1-key", "openrouter/free");
    expect(OPENROUTER_BASE_URL).toBe("https://openrouter.ai/api/v1");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "sk-or-v1-key",
      baseURL: OPENROUTER_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch: tauriFetch,
      defaultHeaders: { "HTTP-Referer": "https://github.com/M4lmostoso/melo", "X-Title": "Melo" },
    });
  });

  it("sends system, history and user messages and strips <think> blocks", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "<think>hm</think> ciao" } }] });
    const provider = createOpenRouterProvider("k", "google/gemma-4-31b-it:free");

    const out = await provider.complete({
      systemPrompt: "sys",
      userContent: "hello",
      conversationHistory: [{ role: "assistant", content: "prev" }],
    });

    expect(out).toBe("ciao");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "google/gemma-4-31b-it:free",
      max_tokens: 1024,
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prev" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reuses one client per key and rebuilds it when the key changes", () => {
    createOpenRouterProvider("a", "m");
    createOpenRouterProvider("a", "m2");
    expect(OpenAI).toHaveBeenCalledTimes(1);
    createOpenRouterProvider("b", "m");
    expect(OpenAI).toHaveBeenCalledTimes(2);
  });

  it("testConnection reports failure instead of throwing", async () => {
    mockCreate.mockRejectedValue(new Error("401"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createOpenRouterProvider("bad", "openrouter/free").testConnection()).toBe(false);
  });
});
