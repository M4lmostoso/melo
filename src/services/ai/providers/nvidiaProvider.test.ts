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
import { createNvidiaProvider, clearNvidiaProvider, NVIDIA_BASE_URL } from "./nvidiaProvider";

describe("nvidiaProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearNvidiaProvider();
  });

  it("targets NVIDIA NIM through the Tauri HTTP fetch (its preflights carry no CORS headers)", () => {
    createNvidiaProvider("nvapi-key", "google/gemma-4-31b-it");
    expect(NVIDIA_BASE_URL).toBe("https://integrate.api.nvidia.com/v1");
    expect(OpenAI).toHaveBeenCalledWith({
      apiKey: "nvapi-key",
      baseURL: NVIDIA_BASE_URL,
      dangerouslyAllowBrowser: true,
      fetch: tauriFetch,
      timeout: 120_000,
      maxRetries: 1,
    });
  });

  it("sends system, history and user messages and strips <think> blocks", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "<think>hm</think> ciao" } }] });
    const provider = createNvidiaProvider("k", "google/gemma-4-31b-it");

    const out = await provider.complete({
      systemPrompt: "sys",
      userContent: "hello",
      conversationHistory: [{ role: "assistant", content: "prev" }],
    });

    expect(out).toBe("ciao");
    expect(mockCreate).toHaveBeenCalledWith({
      model: "google/gemma-4-31b-it",
      max_tokens: 8192,
      messages: [
        { role: "system", content: "sys" },
        { role: "assistant", content: "prev" },
        { role: "user", content: "hello" },
      ],
    });
  });

  it("reuses one client per key and rebuilds it when the key changes", () => {
    createNvidiaProvider("a", "m");
    createNvidiaProvider("a", "m2");
    expect(OpenAI).toHaveBeenCalledTimes(1);
    createNvidiaProvider("b", "m");
    expect(OpenAI).toHaveBeenCalledTimes(2);
  });

  it("testConnection gives up after 30 s without retrying (NIM queues some free models forever)", async () => {
    mockCreate.mockResolvedValue({ choices: [{ message: { content: "hi" } }] });
    expect(await createNvidiaProvider("k", "google/gemma-4-31b-it").testConnection()).toBe(true);
    expect(mockCreate).toHaveBeenCalledWith(expect.objectContaining({ max_tokens: 16 }), {
      timeout: 30_000,
      maxRetries: 0,
    });
  });

  it("testConnection reports failure instead of throwing", async () => {
    mockCreate.mockRejectedValue(new Error("401"));
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await createNvidiaProvider("bad", "google/gemma-4-31b-it").testConnection()).toBe(false);
  });
});
