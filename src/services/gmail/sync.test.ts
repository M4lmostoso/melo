import { describe, it, expect, vi, beforeEach } from "vitest";
import { deltaSync } from "./sync";
import { GmailClient } from "./client";
import { gmailStoreThread } from "./tauriCommands";

// Mock all DB modules
vi.mock("../db/threads", () => ({
  upsertThread: vi.fn(),
  setThreadLabels: vi.fn(),
  getMutedThreadIds: vi.fn().mockResolvedValue(new Set()),
  markThreadUnreadInDb: vi.fn().mockResolvedValue(undefined),
  deleteThread: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../db/messages", () => ({
  upsertMessage: vi.fn(),
}));
// processAndStoreThread persists via the Rust gmail_store_thread command (Tauri invoke),
// which is unavailable in jsdom — mock it out.
vi.mock("./tauriCommands", () => ({
  gmailStoreThread: vi.fn().mockResolvedValue(undefined),
}));
// processAndStoreThread also prunes orphaned local rows via getDb — return no rows.
vi.mock("../db/connection", () => ({
  getDb: vi.fn(async () => ({
    select: vi.fn(async () => []),
    execute: vi.fn(async () => ({ rowsAffected: 0 })),
  })),
}));
vi.mock("../db/attachments", () => ({
  upsertAttachment: vi.fn(),
}));
vi.mock("../db/accounts", () => ({
  updateAccountSyncState: vi.fn(),
}));
vi.mock("../db/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/threadCategories", () => ({
  getThreadCategoryWithManual: vi.fn().mockResolvedValue(null),
  setThreadCategory: vi.fn(),
  getThreadCategory: vi.fn().mockResolvedValue(null),
}));
vi.mock("../db/notificationVips", () => ({
  getVipSenders: vi.fn().mockResolvedValue(new Set()),
}));
vi.mock("@/services/categorization/ruleEngine", () => ({
  categorizeByRules: vi.fn().mockReturnValue("Primary"),
}));
vi.mock("../filters/filterEngine", () => ({
  applyFiltersToMessages: vi.fn(),
}));
vi.mock("@/services/ai/categorizationManager", () => ({
  categorizeNewThreads: vi.fn(),
}));
vi.mock("@/services/db/bundleRules", () => ({
  getBundleRule: vi.fn().mockResolvedValue(null),
  holdThread: vi.fn(),
  getNextDeliveryTime: vi.fn(),
}));
vi.mock("@/services/db/pendingOperations", () => ({
  getPendingOpsForResource: vi.fn().mockResolvedValue([]),
  getPendingOpResourceIds: vi.fn().mockResolvedValue(new Set()),
}));

const mockNotify = vi.fn();
const mockShouldNotify = vi.fn().mockReturnValue(true);
vi.mock("../notifications/notificationManager", () => ({
  queueNewEmailNotification: (...args: unknown[]) => mockNotify(...args),
  shouldNotifyForMessage: (...args: unknown[]) => mockShouldNotify(...args),
}));

// Mock parseGmailMessage
vi.mock("./messageParser", () => ({
  parseGmailMessage: (msg: { id: string; threadId: string; labelIds: string[] }) => ({
    id: msg.id,
    threadId: msg.threadId,
    labelIds: msg.labelIds ?? [],
    fromAddress: "sender@example.com",
    fromName: "Sender",
    toAddresses: "me@example.com",
    ccAddresses: "",
    bccAddresses: "",
    replyTo: "",
    subject: `Subject for ${msg.id}`,
    snippet: "snippet",
    date: "2024-01-01T00:00:00Z",
    isRead: !msg.labelIds?.includes("UNREAD"),
    isStarred: false,
    bodyHtml: "<p>test</p>",
    bodyText: "test",
    rawSize: 100,
    internalDate: "1704067200000",
    hasAttachments: false,
    attachments: [],
    bodyHtmlAttachmentId: null,
    bodyTextAttachmentId: null,
  }),
  // No-op in tests: the mock messages always have inline bodies, so there is nothing
  // to complete. Present so sync.ts's import resolves against the mock.
  completeOversizedBodies: async () => {},
}));

function createMockClient(historyItems: unknown[]): GmailClient {
  return {
    getHistory: vi.fn().mockResolvedValue({
      history: historyItems,
      historyId: "200",
    }),
    getThread: vi.fn().mockImplementation((threadId: string) =>
      Promise.resolve({
        id: threadId,
        historyId: "200",
        messages: [
          {
            id: `msg-${threadId}`,
            threadId,
            labelIds: ["INBOX", "UNREAD"],
            snippet: "test",
            historyId: "200",
            internalDate: "1704067200000",
            payload: { partId: "", mimeType: "text/plain", filename: "", headers: [], body: { size: 0 } },
            sizeEstimate: 100,
          },
        ],
      }),
    ),
  } as unknown as GmailClient;
}

describe("deltaSync notifications", () => {
  beforeEach(() => {
    mockNotify.mockClear();
    mockShouldNotify.mockClear();
    mockShouldNotify.mockReturnValue(true);
  });

  it("sends notification for new unread inbox message", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-1",
              threadId: "thread-1",
              labelIds: ["INBOX", "UNREAD"],
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).toHaveBeenCalledWith(
      "Sender",
      "Subject for msg-thread-1",
      "thread-1",
      "account-1",
      "sender@example.com",
      "snippet",
    );
  });

  it("does not send notification for read messages", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-2",
              threadId: "thread-2",
              labelIds: ["INBOX"], // no UNREAD
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).not.toHaveBeenCalled();
  });

  it("does not send notification for sent messages", async () => {
    const client = createMockClient([
      {
        id: "100",
        messagesAdded: [
          {
            message: {
              id: "msg-thread-3",
              threadId: "thread-3",
              labelIds: ["SENT"],
            },
          },
        ],
      },
    ]);

    await deltaSync(client, "account-1", "99");

    expect(mockNotify).not.toHaveBeenCalled();
  });
});

describe("processAndStoreThread thread read-state", () => {
  beforeEach(() => {
    vi.mocked(gmailStoreThread).mockClear();
  });

  /** Build a client whose getThread returns a fixed set of messages for the thread. */
  function clientWithThreadMessages(
    threadId: string,
    messages: { id: string; labelIds: string[] }[],
  ): GmailClient {
    return {
      getHistory: vi.fn().mockResolvedValue({
        history: [{ id: "100", messagesAdded: [{ message: { id: messages[0]!.id, threadId, labelIds: messages[0]!.labelIds } }] }],
        historyId: "200",
      }),
      getThread: vi.fn().mockResolvedValue({
        id: threadId,
        historyId: "200",
        messages: messages.map((m) => ({
          id: m.id,
          threadId,
          labelIds: m.labelIds,
          snippet: "test",
          historyId: "200",
          internalDate: "1704067200000",
          payload: { partId: "", mimeType: "text/plain", filename: "", headers: [], body: { size: 0 } },
          sizeEstimate: 100,
        })),
      }),
    } as unknown as GmailClient;
  }

  it("keeps thread unread when an unread inbox message coexists with a trashed message", async () => {
    // Regression: the old `|| allLabelIds.has("TRASH")` forced the whole thread read,
    // hiding the new inbox mail while its trashed sibling still showed unread in Trash.
    const client = clientWithThreadMessages("thread-mix", [
      { id: "msg-inbox", labelIds: ["INBOX", "UNREAD"] },
      { id: "msg-trashed", labelIds: ["TRASH", "UNREAD"] },
    ]);

    await deltaSync(client, "account-1", "99");

    const call = vi.mocked(gmailStoreThread).mock.calls.at(-1)?.[0];
    expect(call?.isRead).toBe(false);
  });

  it("marks a fully-trashed thread as read", async () => {
    const client = clientWithThreadMessages("thread-trash", [
      { id: "msg-t1", labelIds: ["TRASH", "UNREAD"] },
      { id: "msg-t2", labelIds: ["TRASH"] },
    ]);

    await deltaSync(client, "account-1", "99");

    const call = vi.mocked(gmailStoreThread).mock.calls.at(-1)?.[0];
    expect(call?.isRead).toBe(true);
  });
});
