import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DbCalendarEvent } from "../db/calendarEvents";

// --- Mocks ---
const mockGetUpcoming = vi.fn();
const mockMarkNotified = vi.fn();
const mockNotify = vi.fn();

vi.mock("../db/calendarEvents", () => ({
  getUpcomingEventsToNotify: (...args: unknown[]) => mockGetUpcoming(...args),
  markCalendarEventNotified: (...args: unknown[]) => mockMarkNotified(...args),
}));

vi.mock("../notifications/notificationManager", () => ({
  notifyUpcomingCalendarEvent: (...args: unknown[]) => mockNotify(...args),
}));

// Background checker: expose the registered checkFn so we can invoke it directly.
const checkerHolder = vi.hoisted(() => ({ fn: null as (() => Promise<void>) | null }));
vi.mock("../backgroundCheckers", () => ({
  createBackgroundChecker: (_name: string, checkFn: () => Promise<void>) => {
    checkerHolder.fn = checkFn;
    return { start: vi.fn(), stop: vi.fn() };
  },
}));

const NOW = 1_700_000_000;
vi.mock("@/utils/timestamp", () => ({
  getCurrentUnixTimestamp: () => NOW,
}));

// Importing the module registers the checker and captures checkFn.
import "./calendarReminderManager";

function makeEvent(overrides: Partial<DbCalendarEvent>): DbCalendarEvent {
  return {
    id: "evt-1",
    summary: "Standup",
    start_time: NOW + 5 * 60,
    is_all_day: 0,
    status: "confirmed",
    ical_data: null,
    location: null,
    description: null,
    last_notified_at: null,
    // remaining columns are not read by the reminder path
    ...overrides,
  } as unknown as DbCalendarEvent;
}

async function runCheck(): Promise<void> {
  expect(checkerHolder.fn).toBeTypeOf("function");
  await checkerHolder.fn!();
}

describe("calendarReminderManager — conference call reminder", () => {
  beforeEach(() => {
    mockGetUpcoming.mockReset();
    mockMarkNotified.mockReset();
    mockNotify.mockReset();
  });

  it("queries the [now+4min, now+6min] window", async () => {
    mockGetUpcoming.mockResolvedValue([]);
    await runCheck();
    expect(mockGetUpcoming).toHaveBeenCalledWith(NOW + 4 * 60, NOW + 6 * 60);
  });

  it("notifies with a meeting URL extracted from a Zoom link in the location", async () => {
    const url = "https://acme.zoom.us/j/123456789?pwd=abc";
    mockGetUpcoming.mockResolvedValue([
      makeEvent({ summary: "Sprint sync", location: url }),
    ]);
    await runCheck();
    expect(mockNotify).toHaveBeenCalledWith("Sprint sync", url);
    expect(mockMarkNotified).toHaveBeenCalledWith("evt-1", NOW);
  });

  it("extracts a Google Meet URL from the description when location has none", async () => {
    const url = "https://meet.google.com/abc-defg-hij";
    mockGetUpcoming.mockResolvedValue([
      makeEvent({ summary: "1:1", location: "Room A", description: `Join: ${url}` }),
    ]);
    await runCheck();
    expect(mockNotify).toHaveBeenCalledWith("1:1", url);
  });

  it("prefers ical_data for the meeting URL over location/description", async () => {
    const icalUrl = "https://teams.microsoft.com/l/meetup-join/xyz";
    mockGetUpcoming.mockResolvedValue([
      makeEvent({
        summary: "Planning",
        ical_data: `BEGIN:VEVENT\r\nLOCATION:${icalUrl}\r\nEND:VEVENT`,
        location: "https://other.zoom.us/j/999",
      }),
    ]);
    await runCheck();
    expect(mockNotify).toHaveBeenCalledWith("Planning", icalUrl);
  });

  it("notifies with null URL for an event with no conference link", async () => {
    mockGetUpcoming.mockResolvedValue([
      makeEvent({ summary: "Lunch", location: "Cafeteria" }),
    ]);
    await runCheck();
    expect(mockNotify).toHaveBeenCalledWith("Lunch", null);
  });

  it("falls back to a default summary when the event has none", async () => {
    mockGetUpcoming.mockResolvedValue([makeEvent({ summary: null })]);
    await runCheck();
    expect(mockNotify).toHaveBeenCalledWith("Event", null);
  });

  it("marks each event notified so it is not notified twice", async () => {
    mockGetUpcoming.mockResolvedValue([
      makeEvent({ id: "a", summary: "A" }),
      makeEvent({ id: "b", summary: "B" }),
    ]);
    await runCheck();
    expect(mockMarkNotified).toHaveBeenCalledWith("a", NOW);
    expect(mockMarkNotified).toHaveBeenCalledWith("b", NOW);
    expect(mockNotify).toHaveBeenCalledTimes(2);
  });
});
