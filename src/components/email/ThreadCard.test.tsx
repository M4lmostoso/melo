import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThreadCard } from "./ThreadCard";
import type { Thread } from "@/stores/threadStore";
import { useLabelStore, type Label } from "@/stores/labelStore";

vi.mock("@dnd-kit/core", () => ({
  useDraggable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: vi.fn(),
    isDragging: false,
  }),
}));

vi.mock("@/stores/threadStore", () => ({
  useThreadStore: Object.assign(
    (selector: (s: Record<string, unknown>) => unknown) =>
      selector({
        selectedThreadIds: new Set(),
        toggleThreadSelection: vi.fn(),
        selectThreadRange: vi.fn(),
      }),
    { getState: () => ({ selectedThreadIds: new Set() }) },
  ),
}));

const uiState: Record<string, unknown> = { emailDensity: "default", showThreadLabels: true };
vi.mock("@/stores/uiStore", () => ({
  useUIStore: (selector: (s: Record<string, unknown>) => unknown) => selector(uiState),
}));

vi.mock("@/hooks/useRouteNavigation", () => ({
  useActiveLabel: () => "inbox",
}));

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: "t1",
    accountId: "a1",
    subject: "Test subject",
    snippet: "Test snippet",
    lastMessageAt: Date.now(),
    messageCount: 1,
    isRead: false,
    isStarred: false,
    isPinned: false,
    isMuted: false,
    hasAttachments: false,
    labelIds: ["INBOX"],
    fromName: "Alice",
    fromAddress: "alice@example.com",
    ...overrides,
  };
}

describe("ThreadCard", () => {
  const onClick = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    uiState.emailDensity = "default";
    uiState.showThreadLabels = true;
    useLabelStore.setState({ allAccountLabels: {} });
  });

  it("renders sender name and subject", () => {
    render(<ThreadCard thread={makeThread()} isSelected={false} onClick={onClick} />);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Test subject")).toBeInTheDocument();
  });

  it("applies red background for spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["SPAM"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });

  it("does not apply red background for non-spam threads", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).not.toContain("bg-red-500");
  });

  it("applies red background for spam even when thread has other labels", () => {
    const { container } = render(
      <ThreadCard
        thread={makeThread({ labelIds: ["INBOX", "SPAM", "IMPORTANT"] })}
        isSelected={false}
        onClick={onClick}
      />,
    );
    const button = container.querySelector("button")!;
    expect(button.className).toContain("bg-red-500/8");
  });

  describe("label chips", () => {
    const label = (id: string, name: string): Label => ({
      id, accountId: "a1", name, type: "user", colorBg: "#ff0000", colorFg: "#ffffff", sortOrder: 0,
    });

    beforeEach(() => {
      useLabelStore.setState({
        allAccountLabels: {
          a1: [label("l1", "Fatture"), label("l2", "Lavoro"), label("l3", "Viaggi"), label("inbox", "Not shown")],
        },
      });
    });

    it("shows up to two user labels and a +N overflow, never the active view's label", () => {
      render(
        <ThreadCard
          thread={makeThread({ labelIds: ["INBOX", "l1", "l2", "l3", "inbox"] })}
          isSelected={false}
          onClick={onClick}
        />,
      );
      expect(screen.getByText("Fatture")).toBeInTheDocument();
      expect(screen.getByText("Lavoro")).toBeInTheDocument();
      expect(screen.queryByText("Viaggi")).not.toBeInTheDocument();
      expect(screen.getByText("+1")).toHaveAttribute("title", "Viaggi");
      expect(screen.queryByText("Not shown")).not.toBeInTheDocument();
    });

    it("shows nothing when the setting is off", () => {
      uiState.showThreadLabels = false;
      render(
        <ThreadCard thread={makeThread({ labelIds: ["INBOX", "l1"] })} isSelected={false} onClick={onClick} />,
      );
      expect(screen.queryByText("Fatture")).not.toBeInTheDocument();
    });

    it("shows only the leaf of a nested label, full path in the tooltip", () => {
      useLabelStore.setState({ allAccountLabels: { a1: [label("n1", "Progetti / PJ2610")] } });
      render(
        <ThreadCard thread={makeThread({ labelIds: ["INBOX", "n1"] })} isSelected={false} onClick={onClick} />,
      );
      expect(screen.getByText("PJ2610")).toHaveAttribute("title", "Progetti / PJ2610");
    });
  });
});
