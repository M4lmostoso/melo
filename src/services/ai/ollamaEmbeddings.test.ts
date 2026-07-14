import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));

import {
  sanitizeForEmbedding,
  getEmbeddingPrefixes,
  cosineSimilarity,
} from "./ollamaEmbeddings";

describe("sanitizeForEmbedding", () => {
  it("strips HTML tags and entities", () => {
    expect(sanitizeForEmbedding("<p>Hello&nbsp;world</p>")).toBe("Hello world");
  });

  it("strips signature footers past the top of the text", () => {
    const body = "La riunione è confermata per giovedì alle 15. Porta i documenti del contratto e le ultime fatture. Ci vediamo in sede come al solito, ti aspetto in sala grande. Cordiali saluti Mario Rossi Via Roma 1";
    const out = sanitizeForEmbedding(body);
    expect(out).toContain("riunione");
    expect(out).not.toContain("Mario Rossi");
  });

  it("does NOT wipe a long newsletter whose 'unsubscribe' link is in the header", () => {
    const body =
      "Unsubscribe | View in browser " +
      "Questa settimana parliamo di novità sul mercato immobiliare. ".repeat(20);
    const out = sanitizeForEmbedding(body, 2048);
    expect(out).toContain("immobiliare");
  });

  it("still strips a real unsubscribe footer at the bottom", () => {
    const content = "Contenuto importante della newsletter. ".repeat(15);
    const out = sanitizeForEmbedding(content + " To unsubscribe click here");
    expect(out).toContain("Contenuto importante");
    expect(out).not.toContain("unsubscribe");
  });

  it("truncates to the chunk boundary (~4 chars per token)", () => {
    const out = sanitizeForEmbedding("a".repeat(10_000), 100);
    expect(out.length).toBe(400);
  });
});

describe("getEmbeddingPrefixes", () => {
  it("uses nomic prefixes for nomic models", () => {
    expect(getEmbeddingPrefixes("nomic-embed-text-v2-moe:latest")).toEqual({
      document: "search_document: ",
      query: "search_query: ",
    });
  });

  it("uses passage/query for e5 models", () => {
    expect(getEmbeddingPrefixes("multilingual-e5-large")).toEqual({
      document: "passage: ",
      query: "query: ",
    });
  });

  it("uses no prefix for bge and unknown models", () => {
    expect(getEmbeddingPrefixes("bge-m3")).toEqual({ document: "", query: "" });
    expect(getEmbeddingPrefixes("some-future-model")).toEqual({ document: "", query: "" });
  });
});

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors and 0 for orthogonal ones", () => {
    expect(cosineSimilarity([1, 2, 3], [1, 2, 3])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });

  it("returns 0 for zero vectors", () => {
    expect(cosineSimilarity([0, 0], [0, 0])).toBe(0);
  });
});
