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

import { getSetting } from "@/services/db/settings";
import { createClaudeProvider, clearClaudeProvider } from "./providers/claudeProvider";
import { createOpenAIProvider } from "./providers/openaiProvider";
import { createGeminiProvider } from "./providers/geminiProvider";
import { createOllamaProvider } from "./providers/ollamaProvider";
import { createCopilotProvider } from "./providers/copilotProvider";
import { createKiloProvider } from "./providers/kiloProvider";
import { __resetForTests as resetLimiter, isLaneOpen } from "./rateLimiter";
import {
  getActiveProvider,
  getActiveProviderName,
  isAiAvailable,
  clearProviderClients,
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
