import { describe, it, expect, vi } from "vitest";

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@/services/db/connection", () => ({ getDb: vi.fn() }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));

import {
  sanitizeForEmbedding,
  chunkForEmbedding,
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

describe("chunkForEmbedding", () => {
  it("returns a single chunk when the text fits", () => {
    expect(chunkForEmbedding("hello world", 384)).toEqual(["hello world"]);
  });

  it("returns nothing for empty content", () => {
    expect(chunkForEmbedding("   ", 384)).toEqual([]);
  });

  it("splits long text into several passages", () => {
    // 10 tokens ≈ 40 chars per chunk.
    const words = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ");
    const chunks = chunkForEmbedding(words, 10, 8);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(8);
  });

  it("covers text a single truncated vector would have missed", () => {
    // ~5500 characters of preamble: the old single-vector path stopped at
    // chunkSize * 4 = 1536, so this deadline was unreachable.
    const filler = "riempitivo ".repeat(500);
    const chunks = chunkForEmbedding(`${filler} scadenza contratto 31 dicembre`);
    expect(chunks.some((c) => c.includes("scadenza contratto"))).toBe(true);
  });

  it("overlaps consecutive chunks", () => {
    const words = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const chunks = chunkForEmbedding(words, 10, 8);
    const first = chunks[0]!.split(" ");
    const tail = first.slice(-1)[0]!;
    expect(chunks[1]).toContain(tail);
  });

  it("honours the chunk cap", () => {
    const chunks = chunkForEmbedding("x ".repeat(20_000), 10, 3);
    expect(chunks.length).toBe(3);
  });

  it("strips HTML and signatures like the single-chunk path", () => {
    const body = "<p>" + "Contenuto reale della mail. ".repeat(20) + "</p>";
    const chunks = chunkForEmbedding(`${body} Cordiali saluti Mario`, 384);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).not.toContain("Cordiali saluti");
    expect(chunks[0]).toContain("Contenuto reale");
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
