const DAV_NS = "DAV:";
const CALDAV_NS = "urn:ietf:params:xml:ns:caldav";
const APPLE_CAL_NS = "http://apple.com/ns/ical/";
const CALSERVER_NS = "http://calendarserver.org/ns/";

async function tauriFetch(...args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
  const { fetch: f } = await import("@tauri-apps/plugin-http");
  return f(...args);
}

function b64(username: string, password: string): string {
  return btoa(`${username}:${password}`);
}

function resolveHref(href: string, baseUrl: string): string {
  return href.startsWith("http") ? href : new URL(href, baseUrl).href;
}

/**
 * Resolve the calendar-home-set URL via the standard CalDAV discovery flow
 * (RFC 4791 §6.2.1): PROPFIND on base URL → current-user-principal →
 * calendar-home-set. Falls back to the original URL on any error.
 */
async function resolveCalendarHomeUrl(url: string, username: string, password: string): Promise<string> {
  const headers = {
    Authorization: `Basic ${b64(username, password)}`,
    Depth: "0",
    "Content-Type": "application/xml; charset=utf-8",
  };
  const body = `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav"><D:prop><D:current-user-principal/><C:calendar-home-set/></D:prop></D:propfind>`;

  try {
    const res = await tauriFetch(url, { method: "PROPFIND", headers, body });
    if (res.status !== 207 && !res.ok) return url;

    const doc = new DOMParser().parseFromString(await res.text(), "application/xml");

    // Some servers return calendar-home-set directly on the base URL
    const homeHref = doc.getElementsByTagNameNS(CALDAV_NS, "calendar-home-set")[0]
      ?.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim();
    if (homeHref) return resolveHref(homeHref, url);

    // Otherwise follow current-user-principal
    const principalHref = doc.getElementsByTagNameNS(DAV_NS, "current-user-principal")[0]
      ?.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim();
    if (!principalHref) return url;

    const principalUrl = resolveHref(principalHref, url);
    const principalRes = await tauriFetch(principalUrl, { method: "PROPFIND", headers, body });
    if (principalRes.status !== 207 && !principalRes.ok) return url;

    const principalDoc = new DOMParser().parseFromString(await principalRes.text(), "application/xml");
    const homeHref2 = principalDoc.getElementsByTagNameNS(CALDAV_NS, "calendar-home-set")[0]
      ?.getElementsByTagNameNS(DAV_NS, "href")[0]?.textContent?.trim();
    return homeHref2 ? resolveHref(homeHref2, url) : url;
  } catch {
    return url;
  }
}

export async function listCalDavCalendars(
  url: string,
  username: string,
  password: string,
): Promise<Array<{ remoteId: string; displayName: string; color: string | null; isPrimary: boolean }>> {
  const homeUrl = await resolveCalendarHomeUrl(url, username, password);

  const response = await tauriFetch(homeUrl, {
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
    const remoteId = resolveHref(href, homeUrl);

    calendars.push({ remoteId, displayName, color, isPrimary: calendars.length === 0 });
  }

  return calendars;
}

/**
 * Fetch the collection CTag (calendarserver.org `getctag`) for a calendar via
 * PROPFIND Depth 0. The CTag changes whenever any event in the collection is
 * added, modified, or removed — letting a sync skip a full re-fetch when nothing
 * changed. Returns null if the server doesn't expose a CTag or the request fails.
 */
export async function fetchCalDavCtag(
  calendarUrl: string,
  username: string,
  password: string,
): Promise<string | null> {
  const response = await tauriFetch(calendarUrl, {
    method: "PROPFIND",
    headers: {
      Authorization: `Basic ${b64(username, password)}`,
      Depth: "0",
      "Content-Type": "application/xml; charset=utf-8",
    },
    body: `<?xml version="1.0" encoding="utf-8"?><D:propfind xmlns:D="DAV:" xmlns:CS="http://calendarserver.org/ns/"><D:prop><CS:getctag/></D:prop></D:propfind>`,
  });

  if (response.status !== 207 && !response.ok) return null;

  const doc = new DOMParser().parseFromString(await response.text(), "application/xml");
  const ctag = doc.getElementsByTagNameNS(CALSERVER_NS, "getctag")[0]?.textContent?.trim();
  return ctag || null;
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
    // Note: we deliberately do NOT send <C:expand> — many CalDAV servers
    // (iCloud, Fastmail, Nextcloud) implement it inconsistently, sometimes
    // returning only the first instance of a recurring series. Instead we
    // fetch the master VEVENT (with RRULE intact) and run client-side
    // expansion in expandVEvents().
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

/** Resolve a possibly-relative CalDAV object href against the account's base URL. */
export function resolveCalDavUrl(href: string, baseUrl: string): string {
  return resolveHref(href, baseUrl);
}

/**
 * Create or replace a calendar object (RFC 4791 §5.3.2) via Tauri plugin-http.
 *
 * IMPORTANT: like the read helpers above, this deliberately goes through Rust
 * (plugin-http) rather than the WebKit `fetch`. A cross-origin PUT against
 * servers that send no `Access-Control-Allow-Origin` header (e.g. DavMail) is
 * blocked by the browser CORS preflight, so the tsdav `DAVClient` path silently
 * fails. Pass `ifNoneMatch` for creates, or `ifMatch` (ETag) for updates.
 */
export async function putCalDavObject(
  objectUrl: string,
  username: string,
  password: string,
  icalData: string,
  opts: { ifMatch?: string; ifNoneMatch?: boolean } = {},
): Promise<{ etag: string | null }> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${b64(username, password)}`,
    "Content-Type": "text/calendar; charset=utf-8",
  };
  if (opts.ifNoneMatch) headers["If-None-Match"] = "*";
  if (opts.ifMatch) headers["If-Match"] = opts.ifMatch;

  const response = await tauriFetch(objectUrl, { method: "PUT", headers, body: icalData });
  if (!response.ok) throw new Error(`CalDAV PUT failed: ${response.status}`);
  return { etag: response.headers.get("etag") };
}

/** Fetch a single calendar object's iCal data + ETag. Returns null on 404. */
export async function getCalDavObject(
  objectUrl: string,
  username: string,
  password: string,
): Promise<{ icalData: string; etag: string | null } | null> {
  const response = await tauriFetch(objectUrl, {
    method: "GET",
    headers: { Authorization: `Basic ${b64(username, password)}` },
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`CalDAV GET failed: ${response.status}`);
  return { icalData: await response.text(), etag: response.headers.get("etag") };
}

/** Delete a calendar object (RFC 4791). A 404 is treated as success (already gone). */
export async function deleteCalDavObject(
  objectUrl: string,
  username: string,
  password: string,
  etag?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    Authorization: `Basic ${b64(username, password)}`,
  };
  if (etag) headers["If-Match"] = etag;

  const response = await tauriFetch(objectUrl, { method: "DELETE", headers });
  if (!response.ok && response.status !== 404) {
    throw new Error(`CalDAV DELETE failed: ${response.status}`);
  }
}
