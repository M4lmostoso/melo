import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/services/db/search", () => ({ searchMessages: vi.fn() }));
vi.mock("./aiService", () => ({ askInbox: vi.fn() }));
vi.mock("@/services/db/settings", () => ({ getSetting: vi.fn() }));
vi.mock("@/services/db/accounts", () => ({
  getAccountRagEnabled: vi.fn(),
  getRagEnabledAccountIds: vi.fn(),
}));
vi.mock("./ollamaEmbeddings", () => ({
  generateEmbedding: vi.fn(),
  sanitizeForEmbedding: vi.fn((s: string) => s),
  getEmbeddingPrefixes: vi.fn(() => ({ document: "", query: "" })),
}));
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { extractSearchTerms, extractDateConstraint } from "./askInbox";

describe("extractSearchTerms", () => {
  it("removes stopwords and keeps content words", () => {
    expect(extractSearchTerms("quando scade il contratto di noleggio")).toBe(
      "scade contratto noleggio",
    );
  });

  it("splits Italian elisions instead of collapsing them into nonwords", () => {
    const terms = extractSearchTerms("documenti per il noleggio dell'auto");
    expect(terms).toContain("auto");
    expect(terms).not.toContain("dellauto");
    expect(terms).not.toContain("dell");
  });

  it("handles typographic apostrophes too", () => {
    const terms = extractSearchTerms("qual è l’ultima fattura");
    expect(terms).toContain("ultima");
    expect(terms).not.toContain("lultima");
  });
});

describe("extractDateConstraint", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-14T15:30:00"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns midnight-today ms for 'oggi'", () => {
    const ms = extractDateConstraint("che email ho ricevuto oggi");
    expect(ms).toBe(new Date("2026-07-14T00:00:00").getTime());
  });

  it("returns midnight-yesterday ms for 'yesterday'", () => {
    const ms = extractDateConstraint("what came in yesterday");
    expect(ms).toBe(new Date("2026-07-13T00:00:00").getTime());
  });

  it("handles 'questa settimana' as 7 days back", () => {
    const ms = extractDateConstraint("fatture ricevute questa settimana");
    expect(ms).toBe(new Date("2026-07-07T00:00:00").getTime());
  });

  it("handles explicit day counts", () => {
    const ms = extractDateConstraint("email degli ultimi 3 giorni");
    expect(ms).toBe(new Date("2026-07-11T00:00:00").getTime());
  });

  it("returns null when no date is mentioned", () => {
    expect(extractDateConstraint("fattura del commercialista")).toBeNull();
  });
});
