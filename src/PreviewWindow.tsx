import { useEffect, useState } from "react";
import { AttachmentPreview } from "./components/email/AttachmentList";
import { useUIStore } from "./stores/uiStore";
import { useAccountStore } from "./stores/accountStore";
import { runMigrations } from "./services/db/migrations";
import { getAllAccounts } from "./services/db/accounts";
import { getSetting } from "./services/db/settings";
import { initializeClients } from "./services/gmail/tokenManager";
import { getAttachmentById, type DbAttachment } from "./services/db/attachments";
import { getThemeById, COLOR_THEMES } from "./constants/themes";
import type { ColorThemeId } from "./constants/themes";
import { FONT_FAMILY_STACKS } from "./constants/fonts";
import { t } from "./i18n";

const isMac = navigator.userAgent.includes("Macintosh");

function closeThisWindow(): void {
  import("@tauri-apps/api/window")
    .then(({ getCurrentWindow }) => getCurrentWindow().close())
    .catch(() => window.close());
}

/**
 * Dedicated attachment-preview window (Quick Look style), opened by
 * openAttachmentPreviewWindow() via the `?preview={attachmentDbId}` URL param.
 * Space (fresh press) or Escape closes the window — same toggle feel as the
 * old in-page modal, but the close now targets this ad-hoc window.
 */
export default function PreviewWindow() {
  const { setTheme, setFontScale, setAppFontFamily, setColorTheme } = useUIStore();
  const { setAccounts } = useAccountStore();
  const [attachment, setAttachment] = useState<DbAttachment | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const attachmentId = params.get("preview");

    async function init() {
      if (!attachmentId) {
        setError(t("email.attachmentList.previewNotFound"));
        setLoading(false);
        return;
      }
      try {
        await runMigrations();

        // Restore theme
        const savedTheme = await getSetting("theme");
        if (
          savedTheme === "light" ||
          savedTheme === "dark" ||
          savedTheme === "system"
        ) {
          setTheme(savedTheme);
        }

        // Restore font scale
        const savedFontScale = await getSetting("font_size");
        if (
          savedFontScale === "small" ||
          savedFontScale === "default" ||
          savedFontScale === "large" ||
          savedFontScale === "xlarge"
        ) {
          setFontScale(savedFontScale);
        }

        // Restore app font family
        const savedAppFont = await getSetting("app_font_family");
        if (savedAppFont && savedAppFont in FONT_FAMILY_STACKS) {
          setAppFontFamily(savedAppFont as keyof typeof FONT_FAMILY_STACKS);
        }

        // Restore color theme
        const savedColorTheme = await getSetting("color_theme");
        if (
          savedColorTheme &&
          COLOR_THEMES.some((t) => t.id === savedColorTheme)
        ) {
          setColorTheme(savedColorTheme as ColorThemeId);
        }

        // Accounts + Gmail clients: materializeAttachment fetches from the
        // server when the attachment isn't in the local cache yet.
        const dbAccounts = await getAllAccounts();
        setAccounts(
          dbAccounts.map((a) => ({
            id: a.id,
            email: a.email,
            displayName: a.display_name,
            avatarUrl: a.avatar_url,
            isActive: a.is_active === 1,
            provider: a.provider,
            color: a.color ?? null,
            includeInGlobal: a.include_in_global !== 0,
            sortOrder: a.sort_order ?? 0,
            label: a.label ?? null,
          })),
        );
        await initializeClients();

        const att = await getAttachmentById(attachmentId);
        if (!att) {
          setError(t("email.attachmentList.previewNotFound"));
          setLoading(false);
          return;
        }
        setAttachment(att);
      } catch (err) {
        console.error("Failed to initialize preview window:", err);
        setError(t("email.attachmentList.previewLoadFailed"));
      }
      setLoading(false);
    }

    init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store setters are stable references
  }, []);

  // Quick Look-style close: a fresh Space press (or Escape) closes this window.
  // The press that OPENED the preview happened in the main window, so unlike the
  // old modal there is no same-press self-close to disarm — but if the user is
  // still holding Space when focus shifts here, the OS-level auto-repeats may
  // arrive as fresh keydowns (this webview never saw the initial press, so
  // e.repeat can be false). Guard with a short arming delay besides e.repeat.
  useEffect(() => {
    const armedAt = Date.now() + 300;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== " " && e.key !== "Escape") return;
      e.preventDefault();
      if (e.repeat || Date.now() < armedAt) return;
      closeThisWindow();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // Sync theme class to <html>
  const theme = useUIStore((s) => s.theme);
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else if (theme === "light") {
      root.classList.remove("dark");
    } else {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      const apply = () => {
        if (mq.matches) root.classList.add("dark");
        else root.classList.remove("dark");
      };
      apply();
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [theme]);

  // Sync font-scale class to <html>
  const fontScale = useUIStore((s) => s.fontScale);
  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove(
      "font-scale-small",
      "font-scale-default",
      "font-scale-large",
      "font-scale-xlarge",
    );
    root.classList.add(`font-scale-${fontScale}`);
  }, [fontScale]);

  // Sync app font family to <html>
  const appFontFamily = useUIStore((s) => s.appFontFamily);
  useEffect(() => {
    document.documentElement.style.setProperty("--app-font", FONT_FAMILY_STACKS[appFontFamily]);
  }, [appFontFamily]);

  // Apply color theme CSS custom properties to <html>
  const colorTheme = useUIStore((s) => s.colorTheme);
  useEffect(() => {
    const root = document.documentElement;

    const apply = () => {
      const themeData = getThemeById(colorTheme);
      const isDark =
        theme === "dark" ||
        (theme === "system" &&
          window.matchMedia("(prefers-color-scheme: dark)").matches);
      const colors = isDark ? themeData.dark : themeData.light;
      root.style.setProperty("--color-accent", colors.accent);
      root.style.setProperty("--color-accent-hover", colors.accentHover);
      root.style.setProperty("--color-accent-light", colors.accentLight);
      root.style.setProperty("--color-bg-selected", colors.bgSelected);
      root.style.setProperty("--color-sidebar-active", colors.sidebarActive);
    };

    apply();

    if (theme === "system") {
      const mq = window.matchMedia("(prefers-color-scheme: dark)");
      mq.addEventListener("change", apply);
      return () => mq.removeEventListener("change", apply);
    }
  }, [colorTheme, theme]);

  return (
    <div className="flex flex-col h-screen bg-bg-primary text-text-primary">
      {/* macOS: reserve a draggable strip for the native traffic-light buttons,
          which the Overlay title bar draws over the top-left of the webview. */}
      {isMac && <div className="h-7 shrink-0" data-tauri-drag-region />}
      {loading && (
        <div className="flex-1 flex items-center justify-center text-text-secondary">
          <span className="text-sm">{t("email.attachmentList.loadingPreview")}</span>
        </div>
      )}
      {!loading && (error || !attachment) && (
        <div className="flex-1 flex items-center justify-center text-text-secondary">
          <span className="text-sm">{error ?? t("email.attachmentList.previewNotFound")}</span>
        </div>
      )}
      {!loading && !error && attachment && (
        <div className="flex-1 min-h-0">
          <AttachmentPreview
            attachment={attachment}
            onClose={closeThisWindow}
            windowed
          />
        </div>
      )}
    </div>
  );
}
