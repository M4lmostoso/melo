import {
  getUnfetchableCountForAccount,
  getUnfetchableMaxRetries,
  listUnfetchableMessages,
  setUnfetchableIgnored,
  type UnfetchableMessageEntry,
} from "./unfetchableUids";

const mockExecute = vi.fn();
const mockSelect = vi.fn();

vi.mock("./connection", () => ({
  getDb: vi.fn(() => ({
    execute: (...args: unknown[]) => mockExecute(...args),
    select: (...args: unknown[]) => mockSelect(...args),
  })),
}));
vi.mock("./settings", () => ({
  getSetting: vi.fn(async () => null),
}));

import { getSetting } from "./settings";

const mockGetSetting = vi.mocked(getSetting);

describe("unfetchableUids", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSetting.mockResolvedValue(null);
  });

  describe("getUnfetchableMaxRetries", () => {
    it("defaults to 3 when the setting is unset", async () => {
      expect(await getUnfetchableMaxRetries()).toBe(3);
    });

    it("reads the imap_unfetchable_max_retries setting", async () => {
      mockGetSetting.mockResolvedValue("7");
      expect(await getUnfetchableMaxRetries()).toBe(7);
    });

    it("falls back to 3 on garbage or out-of-range values", async () => {
      mockGetSetting.mockResolvedValue("abc");
      expect(await getUnfetchableMaxRetries()).toBe(3);
      mockGetSetting.mockResolvedValue("0");
      expect(await getUnfetchableMaxRetries()).toBe(3);
    });
  });

  describe("getUnfetchableCountForAccount", () => {
    it("excludes duplicates AND ignored entries from the warning count", async () => {
      mockSelect.mockResolvedValue([{ n: 2 }]);

      const n = await getUnfetchableCountForAccount("acc-1", 3);

      expect(n).toBe(2);
      const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("reason != 'duplicate'");
      expect(sql).toContain("ignored = 0");
      expect(params).toEqual(["acc-1", 3]);
    });
  });

  describe("listUnfetchableMessages", () => {
    const row = {
      account_id: "acc-1",
      email: "user@example.com",
      folder_path: "INBOX",
      uid: 2419,
      attempts: 3,
      first_seen_at: 1000,
      last_attempt_at: 2000,
      ignored: 0,
    };

    it("includes ignored entries and enriches with neighbouring messages", async () => {
      mockSelect
        .mockResolvedValueOnce([row, { ...row, uid: 2500, ignored: 1 }])
        // neighbours for uid 2419
        .mockResolvedValueOnce([{ subject: "Before", date: 111 }])
        .mockResolvedValueOnce([{ subject: "After", date: 222 }])
        // neighbours for uid 2500 (none)
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const entries = await listUnfetchableMessages(3);

      expect(entries).toHaveLength(2);
      const [first, second] = entries as [UnfetchableMessageEntry, UnfetchableMessageEntry];
      expect(first).toMatchObject({
        accountId: "acc-1",
        accountEmail: "user@example.com",
        folderPath: "INBOX",
        uid: 2419,
        ignored: false,
        prevSubject: "Before",
        prevDate: 111,
        nextSubject: "After",
        nextDate: 222,
      });
      expect(second).toMatchObject({ uid: 2500, ignored: true, prevSubject: null, nextSubject: null });

      const [listSql] = mockSelect.mock.calls[0] as [string, unknown[]];
      expect(listSql).toContain("reason != 'duplicate'");
      expect(listSql).not.toContain("ignored = 0");
    });

    it("filters by account when accountId is given", async () => {
      mockSelect.mockResolvedValue([]);

      await listUnfetchableMessages(3, "acc-2");

      const [sql, params] = mockSelect.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("AND u.account_id = $2");
      expect(params).toEqual([3, "acc-2"]);
    });
  });

  describe("setUnfetchableIgnored", () => {
    it("sets the ignored flag on one entry", async () => {
      mockExecute.mockResolvedValue(undefined);

      await setUnfetchableIgnored("acc-1", "INBOX", 2419, true);

      const [sql, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(sql).toContain("UPDATE imap_unfetchable_uids SET ignored = $4");
      expect(params).toEqual(["acc-1", "INBOX", 2419, 1]);
    });

    it("clears the ignored flag on restore", async () => {
      mockExecute.mockResolvedValue(undefined);

      await setUnfetchableIgnored("acc-1", "INBOX", 2419, false);

      const [, params] = mockExecute.mock.calls[0] as [string, unknown[]];
      expect(params).toEqual(["acc-1", "INBOX", 2419, 0]);
    });
  });
});
