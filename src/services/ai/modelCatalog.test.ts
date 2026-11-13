import { describe, it, expect, beforeEach, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetch: vi.fn(),
  store: new Map<string, string>(),
  testConnection: vi.fn(),
  activeProvider: "gemini" as string,
  clearProviderClients: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: h.fetch }));
vi.mock("@/utils/fileLog", () => ({ logToFile: vi.fn() }));
vi.mock("@/services/db/settings", () => ({
  getSetting: vi.fn(async (k: string) => h.store.get(k) ?? null),
  getSecureSetting: vi.fn(async (k: string) => h.store.get(k) ?? null),
  setSetting: vi.fn(async (k: string, v: string) => void h.store.set(k, v)),
}));
vi.mock("./providerManager", () => ({
  getActiveProviderName: vi.fn(async () => h.activeProvider),
  getActiveProvider: vi.fn(async () => ({ testConnection: h.testConnection })),
  clearProviderClients: h.clearProviderClients,
}));

import { getModelCatalog, healActiveModel, pickReplacement, CATALOG_TTL_MS } from "./modelCatalog";

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });

const geminiCatalog = {
  models: [
    { name: "models/gemini-3.6-flash", displayName: "Gemini 3.6 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash", displayName: "Gemini 3.8 Flash", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemma-4-31b-it", displayName: "Gemma 4 31B", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-3.8-flash-tts", supportedGenerationMethods: ["generateContent"] },
    { name: "models/gemini-embedding-2", supportedGenerationMethods: ["embedContent"] },
  ],
};

describe("modelCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.store.clear();
    h.activeProvider = "gemini";
    vi.spyOn(console, "warn").mockImplementation(() => {});
  });

  it("fetches Google's catalog with the stored key, keeps chat models only, newest first", async () => {
    h.store.set("gemini_api_key", "AIkey");
    h.fetch.mockResolvedValue(ok(geminiCatalog));

    const c = await getModelCatalog("gemini");
    expect(h.fetch.mock.calls[0]![1]).toMatchObject({ headers: { "x-goog-api-key": "AIkey" } });
    expect(c.fallback).toBe(false);
    expect(c.models.map((m) => m.id)).toEqual(["gemma-4-31b-it", "gemini-3.8-flash", "gemini-3.6-flash"]);
  });

  it("serves the cache within 24h and refetches after", async () => {
    h.store.set("gemini_api_key", "AIkey");
    h.fetch.mockResolvedValue(ok(geminiCatalog));
    await getModelCatalog("gemini");
    await getModelCatalog("gemini");
    expect(h.fetch).toHaveBeenCalledTimes(1);

    const cached = JSON.parse(h.store.get("ai_model_catalog_gemini")!);
    cached.fetchedAt -= CATALOG_TTL_MS + 1;
    h.store.set("ai_model_catalog_gemini", JSON.stringify(cached));
    await getModelCatalog("gemini");
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("falls back to the built-in list when the catalog can't be fetched", async () => {
    h.fetch.mockRejectedValue(new Error("offline"));
    const c = await getModelCatalog("gemini");
    expect(c.fallback).toBe(true);
    expect(c.models.map((m) => m.id)).toContain("gemma-4-31b-it");
  });

  it("lists Kilo without a key, free models first", async () => {
    h.fetch.mockResolvedValue(
      ok({
        data: [
          { id: "anthropic/claude-x", pricing: { prompt: "0.000003", completion: "0.00001" } },
          { id: "kilo-auto/free", name: "Auto Free" },
          { id: "weird/no-price", pricing: { prompt: "", completion: "" } },
        ],
      }),
    );
    const c = await getModelCatalog("kilo");
    expect(h.fetch.mock.calls[0]![0]).toBe("https://api.kilo.ai/api/gateway/models");
    expect(c.models.map((m) => [m.id, m.free])).toEqual([
      ["kilo-auto/free", true],
      ["anthropic/claude-x", false],
      ["weird/no-price", false],
    ]);
  });

  it("lists Groq with the stored key, active chat models only, all free", async () => {
    h.store.set("groq_api_key", "gsk_test");
    h.fetch.mockResolvedValue(
      ok({
        data: [
          { id: "qwen/qwen3.8-27b", active: true, context_window: 131072 },
          { id: "llama-3.3-70b-versatile", active: true },
          { id: "whisper-large-v3", active: true },
          { id: "canopylabs/orpheus-v1-english", active: true },
          { id: "meta-llama/llama-prompt-guard-2-86m", active: true },
          { id: "openai/gpt-oss-safeguard-20b", active: true },
          { id: "allam-2-7b", active: true },
          { id: "old/retired-model", active: false },
        ],
      }),
    );
    const c = await getModelCatalog("groq");
    expect(h.fetch.mock.calls[0]![0]).toBe("https://api.groq.com/openai/v1/models");
    expect(h.fetch.mock.calls[0]![1]).toMatchObject({ headers: { Authorization: "Bearer gsk_test" } });
    expect(c.models.map((m) => [m.id, m.free])).toEqual([
      ["llama-3.3-70b-versatile", true],
      ["qwen/qwen3.8-27b", true],
    ]);
  });

  it("lists NVIDIA NIM without a key, chat models only, all free", async () => {
    h.fetch.mockResolvedValue(
      ok({
        data: [
          { id: "nvidia/nemotron-3.5-lightning-30b-a3b", object: "model", owned_by: "nvidia" },
          { id: "google/gemma-4-31b-it", object: "model", owned_by: "google" },
          { id: "nvidia/nemotron-3.5-embed-8b", object: "model" },
          { id: "nvidia/llama-3.1-nemoguard-8b-content-safety", object: "model" },
          { id: "nvidia/nemotron-4-340b-reward", object: "model" },
          { id: "nvidia/nemotron-parse-2.0", object: "model" },
          { id: "nvidia/llama-3.2-nemoretriever-1b-vlm-embed-v1", object: "model" },
          { id: "nvidia/nvclip", object: "model" },
        ],
      }),
    );
    const c = await getModelCatalog("nvidia");
    expect(h.fetch.mock.calls[0]![0]).toBe("https://integrate.api.nvidia.com/v1/models");
    expect(c.models.map((m) => [m.id, m.free])).toEqual([
      ["google/gemma-4-31b-it", true],
      ["nvidia/nemotron-3.5-lightning-30b-a3b", true],
    ]);
    // No curated pick served → the Nemotron 3.5 family, never a random id.
    expect(
      pickReplacement("nvidia", [
        { id: "a/other", label: "" },
        { id: "nvidia/nemotron-3.5-new", label: "" },
      ]),
    ).toBe("nvidia/nemotron-3.5-new");
  });

  describe("pickReplacement", () => {
    it("prefers the curated pick, then the provider heuristic", () => {
      expect(pickReplacement("gemini", [{ id: "gemini-3.8-flash", label: "" }, { id: "gemini-3.6-flash", label: "" }])).toBe(
        "gemini-3.6-flash",
      );
      expect(pickReplacement("gemini", [{ id: "gemma-9", label: "" }, { id: "gemini-9.0-flash", label: "" }])).toBe(
        "gemini-9.0-flash",
      );
      expect(pickReplacement("ollama", [{ id: "qwen3:8b", label: "" }])).toBe("qwen3:8b");
      expect(pickReplacement("kilo", [])).toBeNull();
    });
  });

  describe("healActiveModel", () => {
    beforeEach(() => {
      h.store.set("gemini_api_key", "AIkey");
      h.fetch.mockResolvedValue(ok(geminiCatalog));
    });

    it("switches a retired model once the catalog AND a real call confirm it is gone", async () => {
      h.store.set("gemini_model", "gemini-2.9-ultra");
      h.testConnection.mockResolvedValue(false);

      expect(await healActiveModel()).toEqual({ provider: "gemini", from: "gemini-2.9-ultra", to: "gemini-3.6-flash" });
      expect(h.store.get("gemini_model")).toBe("gemini-3.6-flash");
      expect(h.clearProviderClients).toHaveBeenCalled();
    });

    it("never touches a model that is missing from the catalog but still answers", async () => {
      h.store.set("gemini_model", "gemini-3.8-flash-lite-custom");
      h.testConnection.mockResolvedValue(true);

      expect(await healActiveModel()).toBeNull();
      expect(h.store.get("gemini_model")).toBe("gemini-3.8-flash-lite-custom");
    });

    it("persists a silently remapped retired id without a test call", async () => {
      h.store.set("gemini_model", "gemini-3-flash");
      expect(await healActiveModel()).toBeNull();
      expect(h.store.get("gemini_model")).toBe("gemini-3.6-flash");
      expect(h.testConnection).not.toHaveBeenCalled();
    });

    it("does nothing on the offline fallback list", async () => {
      h.fetch.mockRejectedValue(new Error("offline"));
      h.store.set("gemini_model", "gemini-2.9-ultra");
      h.testConnection.mockResolvedValue(false);

      expect(await healActiveModel()).toBeNull();
      expect(h.store.get("gemini_model")).toBe("gemini-2.9-ultra");
    });
  });
});
