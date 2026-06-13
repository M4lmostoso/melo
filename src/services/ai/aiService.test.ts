import { describe, it, expect, beforeEach, vi } from "vitest";

const mockComplete = vi.fn();

vi.mock("./providerManager", () => ({
  getActiveProvider: vi.fn(() => ({
    complete: mockComplete,
    testConnection: vi.fn(() => Promise.resolve(true)),
  })),
}));

vi.mock("@/services/db/aiCache", () => ({
  getAiCache: vi.fn(() => Promise.resolve(null)),
  setAiCache: vi.fn(),
}));

import { classifyThreadsBySmartLabels, judgePhishingRisk } from "./aiService";

describe("classifyThreadsBySmartLabels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const threads = [
    { id: "t1", subject: "Software Engineer Position", snippet: "We're hiring...", fromAddress: "recruiter@company.com" },
    { id: "t2", subject: "Your order shipped", snippet: "Package tracking...", fromAddress: "orders@shop.com" },
    { id: "t3", subject: "Team standup notes", snippet: "Meeting recap...", fromAddress: "pm@work.com" },
  ];

  const labelRules = [
    { labelId: "label-jobs", description: "Job applications and career opportunities" },
    { labelId: "label-orders", description: "Shopping orders and delivery updates" },
  ];

  it("parses valid AI response into assignments map", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs\nt2:label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
    expect(result.has("t3")).toBe(false);
  });

  it("supports multi-label assignments", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,label-orders");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs", "label-orders"]);
  });

  it("ignores invalid thread IDs", async () => {
    mockComplete.mockResolvedValueOnce("invalid-id:label-jobs\nt1:label-jobs");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(1);
    expect(result.has("invalid-id")).toBe(false);
    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("ignores invalid label IDs", async () => {
    mockComplete.mockResolvedValueOnce("t1:label-jobs,fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.get("t1")).toEqual(["label-jobs"]);
  });

  it("skips threads where all labels are invalid", async () => {
    mockComplete.mockResolvedValueOnce("t1:fake-label");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles empty AI response", async () => {
    mockComplete.mockResolvedValueOnce("");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(0);
  });

  it("handles blank lines and whitespace in response", async () => {
    mockComplete.mockResolvedValueOnce("\n  t1:label-jobs  \n\n  t2:label-orders\n");

    const result = await classifyThreadsBySmartLabels(threads, labelRules);

    expect(result.size).toBe(2);
    expect(result.get("t1")).toEqual(["label-jobs"]);
    expect(result.get("t2")).toEqual(["label-orders"]);
  });

  it("passes label definitions and thread data to AI", async () => {
    mockComplete.mockResolvedValueOnce("");

    await classifyThreadsBySmartLabels(threads, labelRules);

    expect(mockComplete).toHaveBeenCalledTimes(1);
    const callArgs = mockComplete.mock.calls[0]![0] as { userContent: string };
    expect(callArgs.userContent).toContain("label-jobs");
    expect(callArgs.userContent).toContain("Job applications");
    expect(callArgs.userContent).toContain("t1");
    expect(callArgs.userContent).toContain("recruiter@company.com");
  });
});

describe("judgePhishingRisk", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("parses a PHISHING verdict with reason", async () => {
    mockComplete.mockResolvedValueOnce("PHISHING — link text impersonates paypal but points elsewhere");
    const { verdict, reason } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("phishing");
    expect(reason).toContain("impersonates paypal");
  });

  it("parses a SAFE verdict (false positive cleared)", async () => {
    mockComplete.mockResolvedValueOnce("SAFE — legitimate newsletter with tracking links");
    const { verdict } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("safe");
  });

  it("parses a SUSPICIOUS verdict with colon separator", async () => {
    mockComplete.mockResolvedValueOnce("SUSPICIOUS: unusual sender domain");
    const { verdict, reason } = await judgePhishingRisk("ctx");
    expect(verdict).toBe("suspicious");
    expect(reason).toBe("unusual sender domain");
  });

  it("is case-insensitive and defaults to safe on unrecognized output", async () => {
    mockComplete.mockResolvedValueOnce("phishing - lowercase still works");
    expect((await judgePhishingRisk("ctx")).verdict).toBe("phishing");

    mockComplete.mockResolvedValueOnce("I think this is fine");
    expect((await judgePhishingRisk("ctx")).verdict).toBe("safe");
  });
});
