import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLabelStore, isSystemLabel } from "./labelStore";

vi.mock("@/services/db/labels", () => ({
  getLabelsForAccount: vi.fn(),
  deleteLabel: vi.fn(),
  updateLabelSortOrder: vi.fn(),
  upsertLabel: vi.fn(),
}));

vi.mock("@/services/db/userLabels", () => ({
  getUserLabelsForAccount: vi.fn(),
  upsertUserLabel: vi.fn(),
  deleteUserLabel: vi.fn(),
  updateUserLabelSortOrder: vi.fn(),
}));

vi.mock("@/services/gmail/tokenManager", () => ({
  getGmailClient: vi.fn(),
}));

// labelStore.isGmailAccount() reads the account provider from accountStore.
vi.mock("@/stores/accountStore", () => ({
  useAccountStore: {
    getState: vi.fn(() => ({ accounts: [{ id: "acc1", provider: "gmail_api" }] })),
  },
}));

import { getLabelsForAccount, deleteLabel as dbDeleteLabel, updateLabelSortOrder, upsertLabel } from "@/services/db/labels";
import { getUserLabelsForAccount, upsertUserLabel, deleteUserLabel, updateUserLabelSortOrder } from "@/services/db/userLabels";
import { getGmailClient } from "@/services/gmail/tokenManager";

const mockGetLabels = vi.mocked(getLabelsForAccount);
const mockDbDeleteLabel = vi.mocked(dbDeleteLabel);
const mockUpdateSortOrder = vi.mocked(updateLabelSortOrder);
const mockUpsertLabel = vi.mocked(upsertLabel);
const mockGetUserLabels = vi.mocked(getUserLabelsForAccount);
const mockUpsertUserLabel = vi.mocked(upsertUserLabel);
const mockDeleteUserLabel = vi.mocked(deleteUserLabel);
const mockUpdateUserSortOrder = vi.mocked(updateUserLabelSortOrder);
const mockGetGmailClient = vi.mocked(getGmailClient);
import { createMockGmailClient } from "@/test/mocks";

describe("labelStore", () => {
  beforeEach(() => {
    useLabelStore.setState({ labels: [], isLoading: false });
    vi.clearAllMocks();
  });

  it("should have correct default state", () => {
    const state = useLabelStore.getState();
    expect(state.labels).toEqual([]);
    expect(state.isLoading).toBe(false);
  });

  it("should clear labels", () => {
    useLabelStore.setState({
      labels: [
        { id: "Label_1", accountId: "acc1", name: "Work", type: "user", colorBg: null, colorFg: null, sortOrder: 0 },
      ],
      isLoading: true,
    });
    useLabelStore.getState().clearLabels();
    const state = useLabelStore.getState();
    expect(state.labels).toEqual([]);
    expect(state.isLoading).toBe(false);
  });

  it("should load labels and filter out system labels", async () => {
    // loadLabels reads from user_labels; system labels are filtered by id and
    // colorFg is derived from colorBg via WCAG contrast (not stored).
    mockGetUserLabels.mockResolvedValue([
      { id: "INBOX", name: "INBOX", color: null, account_id: "acc1", system_label_id: "INBOX", sort_order: 0, created_at: 0 },
      { id: "SENT", name: "SENT", color: null, account_id: "acc1", system_label_id: "SENT", sort_order: 1, created_at: 0 },
      { id: "CATEGORY_SOCIAL", name: "Social", color: null, account_id: "acc1", system_label_id: "CATEGORY_SOCIAL", sort_order: 2, created_at: 0 },
      { id: "Label_1", name: "Work", color: "#4285f4", account_id: "acc1", system_label_id: "Label_1", sort_order: 3, created_at: 0 },
      { id: "Label_2", name: "Personal", color: null, account_id: "acc1", system_label_id: "Label_2", sort_order: 4, created_at: 0 },
    ]);

    await useLabelStore.getState().loadLabels("acc1");

    const state = useLabelStore.getState();
    expect(state.labels).toHaveLength(2);
    expect(state.labels[0]).toEqual({
      id: "Label_1",
      accountId: "acc1",
      name: "Work",
      type: "user",
      colorBg: "#4285f4",
      colorFg: "#000000", // derived: #4285f4 is light → black text
      sortOrder: 3,
    });
    expect(state.labels[1]).toEqual({
      id: "Label_2",
      accountId: "acc1",
      name: "Personal",
      type: "user",
      colorBg: null,
      colorFg: null,
      sortOrder: 4,
    });
    expect(state.isLoading).toBe(false);
  });

  it("should handle load error gracefully", async () => {
    mockGetUserLabels.mockRejectedValue(new Error("DB error"));
    await useLabelStore.getState().loadLabels("acc1");
    const state = useLabelStore.getState();
    expect(state.labels).toEqual([]);
    expect(state.isLoading).toBe(false);
  });

  it("should create a label via Gmail API and update DB", async () => {
    const mockClient = createMockGmailClient();
    // createLabel uses createOrGetLabel (creates parent hierarchy + leaf, tolerating 409s).
    mockClient.createOrGetLabel.mockResolvedValue({
      id: "Label_new",
      name: "New Label",
      type: "user",
      color: { backgroundColor: "#fb4c2f", textColor: "#ffffff" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetGmailClient.mockResolvedValue(mockClient as any);
    mockUpsertLabel.mockResolvedValue(undefined);
    mockUpsertUserLabel.mockResolvedValue(undefined);
    mockGetUserLabels.mockResolvedValue([]);
    mockGetLabels.mockResolvedValue([]);

    await useLabelStore.getState().createLabel("acc1", "New Label", { textColor: "#ffffff", backgroundColor: "#fb4c2f" });

    expect(mockClient.createOrGetLabel).toHaveBeenCalledWith("New Label", { textColor: "#ffffff", backgroundColor: "#fb4c2f" });
    expect(mockUpsertLabel).toHaveBeenCalledWith({
      id: "Label_new",
      accountId: "acc1",
      name: "New Label",
      type: "user",
      colorBg: "#fb4c2f",
      colorFg: "#ffffff",
    });
    expect(mockUpsertUserLabel).toHaveBeenCalledWith({
      id: "Label_new",
      name: "New Label",
      color: "#fb4c2f",
      accountId: "acc1",
      systemLabelId: "Label_new",
    });
    expect(mockGetUserLabels).toHaveBeenCalledWith("acc1");
  });

  it("should update a label via Gmail API and update DB", async () => {
    const mockClient = createMockGmailClient();
    mockClient.updateLabel.mockResolvedValue({
      id: "Label_1",
      name: "Renamed",
      type: "user",
      color: { backgroundColor: "#16a765", textColor: "#ffffff" },
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetGmailClient.mockResolvedValue(mockClient as any);
    mockUpsertLabel.mockResolvedValue(undefined);
    mockUpsertUserLabel.mockResolvedValue(undefined);
    mockGetUserLabels.mockResolvedValue([]);
    mockGetLabels.mockResolvedValue([]);

    await useLabelStore.getState().updateLabel("acc1", "Label_1", {
      name: "Renamed",
      color: { textColor: "#ffffff", backgroundColor: "#16a765" },
    });

    expect(mockClient.updateLabel).toHaveBeenCalledWith("Label_1", {
      name: "Renamed",
      color: { textColor: "#ffffff", backgroundColor: "#16a765" },
    });
    expect(mockUpsertLabel).toHaveBeenCalled();
    expect(mockUpsertUserLabel).toHaveBeenCalled();
  });

  it("should delete a label via Gmail API and DB", async () => {
    const mockClient = createMockGmailClient();
    mockClient.deleteLabel.mockResolvedValue(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockGetGmailClient.mockResolvedValue(mockClient as any);
    mockDbDeleteLabel.mockResolvedValue(undefined);
    mockDeleteUserLabel.mockResolvedValue(undefined);
    mockGetUserLabels.mockResolvedValue([]);
    mockGetLabels.mockResolvedValue([]);

    await useLabelStore.getState().deleteLabel("acc1", "Label_1");

    expect(mockClient.deleteLabel).toHaveBeenCalledWith("Label_1");
    expect(mockDbDeleteLabel).toHaveBeenCalledWith("acc1", "Label_1");
    expect(mockDeleteUserLabel).toHaveBeenCalledWith("Label_1");
    expect(mockGetUserLabels).toHaveBeenCalledWith("acc1");
  });

  it("should reorder labels by updating sort order in DB", async () => {
    mockUpdateSortOrder.mockResolvedValue(undefined);
    mockUpdateUserSortOrder.mockResolvedValue(undefined);
    mockGetUserLabels.mockResolvedValue([]);
    mockGetLabels.mockResolvedValue([]);

    await useLabelStore.getState().reorderLabels("acc1", ["Label_2", "Label_1", "Label_3"]);

    const expectedOrders = [
      { id: "Label_2", sortOrder: 0 },
      { id: "Label_1", sortOrder: 1 },
      { id: "Label_3", sortOrder: 2 },
    ];
    // user_labels is the source of truth; labels table is kept in sync for Gmail.
    expect(mockUpdateUserSortOrder).toHaveBeenCalledWith("acc1", expectedOrders);
    expect(mockUpdateSortOrder).toHaveBeenCalledWith("acc1", expectedOrders);
    expect(mockGetUserLabels).toHaveBeenCalledWith("acc1");
  });
});

describe("isSystemLabel", () => {
  it("should identify system labels", () => {
    expect(isSystemLabel("INBOX")).toBe(true);
    expect(isSystemLabel("SENT")).toBe(true);
    expect(isSystemLabel("DRAFT")).toBe(true);
    expect(isSystemLabel("TRASH")).toBe(true);
    expect(isSystemLabel("SPAM")).toBe(true);
    expect(isSystemLabel("STARRED")).toBe(true);
    expect(isSystemLabel("UNREAD")).toBe(true);
    expect(isSystemLabel("IMPORTANT")).toBe(true);
    expect(isSystemLabel("SNOOZED")).toBe(true);
    expect(isSystemLabel("CHAT")).toBe(true);
  });

  it("should identify category labels as system labels", () => {
    expect(isSystemLabel("CATEGORY_SOCIAL")).toBe(true);
    expect(isSystemLabel("CATEGORY_UPDATES")).toBe(true);
    expect(isSystemLabel("CATEGORY_PROMOTIONS")).toBe(true);
  });

  it("should not flag user labels as system labels", () => {
    expect(isSystemLabel("Label_1")).toBe(false);
    expect(isSystemLabel("Label_2")).toBe(false);
    expect(isSystemLabel("Work")).toBe(false);
  });
});
