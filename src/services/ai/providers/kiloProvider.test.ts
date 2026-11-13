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
import { createKiloProvider, clearKiloProvider, KILO_BASE_URL } from "./kiloProvider";

describe("kiloProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearKiloProvider();
  });

  it("targets the Kilo gateway through the Tauri HTTP fetch (gateway sends no CORS headers)", () => {
    createKiloProvider("kilo_key", "kilo-auto/free");
    expect(KILO_BASE_URL).toBe("https://api.kilo.ai/api/gateway");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "kilo_key",
      baseURL: KILO_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch: tauriFetch,
      timeout: 120_000,
      maxRetries: 1,
    });
  });

  it("sends system, history and user messages with the chosen model", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "ok" } }] });
    const provider = createKiloProvider("kilo_key", "kilo-auto/free");

    const out = await provider.complete({
      systemPrompt: "sys",
      userContent: "hello",
      conversationHistory: [{ role: "assistant", content: "prev" }],
    });

    expect(out).toBe("ok");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "kilo-auto/free",
      max_tokens: 8192,
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prev" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("strips inline <think> blocks from free reasoning models", async () => {
    mockCreate.mockResolvedValue({
      choices: [{ message: { content: "<think>pondering…</think>\n  Final answer" } }],
    });
    const provider = createKiloProvider("kilo_key", "kilo-auto/free");
    expect(await provider.complete({ systemPrompt: "s", userContent: "u" })).toBe("Final answer");
  });

  it("treats an empty answer as a failure, naming a reasoning model that ran out of tokens", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "" }, finish_reason: "length" }] });
    const provider = createKiloProvider("kilo_key", "nvidia/nemotron-3.5-lightning:free");
    await expect(provider.complete({ systemPrompt: "s", userContent: "u" })).rejects.toThrow(/ran out of tokens/);

    mockCreate.mockResolvedValue({ choices: [{ message: { content: "<think>only thoughts</think>" }, finish_reason: "stop" }] });
    await expect(provider.complete({ systemPrompt: "s", userContent: "u" })).rejects.toThrow(/returned no answer/);
  });

  it("testConnection reports failure instead of throwing", async () => {
    mockCreate.mockRejectedValue(new Error("401"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    const provider = createKiloProvider("bad", "kilo-auto/free");
    expect(await provider.testConnection()).toBe(false);
  });
});
