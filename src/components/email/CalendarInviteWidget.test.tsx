import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { parseVEvent } from "@/services/calendar/icalHelper";
import type { DbAttachment } from "@/services/db/attachments";
import type { Account } from "@/stores/accountStore";

const loadInviteMock = vi.fn();
vi.mock("@/services/calendar/calendarInviteService", () => ({
  loadInvite: (...args: unknown[]) => loadInviteMock(...args),
  respondToInvite: vi.fn(),
}));

import { CalendarInviteWidget } from "./CalendarInviteWidget";

function replyIcs(attendee: string, summary = "Kickoff meeting"): string {
  return [
    "BEGIN:VCALENDAR",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    "UID:uid-1",
    `SUMMARY:${summary}`,
    "DTSTART:20261104T083000Z",
    "DTEND:20261104T150000Z",
    "ORGANIZER:mailto:marion@example.fr",
    attendee,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
}

function renderReply(ics: string) {
  loadInviteMock.mockResolvedValue({
    event: parseVEvent(ics),
    method: "REPLY",
    meetingUrl: null,
    rsvpStatus: null,
    icsText: ics,
  });
  return render(
    <CalendarInviteWidget
      attachment={{ id: "att-1" } as DbAttachment}
      messageId="msg-1"
      threadId="thread-1"
      account={{ id: "acc-1", email: "me@example.com" } as Account}
    />,
  );
}

describe("CalendarInviteWidget — METHOD:REPLY", () => {
  beforeEach(() => loadInviteMock.mockReset());

  it("shows our own acceptance instead of an empty message", async () => {
    renderReply(replyIcs("ATTENDEE;PARTSTAT=ACCEPTED;CN=Me:mailto:ME@example.com"));
    expect(await screen.findByText("You accepted this invitation")).toBeInTheDocument();
    expect(screen.getByText("Kickoff meeting")).toBeInTheDocument();
    expect(screen.queryByText("Accept")).not.toBeInTheDocument();
  });

  it("names the attendee when someone else replied", async () => {
    renderReply(replyIcs("ATTENDEE;PARTSTAT=DECLINED;CN=Jane Doe:mailto:jane@example.com"));
    expect(await screen.findByText("Jane Doe declined")).toBeInTheDocument();
  });

  it("falls back to a generic label when the PARTSTAT is unknown", async () => {
    renderReply(replyIcs("ATTENDEE;PARTSTAT=DELEGATED:mailto:jane@example.com"));
    expect(await screen.findByText("Response to invitation")).toBeInTheDocument();
  });

  it("strips the Exchange 'Accepted:' prefix from the event title", async () => {
    renderReply(replyIcs("ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com", "Accepted: Réunion de démarrage"));
    expect(await screen.findByText("Réunion de démarrage")).toBeInTheDocument();
  });
});
