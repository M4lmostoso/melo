/**
 * Minimal i18n engine.
 *
 * Usage:
 *   await loadLocale("en-US");       // once at app startup
 *   t("sidebar.nav.inbox")           // → "Inbox"
 *   t("threadView.messageCountPlural", { count: 3 }) // → "3 messages in this thread"
 *
 * Locale files live in public/locale/<locale>.json.
 * Add a new language by creating public/locale/<locale>.json and calling
 * loadLocale("<locale>") before rendering.
 *
 * IMPORTANT: Any UI change that adds, removes, or modifies a visible string
 * MUST also update public/locale/en-US.json (and all other locale files).
 * See docs/i18n.md for the full contribution guide.
 */

type Translations = Record<string, unknown>;

let _translations: Translations = {};
let _locale = "en-US";
let _loadPromise: Promise<void> | null = null;

/** Load a locale file from public/locale/<locale>.json. Call once at startup. */
export async function loadLocale(locale: string = "en-US"): Promise<void> {
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    try {
      const res = await fetch(`/locale/${locale}.json`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      _translations = (await res.json()) as Translations;
      _locale = locale;
    } catch (err) {
      console.error(`[i18n] Failed to load locale "${locale}":`, err);
      // Keep _translations empty — t() will return the key as fallback.
    }
  })();
  return _loadPromise;
}

function _get(obj: unknown, path: string[]): unknown {
  let cur = obj;
  for (const part of path) {
    if (typeof cur !== "object" || cur === null) return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

/**
 * Translate a dot-notation key, optionally interpolating `{param}` placeholders.
 *
 * Falls back to the key itself if not found.
 *
 * @example
 *   t("sidebar.nav.inbox")                          // "Inbox"
 *   t("threadView.messageCountPlural", { count: 5}) // "5 messages in this thread"
 */
export function t(key: string, params?: Record<string, string | number>): string {
  const value = _get(_translations, key.split("."));
  if (typeof value !== "string") return key;
  if (!params) return value;
  return value.replace(/\{(\w+)\}/g, (_, k) => String(params[k] ?? `{${k}}`));
}

/** Returns the currently active locale identifier (e.g. "en-US"). */
export function getCurrentLocale(): string {
  return _locale;
}

/**
 * Reset the i18n state (used in tests to reload a different locale).
 * @internal
 */
export function _resetForTesting(): void {
  _translations = {};
  _locale = "en-US";
  _loadPromise = null;
}
