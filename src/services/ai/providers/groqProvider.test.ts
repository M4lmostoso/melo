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
import { createGroqProvider, clearGroqProvider, GROQ_BASE_URL } from "./groqProvider";

describe("groqProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearGroqProvider();
  });

  it("targets Groq through the Tauri HTTP fetch", () => {
    createGroqProvider("gsk_key", "qwen/qwen3.8-27b");
    expect(GROQ_BASE_URL).toBe("https://api.groq.com/openai/v1");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "gsk_key",
      baseURL: GROQ_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch: tauriFetch,
      timeout: 120_000,
      maxRetries: 1,
    });
  });

  it("sends system, history and user messages and strips <think> blocks", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "<think>hm</think> ciao" } }] });
    const provider = createGroqProvider("k", "qwen/qwen3.8-27b");

    const out = await provider.complete({
      systemPrompt: "sys",
      userContent: "hello",
      conversationHistory: [{ role: "assistant", content: "prev" }],
    });

    expect(out).toBe("ciao");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "qwen/qwen3.8-27b",
      max_tokens: 8192,
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prev" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reuses one client per key and rebuilds it when the key changes", () => {
    createGroqProvider("a", "m");
    createGroqProvider("a", "m2");
    expect(OpenAI).toHaveBeenCalledTimes(1);
    createGroqProvider("b", "m");
    expect(OpenAI).toHaveBeenCalledTimes(2);
  });

  it("testConnection gives up after 30 s without retrying (a queued request must not spin forever)", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] });
    expect(await createGroqProvider("k", "qwen/qwen3.8-27b").testConnection()).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 16 }), {
      timeout: 30_000,
      maxRetries: 0,
    });
  });

  it("reports the real token usage so the limiter's token cap counts it", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 3479 } });
    const onUsage = vi.fn();
    await createGroqProvider("k", "qwen/qwen3.8-27b").complete({ systemPrompt: "s", userContent: "u", onUsage });
    expect(onUsage).toHaveBeenCalledWith(3479);
  });

  it("testConnection reports failure instead of throwing", async () => {
    mockCreate.mockRejectedValue(new Error("401"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createGroqProvider("bad", "qwen/qwen3.8-27b").testConnection()).toBe(false);
  });
});
