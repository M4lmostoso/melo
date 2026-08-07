import { describe, it, expect, beforeEach } from "vitest";
import { useTransferStore } from "./transferStore";

describe("transferStore", () => {
  beforeEach(() => {
    useTransferStore.setState({ transfers: [] });
  });

  it("keeps concurrent transfers side by side, in start order", () => {
    const { startTransfer } = useTransferStore.getState();
    const a = startTransfer("a@x.test", 0);
    const b = startTransfer("b@x.test", 0);

    const { transfers } = useTransferStore.getState();
    expect(transfers.map((tr) => tr.id)).toEqual([a, b]);
    expect(transfers.map((tr) => tr.target)).toEqual(["a@x.test", "b@x.test"]);
  });

  it("updates only the transfer it is given", () => {
    const { startTransfer, updateTransfer } = useTransferStore.getState();
    const a = startTransfer("a@x.test", 0);
    const b = startTransfer("b@x.test", 0);

    updateTransfer(b, 3, 10, "Subject");

    const byId = new Map(useTransferStore.getState().transfers.map((tr) => [tr.id, tr]));
    expect(byId.get(b)).toMatchObject({ done: 3, total: 10, currentSubject: "Subject" });
    expect(byId.get(a)).toMatchObject({ done: 0, total: 0, currentSubject: null });
  });

  it("removes only the finished transfer", () => {
    const { startTransfer, endTransfer } = useTransferStore.getState();
    const a = startTransfer("a@x.test", 0);
    const b = startTransfer("b@x.test", 0);

    endTransfer(a);

    expect(useTransferStore.getState().transfers.map((tr) => tr.id)).toEqual([b]);
  });
});
