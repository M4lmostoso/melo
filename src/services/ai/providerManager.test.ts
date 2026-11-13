import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/services/db/settings", () => {
  const fn = vi.fn();
  return {
    getSetting: fn,
    getSecureSetting: fn,
    setSetting: vi.fn(async () => {}),
  };
});

import { createMockAiProvider } from "@/test/mocks";

vi.mock("./providers/claudeProvider", () => ({
  createClaudeProvider: vi.fn(() => createMockAiProvider("claude response")),
  clearClaudeProvider: vi.fn(),
}));

vi.mock("./providers/openaiProvider", () => ({
  createOpenAIProvider: vi.fn(() => createMockAiProvider("openai response")),
  clearOpenAIProvider: vi.fn(),
}));

vi.mock("./providers/geminiProvider", () => ({
  createGeminiProvider: vi.fn(() => createMockAiProvider("gemini response")),
  clearGeminiProvider: vi.fn(),
}));

vi.mock("./providers/ollamaProvider", () => ({
  createOllamaProvider: vi.fn(() => createMockAiProvider("ollama response")),
  clearOllamaProvider: vi.fn(),
}));

vi.mock("./providers/copilotProvider", () => ({
  createCopilotProvider: vi.fn(() => createMockAiProvider("copilot response")),
  clearCopilotProvider: vi.fn(),
}));

vi.mock("@/utils/fileLog", () => ({ logToFile: vi.fn() }));

vi.mock("./providers/kiloProvider", () => ({
  createKiloProvider: vi.fn(() => createMockAiProvider("kilo response")),
  clearKiloProvider: vi.fn(),
}));

vi.mock("./providers/groqProvider", () => ({
  createGroqProvider: vi.fn(() => createMockAiProvider("groq response")),
  clearGroqProvider: vi.fn(),
}));

vi.mock("./providers/nvidiaProvider", () => ({
  createNvidiaProvider: vi.fn(() => createMockAiProvider("nvidia response")),
  clearNvidiaProvider: vi.fn(),
}));

import { getSetting } from "@/services/db/settings";
import { createClaudeProvider, clearClaudeProvider } from "./providers/claudeProvider";
import { createOpenAIProvider } from "./providers/openaiProvider";
import { createGeminiProvider } from "./providers/geminiProvider";
import { createOllamaProvider } from "./providers/ollamaProvider";
import { createCopilotProvider } from "./providers/copilotProvider";
import { createKiloProvider } from "./providers/kiloProvider";
import { createNvidiaProvider } from "./providers/nvidiaProvider";
import { createGroqProvider } from "./providers/groqProvider";
import { __resetForTests as resetLimiter, isLaneOpen, acquire } from "./rateLimiter";
import {
  getActiveProvider,
  getActiveProviderName,
  isAiAvailable,
  clearProviderClients,
  getConfiguredProviders,
} from "./providerManager";

const mockGetSetting = vi.mocked(getSetting);

describe("providerManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearProviderClients();
  });

  describe("getActiveProviderName", () => {
    it("defaults to claude when ai_provider is not set", async () => {
      mockGetSetting.mockResolvedValue(null);
      expect(await getActiveProviderName()).toBe("claude");
    });

    it("returns openai when ai_provider is openai", async () => {
      mockGetSetting.mockResolvedValue("openai");
      expect(await getActiveProviderName()).toBe("openai");
    });

    it("returns gemini when ai_provider is gemini", async () => {
      mockGetSetting.mockResolvedValue("gemini");
      expect(await getActiveProviderName()).toBe("gemini");
    });

    it("returns ollama when ai_provider is ollama", async () => {
      mockGetSetting.mockResolvedValue("ollama");
      expect(await getActiveProviderName()).toBe("ollama");
    });

    it("returns copilot when ai_provider is copilot", async () => {
      mockGetSetting.mockResolvedValue("copilot");
      expect(await getActiveProviderName()).toBe("copilot");
    });

    it("returns kilo when ai_provider is kilo", async () => {
      mockGetSetting.mockResolvedValue("kilo");
      expect(await getActiveProviderName()).toBe("kilo");
    });

    it("returns nvidia when ai_provider is nvidia", async () => {
      mockGetSetting.mockResolvedValue("nvidia");
      expect(await getActiveProviderName()).toBe("nvidia");
    });

    it("defaults to claude for unknown provider value", async () => {
      mockGetSetting.mockResolvedValue("unknown_provider");
      expect(await getActiveProviderName()).toBe("claude");
    });
  });

  describe("getActiveProvider", () => {
    it("creates claude provider with default model", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "claude";
        if (key === "claude_api_key") return "sk-ant-test";
        return null;
      });

      await getActiveProvider();
      expect(createClaudeProvider).toHaveBeenCalledWith("sk-ant-test", "claude-haiku-4-5-20251001");
    });

    it("creates openai provider with default model", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        if (key === "openai_api_key") return "sk-test";
        return null;
      });

      await getActiveProvider();
      expect(createOpenAIProvider).toHaveBeenCalledWith("sk-test", "gpt-5-mini");
    });

    it("creates gemini provider with default model", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "gemini";
        if (key === "gemini_api_key") return "AItest";
        return null;
      });

      await getActiveProvider();
      expect(createGeminiProvider).toHaveBeenCalledWith("AItest", "gemini-3.6-flash");
    });

    it("uses custom model from settings when configured", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "claude";
        if (key === "claude_api_key") return "sk-ant-test";
        if (key === "claude_model") return "claude-sonnet-4-6";
        return null;
      });

      await getActiveProvider();
      expect(createClaudeProvider).toHaveBeenCalledWith("sk-ant-test", "claude-sonnet-4-6");
    });

    it("invalidates cache when model changes", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        if (key === "openai_api_key") return "sk-test";
        if (key === "openai_model") return "gpt-4o-mini";
        return null;
      });

      await getActiveProvider();
      expect(createOpenAIProvider).toHaveBeenCalledTimes(1);

      // Change model
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        if (key === "openai_api_key") return "sk-test";
        if (key === "openai_model") return "gpt-4o";
        return null;
      });

      await getActiveProvider();
      expect(createOpenAIProvider).toHaveBeenCalledTimes(2);
      expect(createOpenAIProvider).toHaveBeenLastCalledWith("sk-test", "gpt-4o");
    });

    it("creates copilot provider with default model", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "copilot";
        if (key === "copilot_api_key") return "ghp_test123";
        return null;
      });

      await getActiveProvider();
      expect(createCopilotProvider).toHaveBeenCalledWith("ghp_test123", "openai/gpt-4o-mini");
    });

    it("creates kilo provider with the free auto-router by default", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "kilo";
        if (key === "kilo_api_key") return "kilo_test";
        return null;
      });

      await getActiveProvider();
      expect(createKiloProvider).toHaveBeenCalledWith("kilo_test", "kilo-auto/free");
    });

    it("creates the nvidia provider with Nemotron 3.5 Super by default and caps it below the 40/min quota", async () => {
      resetLimiter();
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "nvidia";
        if (key === "nvidia_api_key") return "nvapi-test";
        return null;
      });

      await getActiveProvider();
      expect(createNvidiaProvider).toHaveBeenCalledWith("nvapi-test", "nvidia/nemotron-3.5-super-vl-120b-a12b");
      // 30 automatic calls fit in a minute, the 31st is refused without a request.
      for (let i = 0; i < 30; i++) await acquire("auto");
      await expect(acquire("auto")).rejects.toMatchObject({ code: "RATE_LIMITED" });
      // A click still goes through.
      await expect(acquire("interactive")).resolves.toBeUndefined();
      resetLimiter();
    });

    it("creates the groq provider with Qwen 3.8 27B by default, capped below 30/min", async () => {
      resetLimiter();
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "groq";
        if (key === "groq_api_key") return "gsk_test";
        return null;
      });
      await getActiveProvider();
      expect(createGroqProvider).toHaveBeenCalledWith("gsk_test", "qwen/qwen3.8-27b");
      for (let i = 0; i < 24; i++) await acquire("auto");
      await expect(acquire("auto")).rejects.toMatchObject({ code: "RATE_LIMITED" });
      resetLimiter();
    });

    it("composer on the same provider: its own model, shared limiter state", async () => {
      resetLimiter();
      const settings: Record<string, string> = {
        ai_provider: "groq",
        groq_api_key: "gsk_test",
        groq_model: "qwen/qwen3.8-27b",
        ai_composer_model: "openai/gpt-oss-120b",
      };
      mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
      clearProviderClients();

      const main = await getActiveProvider();
      const composer = await getActiveProvider("composer");
      expect(createGroqProvider).toHaveBeenCalledWith("gsk_test", "qwen/qwen3.8-27b");
      expect(createGroqProvider).toHaveBeenCalledWith("gsk_test", "openai/gpt-oss-120b");
      expect(composer).not.toBe(main);
      expect(await getActiveProvider()).toBe(main);
      expect(await getActiveProvider("composer")).toBe(composer);
      resetLimiter();
    });

    it("composer on ANOTHER provider: its 429 never pauses the main provider's background lanes", async () => {
      resetLimiter();
      const settings: Record<string, string> = {
        ai_provider: "groq",
        groq_api_key: "gsk_test",
        nvidia_api_key: "nvapi-test",
        ai_composer_provider: "nvidia",
        ai_composer_model: "nvidia/nemotron-3.5-super-vl-120b-a12b",
      };
      mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
      clearProviderClients();
      vi.mocked(createNvidiaProvider).mockReturnValueOnce({
        complete: vi.fn().mockRejectedValue(Object.assign(new Error("Too Many Requests"), { status: 429 })),
        testConnection: vi.fn(),
      });

      await getActiveProvider(); // main (groq) sets the limiter owner
      const composer = await getActiveProvider("composer");
      expect(createNvidiaProvider).toHaveBeenCalledWith("nvapi-test", "nvidia/nemotron-3.5-super-vl-120b-a12b");
      await expect(composer.complete({ systemPrompt: "s", userContent: "u" })).rejects.toThrow("Too Many Requests");
      expect(isLaneOpen("live")).toBe(true);
      expect(isLaneOpen("backfill")).toBe(true);
      resetLimiter();
    });

    it("a blank composer model means the main model", async () => {
      const settings: Record<string, string> = { ai_provider: "groq", groq_api_key: "gsk_x", groq_model: "qwen/qwen3.8-27b", ai_composer_model: "  " };
      mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
      clearProviderClients();
      vi.mocked(createGroqProvider).mockClear();
      await getActiveProvider("composer");
      expect(createGroqProvider).toHaveBeenCalledWith("gsk_x", "qwen/qwen3.8-27b");
      expect(createGroqProvider).toHaveBeenCalledTimes(1);
    });

    it("composer provider without credentials falls back to the main provider", async () => {
      const settings: Record<string, string> = {
        ai_provider: "groq",
        groq_api_key: "gsk_x",
        groq_model: "qwen/qwen3.8-27b",
        ai_composer_provider: "nvidia",
      };
      mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
      clearProviderClients();
      vi.mocked(createGroqProvider).mockClear();
      vi.spyOn(console, "warn").mockImplementation(() => {});
      await getActiveProvider("composer");
      expect(createGroqProvider).toHaveBeenCalledWith("gsk_x", "qwen/qwen3.8-27b");
    });

    it("lists only the providers that have credentials", async () => {
      const settings: Record<string, string> = { groq_api_key: "g", nvidia_api_key: "n", ollama_server_url: "http://localhost:11434" };
      mockGetSetting.mockImplementation(async (key: string) => settings[key] ?? null);
      expect(await getConfiguredProviders()).toEqual(["ollama", "groq", "nvidia"]);
    });

    it("a stored 'openrouter' (provider removed) falls back to the default", async () => {
      mockGetSetting.mockResolvedValue("openrouter");
      expect(await getActiveProviderName()).toBe("claude");
    });

    it("creates ollama provider with server url and model", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "ollama";
        if (key === "ollama_server_url") return "http://localhost:11434";
        if (key === "ollama_model") return "llama3.2";
        return null;
      });

      await getActiveProvider();
      expect(createOllamaProvider).toHaveBeenCalledWith("http://localhost:11434", "llama3.2");
    });

    it("uses default ollama url and model when not configured", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "ollama";
        return null;
      });

      await getActiveProvider();
      expect(createOllamaProvider).toHaveBeenCalledWith("http://localhost:11434", "llama3.3");
    });

    it("throws NOT_CONFIGURED when API key is missing", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        return null;
      });

      await expect(getActiveProvider()).rejects.toThrow("openai API key not configured");
    });

    it("caches provider and reuses on subsequent calls", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "claude";
        if (key === "claude_api_key") return "sk-ant-test";
        return null;
      });

      await getActiveProvider();
      await getActiveProvider();
      expect(createClaudeProvider).toHaveBeenCalledTimes(1);
    });

    it("caches ollama provider and reuses on subsequent calls", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "ollama";
        if (key === "ollama_server_url") return "http://localhost:11434";
        if (key === "ollama_model") return "llama3.2";
        return null;
      });

      await getActiveProvider();
      await getActiveProvider();
      expect(createOllamaProvider).toHaveBeenCalledTimes(1);
    });
  });

  describe("isAiAvailable", () => {
    it("returns false when ai_enabled is false", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "false";
        return null;
      });

      expect(await isAiAvailable()).toBe(false);
    });

    it("returns false when active provider API key is missing", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "true";
        if (key === "ai_provider") return "openai";
        // openai_api_key not set
        return null;
      });

      expect(await isAiAvailable()).toBe(false);
    });

    it("returns true when enabled and key exists", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "true";
        if (key === "ai_provider") return "claude";
        if (key === "claude_api_key") return "sk-ant-test";
        return null;
      });

      expect(await isAiAvailable()).toBe(true);
    });

    it("returns true when ai_enabled is not set (defaults to enabled)", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return null;
        if (key === "claude_api_key") return "sk-ant-test";
        return null;
      });

      expect(await isAiAvailable()).toBe(true);
    });

    it("returns true for copilot when API key exists", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "true";
        if (key === "ai_provider") return "copilot";
        if (key === "copilot_api_key") return "ghp_test123";
        return null;
      });

      expect(await isAiAvailable()).toBe(true);
    });

    it("returns true for ollama when server url is configured", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "true";
        if (key === "ai_provider") return "ollama";
        if (key === "ollama_server_url") return "http://localhost:11434";
        return null;
      });

      expect(await isAiAvailable()).toBe(true);
    });

    it("returns false for ollama when server url is not configured", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_enabled") return "true";
        if (key === "ai_provider") return "ollama";
        return null;
      });

      expect(await isAiAvailable()).toBe(false);
    });
  });

  describe("clearProviderClients", () => {
    it("forces re-creation on next getActiveProvider call", async () => {
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "claude";
        if (key === "claude_api_key") return "sk-ant-test";
        return null;
      });

      await getActiveProvider();
      expect(createClaudeProvider).toHaveBeenCalledTimes(1);

      clearProviderClients();
      expect(clearClaudeProvider).toHaveBeenCalled();

      await getActiveProvider();
      expect(createClaudeProvider).toHaveBeenCalledTimes(2);
    });
  });

  describe("rate limiting wrapper", () => {
    beforeEach(() => {
      resetLimiter();
      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        if (key === "openai_api_key") return "sk-test";
        return null;
      });
    });

    it("a 429 from the provider pauses the background lanes", async () => {
      vi.mocked(createOpenAIProvider).mockReturnValueOnce({
        complete: vi.fn().mockRejectedValue(Object.assign(new Error("Too Many Requests"), { status: 429 })),
        testConnection: vi.fn(),
      });
      const client = await getActiveProvider();
      await expect(client.complete({ systemPrompt: "s", userContent: "u", priority: "live" })).rejects.toThrow();
      expect(isLaneOpen("live")).toBe(false);
      expect(isLaneOpen("backfill")).toBe(false);
      // …but the user can still ask
      await expect(client.complete({ systemPrompt: "s", userContent: "u" })).rejects.toThrow("Too Many Requests");
    });

    it("switching to another key drops the old pause", async () => {
      vi.mocked(createOpenAIProvider).mockReturnValueOnce({
        complete: vi.fn().mockRejectedValue(Object.assign(new Error("429"), { status: 429 })),
        testConnection: vi.fn(),
      });
      const client = await getActiveProvider();
      await expect(client.complete({ systemPrompt: "s", userContent: "u" })).rejects.toThrow();
      expect(isLaneOpen("live")).toBe(false);

      mockGetSetting.mockImplementation(async (key: string) => {
        if (key === "ai_provider") return "openai";
        if (key === "openai_api_key") return "sk-other";
        return null;
      });
      await getActiveProvider();
      expect(isLaneOpen("live")).toBe(true);
    });
  });
});
