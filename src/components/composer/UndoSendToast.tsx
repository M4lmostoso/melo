import { useRef, useState } from "react";
import { CSSTransition } from "react-transition-group";
import { t } from "@/i18n";
import { useComposerStore } from "@/stores/composerStore";
import { useOutgoingStore } from "@/stores/outgoingStore";
import { cancelUndoOperation } from "@/services/db/pendingOperations";

const TOO_LATE_DISMISS_MS = 3000;

export function UndoSendToast() {
  const {
    undoSendVisible,
    undoSendTimer,
    undoSendOpId,
    undoSendDelaySeconds,
    setUndoSendTimer,
    setUndoSendVisible,
    setUndoSendOpId,
    setIsSending,
    closeComposer,
  } = useComposerStore();
  const toastRef = useRef<HTMLDivElement>(null);
  const [tooLate, setTooLate] = useState(false);

  const finishUndo = () => {
    useOutgoingStore.getState().clearUndoEmails();
    setUndoSendVisible(false);
    setIsSending(false);
    closeComposer();
  };

  const handleUndo = async () => {
    if (tooLate) return;
    if (undoSendTimer) {
      clearTimeout(undoSendTimer);
      setUndoSendTimer(null);
    }
    // Remove the persisted undo-send row — but ONLY while it still sits in
    // status 'undo'. If the queue processor (or the fired timer) already
    // claimed it, the send is in flight: deleting the row then would break
    // the anti-loss invariant AND lie to the user about the cancellation.
    if (undoSendOpId) {
      setUndoSendOpId(null);
      let cancelled = false;
      try {
        cancelled = await cancelUndoOperation(undoSendOpId);
      } catch (err) {
        console.error("[UndoSendToast] Failed to cancel undo-send row:", err);
      }
      if (!cancelled) {
        // Too late — the send already started. Be honest instead of closing
        // silently as if the undo had worked.
        setTooLate(true);
        setTimeout(() => {
          setTooLate(false);
          finishUndo();
        }, TOO_LATE_DISMISS_MS);
        return;
      }
    }
    finishUndo();
  };

  return (
    <CSSTransition nodeRef={toastRef} in={undoSendVisible || tooLate} timeout={200} classNames="toast" unmountOnExit>
      <div ref={toastRef} className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-text-primary text-bg-primary rounded-lg shadow-lg overflow-hidden">
        <div className="px-4 py-2.5 flex items-center gap-3">
          {tooLate ? (
            <span className="text-sm">{t("composer.undoSend.tooLate")}</span>
          ) : (
            <>
              <span className="text-sm">{t("composer.undoSend.sending")}</span>
              <button
                onClick={() => void handleUndo()}
                className="text-sm font-medium text-accent hover:text-accent-hover underline"
              >
                {t("composer.undoSend.undo")}
              </button>
            </>
          )}
        </div>
        {!tooLate && (
          <div className="h-0.5 bg-white/20">
            <div
              className="h-full bg-accent rounded-full"
              style={{ animation: `countdownBar ${undoSendDelaySeconds}s linear forwards` }}
            />
          </div>
        )}
      </div>
    </CSSTransition>
  );
}
