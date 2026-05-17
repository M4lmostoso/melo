const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const APPLE_CAL_NS = "http://apple.com/ns/ical/";

async function tauriFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  const { fetch: f } = await import("@tauri-apps/plugin-http");
  return f(...args);
}

function b64(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

export async function listCalDavCalendars(
  url: string,
  username: string,
  password: string,
): Promise<Array<{ remoteId: string; displayName: string; color: string | null; isPrimary: boolean }>> {
  const response = await tauriFetch(url, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${b64(username, password)}`,
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/"><D:prop><D:resourcetype/><D:displayname/><A:calendar-color/></D:prop></D:propfind>`,
  });

  if (response.status !== 207 && !response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const doc = new DOMParser().parseFromString(await response.text(), "application/xml");
  const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));
  const calendars: Array<{ remoteId: string; displayName: string; color: string | null; isPrimary: boolean }> = [];

  for (const resp of responses) {
    const resourcetype = resp.getElementsByTagNameNS(DAV_NS, "resourcetype")[0];
    if (!resourcetype || resourcetype.getElementsByTagNameNS(CALDAV_NS, "calendar").length === 0) continue;

    const href = resp.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim();
    if (!href) continue;

    const displayName = resp.getElementsByTagNameNS(DAV_NS, "displayname")[0]?.textContent?.trim() || "Calendar";
    const rawColor = resp.getElementsByTagNameNS(APPLE_CAL_NS, "calendar-color")[0]?.textContent?.trim() ?? null;
    const color = rawColor ? rawColor.replace(/^(#[0-9A-Fa-f]{6})[0-9A-Fa-f]{2}$/, "$1") : null;
    const remoteId = href.startsWith("http") ? href : new URL(href, url).href;

    calendars.push({ remoteId, displayName, color, isPrimary: calendars.length === 0 });
  }

  return calendars;
}

// CalDAV time-range format: 20240101T000000Z
const fmtTs = (iso: string) =>
  new Date(iso).toISOString().replace(/[-:.]/g, "").replace(/(\d{8}T\d{6})\d{3}Z/, "$1Z");

export async function fetchCalDavEvents(
  calendarUrl: string,
  username: string,
  password: string,
  timeMin: string,
  timeMax: string,
): Promise<Array<{ url: string; etag: string | null; icalData: string }>> {
  const response = await tauriFetch(calendarUrl, {
    method: "REPORT",
    headers: {
      Authorization: `Basic ${b64(username, password)}`,
      Depth: "1",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:getetag/><C:calendar-data/></D:prop><C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${fmtTs(timeMin)}" end="${fmtTs(timeMax)}"/></C:comp-filter></C:comp-filter></C:filter></C:calendar-query>`,
  });

  if (response.status !== 207 && !response.ok) {
    throw new Error(`Server returned ${response.status}`);
  }

  const doc = new DOMParser().parseFromString(await response.text(), "application/xml");
  const responses = Array.from(doc.getElementsByTagNameNS(DAV_NS, "response"));
  const events: Array<{ url: string; etag: string | null; icalData: string }> = [];

  for (const resp of responses) {
    const href = resp.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim();
    if (!href) continue;
    const etag = resp.getElementsByTagNameNS(DAV_NS, "getetag")[0]?.textContent?.trim() ?? null;
    const icalData = resp.getElementsByTagNameNS(CALDAV_NS, "calendar-data")[0]?.textContent?.trim();
    if (!icalData) continue;
    events.push({ url: href, etag, icalData });
  }

  return events;
}
