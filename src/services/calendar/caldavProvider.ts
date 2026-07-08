import type {
  CalendarProvider,
  CalendarProviderType,
  CalendarInfo,
  CalendarEventData,
  CalendarSyncResult,
  CreateEventInput,
  UpdateEventInput,
} from "./types";
import { generateVEvent, parseVEvent, expandVEvents, isBusyFreeGhostStub } from "./icalHelper";
import { getAccount } from "@/services/db/accounts";
import { getCalendarByRemoteId } from "@/services/db/calendars";
import { getCalendarEventsInRangeForCalendars } from "@/services/db/calendarEvents";
import {
  listCalDavCalendars,
  fetchCalDavEvents,
  fetchCalDavCtag,
  putCalDavObject,
  getCalDavObject,
  deleteCalDavObject,
  resolveCalDavUrl,
} from "./caldavHttp";

export class CalDAVProvider implements CalendarProvider {
  readonly type: CalendarProviderType = "caldav";

  constructor(readonly accountId: string) {}

  /** Resolve CalDAV credentials + base URL, or throw if not configured. */
  private async getCreds(): Promise<{ username: string; password: string; baseUrl: string }> {
    const account = await getAccount(this.accountId);
    if (!account?.caldav_url || !account.caldav_password) {
      throw new Error("CalDAV credentials not configured");
    }
    return {
      username: account.caldav_username ?? account.email,
      password: account.caldav_password,
      baseUrl: account.caldav_url,
    };
  }

  async listCalendars(): Promise<CalendarInfo[]> {
    const account = await getAccount(this.accountId);
    if (!account?.caldav_url || !account.caldav_password) {
      throw new Error("CalDAV credentials not configured");
    }
    const username = account.caldav_username ?? account.email;
    // Uses Tauri's plugin-http fetch (bypasses WebKit CORS for PROPFIND)
    return listCalDavCalendars(account.caldav_url, username, account.caldav_password);
  }

  async fetchEvents(calendarRemoteId: string, timeMin: string, timeMax: string): Promise<CalendarEventData[]> {
    const account = await getAccount(this.accountId);
    if (!account?.caldav_url || !account.caldav_password) throw new Error("CalDAV credentials not configured");
    const username = account.caldav_username ?? account.email;

    const objects = await fetchCalDavEvents(calendarRemoteId, username, account.caldav_password, timeMin, timeMax);
    const rangeStartTs = Math.floor(new Date(timeMin).getTime() / 1000);
    const rangeEndTs = Math.floor(new Date(timeMax).getTime() / 1000);
    const debug = (globalThis as { __MELO_CALDAV_DEBUG__?: boolean }).__MELO_CALDAV_DEBUG__;
    if (debug) {
      console.log("[caldav] fetchEvents response", {
        calendarRemoteId,
        timeMin,
        timeMax,
        objectCount: objects.length,
      });
    }
    const allEvents: CalendarEventData[] = [];
    for (const obj of objects) {
      if (debug && /RRULE/i.test(obj.icalData)) {
        console.log("[caldav] raw iCal with RRULE", { url: obj.url, icalData: obj.icalData });
      }
      const events = expandVEvents(obj.icalData, obj.url, rangeStartTs, rangeEndTs);
      for (const event of events) {
        event.etag = obj.etag;
        allEvents.push(event);
      }
    }
    if (debug) console.log("[caldav] fetchEvents total events after expansion", allEvents.length);
    return allEvents;
  }

  async createEvent(calendarRemoteId: string, event: CreateEventInput): Promise<CalendarEventData> {
    const { username, password } = await this.getCreds();
    const uid = crypto.randomUUID();
    const icalData = generateVEvent(event, uid);
    const objectUrl = `${calendarRemoteId}${uid}.ics`;

    const { etag } = await putCalDavObject(objectUrl, username, password, icalData, { ifNoneMatch: true });

    const parsed = parseVEvent(icalData, objectUrl);
    parsed.etag = etag ?? parsed.etag;
    return parsed;
  }

  async updateEvent(
    _calendarRemoteId: string,
    remoteEventId: string,
    event: UpdateEventInput,
    etag?: string,
  ): Promise<CalendarEventData> {
    const { username, password, baseUrl } = await this.getCreds();
    const objectUrl = resolveCalDavUrl(remoteEventId, baseUrl);

    // Fetch the existing object to merge updates onto its current data
    const existing = await getCalDavObject(objectUrl, username, password);
    if (!existing) throw new Error("Event not found on server");

    const parsed = parseVEvent(existing.icalData, remoteEventId);
    const merged: CreateEventInput = {
      summary: event.summary ?? parsed.summary ?? "",
      description: event.description ?? parsed.description ?? undefined,
      location: event.location ?? parsed.location ?? undefined,
      startTime: event.startTime ?? new Date(parsed.startTime * 1000).toISOString(),
      endTime: event.endTime ?? new Date(parsed.endTime * 1000).toISOString(),
      isAllDay: event.isAllDay ?? parsed.isAllDay,
    };

    const icalData = generateVEvent(merged, parsed.uid ?? undefined);
    const { etag: newEtag } = await putCalDavObject(objectUrl, username, password, icalData, {
      ifMatch: etag ?? existing.etag ?? undefined,
    });

    const result = parseVEvent(icalData, remoteEventId);
    result.etag = newEtag ?? result.etag;
    return result;
  }

  async deleteEvent(_calendarRemoteId: string, remoteEventId: string, etag?: string): Promise<void> {
    const { username, password, baseUrl } = await this.getCreds();
    const objectUrl = resolveCalDavUrl(remoteEventId, baseUrl);
    await deleteCalDavObject(objectUrl, username, password, etag);
  }

  async syncEvents(calendarRemoteId: string, _syncToken?: string): Promise<CalendarSyncResult> {
    const account = await getAccount(this.accountId);
    if (!account?.caldav_url || !account.caldav_password) throw new Error("CalDAV credentials not configured");
    const username = account.caldav_username ?? account.email;

    // CTag-based change detection: the collection tag changes whenever any event
    // is added/modified/removed. If it's unchanged since the last sync, nothing
    // changed and we can skip the full re-fetch (and, crucially, the deletion
    // reconciliation — returning empty deletedRemoteIds so nothing is removed).
    const storedCal = await getCalendarByRemoteId(this.accountId, calendarRemoteId);
    const freshCtag = await fetchCalDavCtag(calendarRemoteId, username, account.caldav_password).catch(() => null);
    if (freshCtag && storedCal?.ctag && freshCtag === storedCal.ctag) {
      return { created: [], updated: [], deletedRemoteIds: [], newSyncToken: null, newCtag: freshCtag };
    }

    const now = new Date();
    const timeMin = new Date(now);
    timeMin.setDate(timeMin.getDate() - 90);
    const timeMax = new Date(now);
    timeMax.setFullYear(timeMax.getFullYear() + 1);

    const objects = await fetchCalDavEvents(
      calendarRemoteId,
      username,
      account.caldav_password,
      timeMin.toISOString(),
      timeMax.toISOString(),
    );

    const rangeStartTs = Math.floor(timeMin.getTime() / 1000);
    const rangeEndTs = Math.floor(timeMax.getTime() / 1000);
    const created: CalendarEventData[] = [];
    for (const obj of objects) {
      // Skip Exchange's leftover "reminder-only" stubs from rescheduled/cancelled
      // meetings — see isBusyFreeGhostStub. Excluding them from `created` also means
      // they drop out of `serverIds` below, so any already-stored ghost row gets
      // swept up by the normal deletion reconciliation on this same sync.
      if (isBusyFreeGhostStub(obj.icalData)) continue;
      const events = expandVEvents(obj.icalData, obj.url, rangeStartTs, rangeEndTs);
      for (const event of events) {
        event.etag = obj.etag;
        created.push(event);
      }
    }

    // Deletion reconciliation: any event stored locally for this calendar within
    // the synced window that the server no longer returns has been deleted
    // remotely and must be removed. Scope strictly to the same window so past
    // events that merely aged out of the window are not wrongly deleted.
    // (getCalendarEventsInRangeForCalendars only returns rows with calendar_id in
    // the list, so email-invite rows — which have a null calendar_id — are never
    // touched here.)
    const deletedRemoteIds: string[] = [];
    if (storedCal) {
      const serverIds = new Set(created.map((e) => e.remoteEventId));
      const localEvents = await getCalendarEventsInRangeForCalendars(
        [storedCal.id],
        rangeStartTs,
        rangeEndTs,
      );
      for (const row of localEvents) {
        if (row.remote_event_id && !serverIds.has(row.remote_event_id)) {
          deletedRemoteIds.push(row.remote_event_id);
        }
      }
    }

    return { created, updated: [], deletedRemoteIds, newSyncToken: null, newCtag: freshCtag ?? null };
  }

  async testConnection(): Promise<{ success: boolean; message: string }> {
    try {
      const calendars = await this.listCalendars();
      return {
        success: true,
        message: `Connected — found ${calendars.length} calendar${calendars.length !== 1 ? "s" : ""}`,
      };
    } catch (err) {
      return { success: false, message: err instanceof Error ? err.message : "Connection failed" };
    }
  }
}

