/**
 * Minimal i18n helper.
 *
 * Usage:
 *   import { t } from "@/i18n";
 *   t("sidebar.nav.inbox")                               // → "Inbox"
 *   t("threadView.messageCountPlural", { count: 5 })    // → "5 messages in this thread"
 *
 * Keys are nested paths (dot-separated) into public/locale/en-US.json.
 * Placeholders in values use {name} syntax and are replaced from the params object.
 */

// Import locale JSON directly — Vite resolves this at build-time.
import locale from "../public/locale/en-US.json";

function getNestedValue(obj: Record<string, unknown>, path: string): string | undefined {
  const parts = path.split(".");
  let current: unknown = obj;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === "string" ? current : undefined;
}

export function t(key: string, params?: Record<string, string | number>): string {
  const raw = getNestedValue(locale as Record<string, unknown>, key);
  if (raw === undefined) {
    // Fallback: return last segment of the key so UI stays readable in dev
    return key.split(".").pop() ?? key;
  }
  if (!params) return raw;
  return raw.replace(/\{(\w+)\}/g, (_, name) => {
    const val = params[name];
    return val !== undefined ? String(val) : `{${name}}`;
  });
}
