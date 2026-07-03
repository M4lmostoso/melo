import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../db/connection", () => ({
  getDb: vi.fn(),
}));

vi.mock("@/i18n", () => ({
  t: vi.fn((key: string) => key),
}));

import { getDb } from "../db/connection";
import { recoverInterruptedOperations } from "./queueRecovery";
import { createMockDb } from "@/test/mocks";

const mockDb = createMockDb();

function executedSql(): string[] {
  return vi.mocked(mockDb.execute).mock.calls.map((c) => String(c[0]));
}

describe("recoverInterruptedOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(mockDb.execute).mockResolvedValue({ rowsAffected: 0 } as never);
    vi.mocked(getDb).mockResolvedValue(mockDb as unknown as Awaited<ReturnType<typeof getDb>>);
  });

  it("marks interrupted sendMessage ops as failed instead of re-sending", async () => {
    await recoverInterruptedOperations();
    const sql = executedSql();
    const failSql = sql.find((s) => s.includes("operation_type = 'sendMessage'"));
    expect(failSql).toBeTruthy();
    expect(failSql).toContain("status = 'failed'");
    expect(failSql).toContain("status = 'executing'");
  });

  it("re-queues interrupted idempotent ops as pending", async () => {
    await recoverInterruptedOperations();
    const sql = executedSql();
    const requeueSql = sql.find((s) => s.includes("operation_type != 'sendMessage'"));
    expect(requeueSql).toBeTruthy();
    expect(requeueSql).toContain("status = 'pending'");
    expect(requeueSql).toContain("status = 'executing'");
  });

  it("promotes all undo rows to pending", async () => {
    await recoverInterruptedOperations();
    const sql = executedSql();
    const undoSql = sql.find((s) => s.includes("status = 'undo'"));
    expect(undoSql).toBeTruthy();
    expect(undoSql).toContain("status = 'pending'");
    // No deadline filter: after a restart every undo row must be sent.
    expect(undoSql).not.toContain("next_retry_at <=");
  });

  it("flags scheduled emails stuck in sending as failed", async () => {
    await recoverInterruptedOperations();
    const sql = executedSql();
    const scheduledSql = sql.find((s) => s.includes("scheduled_emails"));
    expect(scheduledSql).toBeTruthy();
    expect(scheduledSql).toContain("status = 'failed'");
    expect(scheduledSql).toContain("status = 'sending'");
  });

  it("does not dispatch a sync event when nothing was recovered", async () => {
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await recoverInterruptedOperations();
    expect(dispatchSpy).not.toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });

  it("dispatches a sync event when an interrupted send was flagged", async () => {
    vi.mocked(mockDb.execute).mockResolvedValue({ rowsAffected: 1 } as never);
    const dispatchSpy = vi.spyOn(window, "dispatchEvent");
    await recoverInterruptedOperations();
    expect(dispatchSpy).toHaveBeenCalled();
    dispatchSpy.mockRestore();
  });
});
