import { useState, type ReactNode } from "react";
import {
  DndContext,
  PointerSensor,
  useSensor,
  useSensors,
  DragOverlay,
  pointerWithin,
  MeasuringStrategy,
  type DragStartEvent,
  type DragEndEvent,
} from "@dnd-kit/core";

// Custom PointerSensor that ignores right-clicks (button !== 0).
// Without this, dnd-kit calls setPointerCapture on right-click which
// prevents the subsequent contextmenu event from firing in WebKit.
class LeftClickPointerSensor extends PointerSensor {
  static activators = [
    {
      eventName: "onPointerDown" as const,
      handler: ({ nativeEvent }: { nativeEvent: PointerEvent }) => {
        return nativeEvent.button === 0;
      },
    },
  ];
}
import { useThreadStore } from "@/stores/threadStore";
import { useAccountStore } from "@/stores/accountStore";
import { addThreadLabel, removeThreadLabel } from "@/services/emailActions";
import { crossAccountMoveThreads } from "@/services/crossAccountMove";

// Map sidebar IDs to Gmail label IDs (same as EmailList)
const LABEL_MAP: Record<string, string> = {
  inbox: "INBOX",
  starred: "STARRED",
  sent: "SENT",
  drafts: "DRAFT",
  trash: "TRASH",
  spam: "SPAM",
  snoozed: "SNOOZED",
  all: "",
};

export interface DragData {
  threadIds: string[];
  sourceLabel: string;
  sourceAccountId: string;
}

/** Prefix used to encode cross-account droppable IDs: "xacc:{accountId}:{labelId}" */
export const XACC_PREFIX = "xacc:";

/**
 * Determine which Gmail labels to add/remove when moving threads between labels.
 * Returns null if no change should be made (same label, or invalid).
 */
export function resolveLabelChange(
  targetSidebarId: string,
  sourceLabel: string,
): { addLabelIds: string[]; removeLabelIds: string[] } | null {
  const targetGmailId = LABEL_MAP[targetSidebarId] ?? targetSidebarId;
  const sourceGmailId = LABEL_MAP[sourceLabel] ?? sourceLabel;

  // No-op if same label
  if (targetGmailId === sourceGmailId) return null;

  // Dragging to trash: add TRASH, remove source (if specific)
  if (targetGmailId === "TRASH") {
    const removeLabelIds = sourceGmailId && sourceGmailId !== "" ? [sourceGmailId] : [];
    return { addLabelIds: ["TRASH"], removeLabelIds };
  }

  // Dragging from "all mail": only add target (don't remove anything)
  if (sourceLabel === "all" || sourceGmailId === "") {
    if (!targetGmailId) return null;
    return { addLabelIds: [targetGmailId], removeLabelIds: [] };
  }

  // Normal case: add target, remove source
  if (!targetGmailId) return null;
  return { addLabelIds: [targetGmailId], removeLabelIds: [sourceGmailId] };
}

interface DndProviderProps {
  children: ReactNode;
}

export function DndProvider({ children }: DndProviderProps) {
  const [dragData, setDragData] = useState<DragData | null>(null);
  const removeThreads = useThreadStore((s) => s.removeThreads);
  const activeAccountId = useAccountStore((s) => s.activeAccountId);

  const sensors = useSensors(
    useSensor(LeftClickPointerSensor, {
      activationConstraint: { distance: 8 },
    }),
  );

  const handleDragStart = (event: DragStartEvent) => {
    const data = event.active.data.current as DragData | undefined;
    if (data) {
      setDragData(data);
    }
  };

  const handleDragEnd = async (event: DragEndEvent) => {
    const { over } = event;
    setDragData(null);

    if (!over || !dragData) return;

    const rawId = over.id as string;

    // ── Cross-account drop ────────────────────────────────────────────────────
    if (rawId.startsWith(XACC_PREFIX)) {
      const withoutPrefix = rawId.slice(XACC_PREFIX.length);
      const colonIdx = withoutPrefix.indexOf(":");
      const targetAccountId = withoutPrefix.slice(0, colonIdx);
      const targetFolderKey = withoutPrefix.slice(colonIdx + 1); // "inbox","trash","sent",…

      if (targetAccountId && targetAccountId !== dragData.sourceAccountId) {
        try {
          await crossAccountMoveThreads(
            dragData.sourceAccountId,
            targetAccountId,
            dragData.threadIds,
            targetFolderKey,
          );
          removeThreads(dragData.threadIds);
        } catch (err) {
          console.error("Cross-account move failed:", err);
        }
        return;
      }
    }

    // ── Same-account drop (existing logic) ────────────────────────────────────
    const sourceAccountId = dragData.sourceAccountId || activeAccountId;
    if (!sourceAccountId) return;

    const targetLabel = rawId.startsWith(XACC_PREFIX)
      ? rawId.slice(XACC_PREFIX.length).replace(/^[^:]+:/, "")
      : rawId;

    const change = resolveLabelChange(targetLabel, dragData.sourceLabel);
    if (!change) return;

    try {
      for (const threadId of dragData.threadIds) {
        for (const labelId of change.addLabelIds) {
          await addThreadLabel(sourceAccountId, threadId, labelId);
        }
        for (const labelId of change.removeLabelIds) {
          await removeThreadLabel(sourceAccountId, threadId, labelId);
        }
      }
      removeThreads(dragData.threadIds);
    } catch (err) {
      console.error("Failed to move threads:", err);
    }
  };

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={pointerWithin}
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      {children}
      <DragOverlay dropAnimation={null}>
        {dragData && (
          <div className="bg-accent text-white text-sm font-medium px-3 py-1.5 rounded-lg shadow-lg pointer-events-none">
            {dragData.threadIds.length === 1
              ? "1 conversation"
              : `${dragData.threadIds.length} conversations`}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
