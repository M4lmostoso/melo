import { CalDAVProvider } from "./caldavProvider";

const MOCK_ICAL_DATA =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-uid\r\nSUMMARY:Test Event\r\nDTSTART:20240101T100000Z\r\nDTEND:20240101T110000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

const MOCK_ICAL_DATA_2 =
  "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:test-uid-2\r\nSUMMARY:Second Event\r\nDTSTART:20240102T140000Z\r\nDTEND:20240102T150000Z\r\nEND:VEVENT\r\nEND:VCALENDAR";

vi.mock("@/services/db/accounts", () => ({
  getAccount: vi.fn().mockResolvedValue({
    id: "acc-1",
    email: "user@example.com",
    caldav_url: "https://caldav.example.com",
    caldav_username: "user@example.com",
    caldav_password: "secret",
  }),
}));

// All network I/O goes through the Tauri-http CalDAV helpers (reads via PROPFIND/
// REPORT, writes via PUT/GET/DELETE) — never tsdav, which WebKit CORS blocks
// against servers like DavMail. Mock those helpers directly.
const mockListCalDavCalendars = vi.fn();
const mockFetchCalDavEvents = vi.fn();
const mockFetchCalDavCtag = vi.fn();
const mockPutCalDavObject = vi.fn();
const mockGetCalDavObject = vi.fn();
const mockDeleteCalDavObject = vi.fn();
vi.mock("./caldavHttp", () => ({
  listCalDavCalendars: (...args: unknown[]) => mockListCalDavCalendars(...args),
  fetchCalDavEvents: (...args: unknown[]) => mockFetchCalDavEvents(...args),
  fetchCalDavCtag: (...args: unknown[]) => mockFetchCalDavCtag(...args),
  putCalDavObject: (...args: unknown[]) => mockPutCalDavObject(...args),
  getCalDavObject: (...args: unknown[]) => mockGetCalDavObject(...args),
  deleteCalDavObject: (...args: unknown[]) => mockDeleteCalDavObject(...args),
  resolveCalDavUrl: (href: string, base: string) =>
    href.startsWith("http") ? href : new URL(href, base).href,
}));

// syncEvents reads the locally stored calendar (for its CTag and id) and the
// locally stored events (for deletion reconciliation). Mock both DB layers.
const mockGetCalendarByRemoteId = vi.fn();
vi.mock("@/services/db/calendars", () => ({
  getCalendarByRemoteId: (...args: unknown[]) => mockGetCalendarByRemoteId(...args),
}));

const mockGetEventsInRange = vi.fn();
vi.mock("@/services/db/calendarEvents", () => ({
  getCalendarEventsInRangeForCalendars: (...args: unknown[]) => mockGetEventsInRange(...args),
}));

describe("CalDAVProvider", () => {
  let provider: CalDAVProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    // Defaults: no stored calendar/ctag and no local events → full fetch, no skip,
    // no reconciliation. Individual tests override as needed.
    mockFetchCalDavCtag.mockResolvedValue(null);
    mockGetCalendarByRemoteId.mockResolvedValue(null);
    mockGetEventsInRange.mockResolvedValue([]);
    mockPutCalDavObject.mockResolvedValue({ etag: null });
    mockGetCalDavObject.mockResolvedValue(null);
    mockDeleteCalDavObject.mockResolvedValue(undefined);
    provider = new CalDAVProvider("acc-1");
  });

  describe("listCalendars", () => {
    it("delegates to the CalDAV http client with credentials", async () => {
      const mapped = [
        { remoteId: "/cal/personal/", displayName: "Personal", color: null, isPrimary: true },
        { remoteId: "/cal/work/", displayName: "Work", color: "#ff0000", isPrimary: false },
      ];
      mockListCalDavCalendars.mockResolvedValue(mapped);

      const calendars = await provider.listCalendars();

      expect(mockListCalDavCalendars).toHaveBeenCalledWith(
        "https://caldav.example.com",
        "user@example.com",
        "secret",
      );
      expect(calendars).toEqual(mapped);
    });

    it("returns whatever the http client resolves (incl. fallback names)", async () => {
      mockListCalDavCalendars.mockResolvedValue([
        { remoteId: "/cal/unnamed/", displayName: "Calendar 1", color: null, isPrimary: true },
        { remoteId: "/cal/also-unnamed/", displayName: "Calendar 2", color: null, isPrimary: false },
      ]);

      const calendars = await provider.listCalendars();

      expect(calendars[0]!.displayName).toBe("Calendar 1");
      expect(calendars[1]!.displayName).toBe("Calendar 2");
    });
  });

  describe("fetchEvents", () => {
    it("passes time range and parses iCalendar data from objects", async () => {
      mockFetchCalDavEvents.mockResolvedValue([
        { icalData: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"etag-1"' },
        { icalData: MOCK_ICAL_DATA_2, url: "/cal/personal/test-uid-2.ics", etag: '"etag-2"' },
      ]);

      const events = await provider.fetchEvents("/cal/personal/", "2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

      expect(mockFetchCalDavEvents).toHaveBeenCalledWith(
        "/cal/personal/",
        "user@example.com",
        "secret",
        "2024-01-01T00:00:00Z",
        "2024-01-31T23:59:59Z",
      );

      expect(events).toHaveLength(2);
      expect(events[0]!.summary).toBe("Test Event");
      expect(events[0]!.uid).toBe("test-uid");
      expect(events[0]!.etag).toBe('"etag-1"');
      expect(events[0]!.remoteEventId).toBe("/cal/personal/test-uid.ics");
      expect(events[1]!.summary).toBe("Second Event");
      expect(events[1]!.etag).toBe('"etag-2"');
    });

    it("returns no events when the http client returns none", async () => {
      mockFetchCalDavEvents.mockResolvedValue([]);

      const events = await provider.fetchEvents("/cal/personal/", "2024-01-01T00:00:00Z", "2024-01-31T23:59:59Z");

      expect(events).toHaveLength(0);
    });
  });

  describe("createEvent", () => {
    it("generates iCalendar and PUTs a new object with If-None-Match", async () => {
      vi.spyOn(crypto, "randomUUID").mockReturnValue("generated-uuid" as `${string}-${string}-${string}-${string}-${string}`);
      mockPutCalDavObject.mockResolvedValue({ etag: '"new-etag"' });

      const event = await provider.createEvent("/cal/personal/", {
        summary: "New Meeting",
        startTime: "2024-03-15T09:00:00Z",
        endTime: "2024-03-15T10:00:00Z",
      });

      expect(mockPutCalDavObject).toHaveBeenCalledWith(
        "/cal/personal/generated-uuid.ics",
        "user@example.com",
        "secret",
        expect.stringContaining("SUMMARY:New Meeting"),
        { ifNoneMatch: true },
      );

      expect(event.summary).toBe("New Meeting");
      expect(event.remoteEventId).toBe("/cal/personal/generated-uuid.ics");
      expect(event.etag).toBe('"new-etag"');
    });
  });

  describe("updateEvent", () => {
    it("fetches existing, merges updates, and PUTs with If-Match", async () => {
      mockGetCalDavObject.mockResolvedValue({ icalData: MOCK_ICAL_DATA, etag: '"old-etag"' });
      mockPutCalDavObject.mockResolvedValue({ etag: '"updated-etag"' });

      const event = await provider.updateEvent(
        "/cal/personal/",
        "/cal/personal/test-uid.ics",
        { summary: "Updated Event" },
        '"old-etag"',
      );

      // The object URL is resolved to absolute against the account base URL.
      expect(mockGetCalDavObject).toHaveBeenCalledWith(
        "https://caldav.example.com/cal/personal/test-uid.ics",
        "user@example.com",
        "secret",
      );

      expect(mockPutCalDavObject).toHaveBeenCalledWith(
        "https://caldav.example.com/cal/personal/test-uid.ics",
        "user@example.com",
        "secret",
        expect.stringContaining("SUMMARY:Updated Event"),
        { ifMatch: '"old-etag"' },
      );

      expect(event.summary).toBe("Updated Event");
      expect(event.remoteEventId).toBe("/cal/personal/test-uid.ics");
      expect(event.etag).toBe('"updated-etag"');
    });

    it("throws when the existing event is not found", async () => {
      mockGetCalDavObject.mockResolvedValue(null);

      await expect(
        provider.updateEvent("/cal/personal/", "/cal/personal/missing.ics", { summary: "Nope" }),
      ).rejects.toThrow("Event not found on server");
    });
  });

  describe("deleteEvent", () => {
    it("deletes the resolved object URL with etag", async () => {
      await provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics", '"delete-etag"');

      expect(mockDeleteCalDavObject).toHaveBeenCalledWith(
        "https://caldav.example.com/cal/personal/test-uid.ics",
        "user@example.com",
        "secret",
        '"delete-etag"',
      );
    });

    it("deletes without etag when not provided", async () => {
      await provider.deleteEvent("/cal/personal/", "/cal/personal/test-uid.ics");

      expect(mockDeleteCalDavObject).toHaveBeenCalledWith(
        "https://caldav.example.com/cal/personal/test-uid.ics",
        "user@example.com",
        "secret",
        undefined,
      );
    });
  });

  describe("syncEvents", () => {
    it("fetches all objects in time range and returns them as created events", async () => {
      mockFetchCalDavEvents.mockResolvedValue([
        { icalData: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"sync-etag"' },
        { icalData: MOCK_ICAL_DATA_2, url: "/cal/personal/test-uid-2.ics", etag: '"sync-etag-2"' },
      ]);

      const result = await provider.syncEvents("/cal/personal/");

      expect(mockFetchCalDavEvents).toHaveBeenCalledWith(
        "/cal/personal/",
        "user@example.com",
        "secret",
        expect.any(String),
        expect.any(String),
      );

      expect(result.created).toHaveLength(2);
      expect(result.created[0]!.summary).toBe("Test Event");
      expect(result.created[0]!.etag).toBe('"sync-etag"');
      expect(result.created[1]!.summary).toBe("Second Event");
      expect(result.updated).toEqual([]);
      expect(result.deletedRemoteIds).toEqual([]);
      expect(result.newSyncToken).toBeNull();
      expect(result.newCtag).toBeNull();
    });

    it("skips the full fetch when the CTag is unchanged", async () => {
      mockGetCalendarByRemoteId.mockResolvedValue({ id: "cal-local", ctag: "ctag-1" });
      mockFetchCalDavCtag.mockResolvedValue("ctag-1");

      const result = await provider.syncEvents("/cal/personal/");

      expect(mockFetchCalDavEvents).not.toHaveBeenCalled();
      expect(result.created).toEqual([]);
      expect(result.deletedRemoteIds).toEqual([]);
      expect(result.newCtag).toBe("ctag-1");
    });

    it("re-fetches and returns the new CTag when the CTag changed", async () => {
      mockGetCalendarByRemoteId.mockResolvedValue({ id: "cal-local", ctag: "old-ctag" });
      mockFetchCalDavCtag.mockResolvedValue("new-ctag");
      mockFetchCalDavEvents.mockResolvedValue([
        { icalData: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"e"' },
      ]);

      const result = await provider.syncEvents("/cal/personal/");

      expect(mockFetchCalDavEvents).toHaveBeenCalled();
      expect(result.created).toHaveLength(1);
      expect(result.newCtag).toBe("new-ctag");
    });

    it("reports server-deleted events in deletedRemoteIds", async () => {
      mockGetCalendarByRemoteId.mockResolvedValue({ id: "cal-local", ctag: null });
      mockFetchCalDavCtag.mockResolvedValue(null);
      // Server returns only one event...
      mockFetchCalDavEvents.mockResolvedValue([
        { icalData: MOCK_ICAL_DATA, url: "/cal/personal/test-uid.ics", etag: '"e"' },
      ]);
      // ...but the DB still has that one plus a stale one no longer on the server.
      mockGetEventsInRange.mockResolvedValue([
        { remote_event_id: "/cal/personal/test-uid.ics" },
        { remote_event_id: "/cal/personal/gone.ics" },
      ]);

      const result = await provider.syncEvents("/cal/personal/");

      expect(mockGetEventsInRange).toHaveBeenCalledWith(["cal-local"], expect.any(Number), expect.any(Number));
      expect(result.created).toHaveLength(1);
      expect(result.deletedRemoteIds).toEqual(["/cal/personal/gone.ics"]);
    });
  });

  describe("testConnection", () => {
    it("returns success with calendar count on successful connection", async () => {
      mockListCalDavCalendars.mockResolvedValue([
        { remoteId: "/cal/personal/", displayName: "Personal", color: null, isPrimary: true },
        { remoteId: "/cal/work/", displayName: "Work", color: null, isPrimary: false },
      ]);

      const result = await provider.testConnection();

      expect(result).toEqual({
        success: true,
        message: "Connected — found 2 calendars",
      });
    });

    it("returns singular form for one calendar", async () => {
      mockListCalDavCalendars.mockResolvedValue([
        { remoteId: "/cal/personal/", displayName: "Personal", color: null, isPrimary: true },
      ]);

      const result = await provider.testConnection();

      expect(result.message).toBe("Connected — found 1 calendar");
    });

    it("returns error message on failure", async () => {
      mockListCalDavCalendars.mockRejectedValueOnce(new Error("Authentication failed"));

      const result = await provider.testConnection();

      expect(result).toEqual({
        success: false,
        message: "Authentication failed",
      });
    });

    it("handles non-Error thrown values gracefully", async () => {
      mockListCalDavCalendars.mockRejectedValueOnce("some string error");

      const result = await provider.testConnection();

      expect(result).toEqual({
        success: false,
        message: "Connection failed",
      });
    });
  });
});
