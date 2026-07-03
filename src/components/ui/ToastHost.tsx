import { useEffect } from "react";
import { AlertCircle, AlertTriangle, Info, X } from "lucide-react";
import { useToastStore, type Toast } from "@/stores/toastStore";

const AUTO_DISMISS_MS = 8000;

const ICONS = {
  error: AlertCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const COLORS = {
  error: "border-danger/40 text-danger",
  warning: "border-warning/40 text-warning",
  info: "border-border-primary text-text-secondary",
} as const;

function ToastItem({ toast }: { toast: Toast }) {
  const dismissToast = useToastStore((s) => s.dismissToast);
  const Icon = ICONS[toast.kind];

  useEffect(() => {
    const timer = setTimeout(() => dismissToast(toast.id), AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [toast.id, dismissToast]);

  return (
    <div
      className={`glass-panel flex items-start gap-2 px-3 py-2.5 rounded-lg border shadow-lg max-w-sm ${COLORS[toast.kind]}`}
    >
      <Icon size={15} className="shrink-0 mt-0.5" />
      <span className="text-xs text-text-primary flex-1 break-words">{toast.message}</span>
      <button
        onClick={() => dismissToast(toast.id)}
        className="text-text-tertiary hover:text-text-primary shrink-0"
      >
        <X size={13} />
      </button>
    </div>
  );
}

/** Mounted once in App — renders the global toast stack (bottom-right). */
export function ToastHost() {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-4 right-4 z-[70] flex flex-col gap-2 items-end">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  );
}
