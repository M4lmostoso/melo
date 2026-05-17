import { useState, useEffect, useCallback } from "react";
import { useUIStore } from "@/stores/uiStore";
import { getSetting, setSetting } from "@/services/db/settings";
import { COLOR_THEMES } from "@/constants/themes";
import { ALL_NAV_ITEMS } from "@/components/layout/Sidebar";
import type { SidebarNavItem } from "@/stores/uiStore";
import { Check, ChevronUp, ChevronDown, RotateCcw } from "lucide-react";
import { Section, SettingRow, ToggleRow } from "./shared";
import { Button } from "@/components/ui/Button";

function SidebarNavEditor() {
  const sidebarNavConfig = useUIStore((s) => s.sidebarNavConfig);
  const setSidebarNavConfig = useUIStore((s) => s.setSidebarNavConfig);

  const items: SidebarNavItem[] = (() => {
    if (!sidebarNavConfig) return ALL_NAV_ITEMS.map((i) => ({ id: i.id, visible: true }));
    const savedIds = new Set(sidebarNavConfig.map((i) => i.id));
    const missing = ALL_NAV_ITEMS.filter((i) => !savedIds.has(i.id)).map((i) => ({ id: i.id, visible: true }));
    return [...sidebarNavConfig, ...missing];
  })();
  const navLookup = new Map(ALL_NAV_ITEMS.map((n) => [n.id, n]));

  const moveItem = (index: number, direction: -1 | 1) => {
    const next = [...items];
    const target = index + direction;
    if (target < 0 || target >= next.length) return;
    const a = next[index];
    const b = next[target];
    if (!a || !b) return;
    next[index] = b;
    next[target] = a;
    setSidebarNavConfig(next);
  };

  const toggleItem = (index: number) => {
    const next = [...items];
    const current = next[index];
    if (!current || current.id === "inbox") return;
    next[index] = { ...current, visible: !current.visible };
    setSidebarNavConfig(next);
  };

  const resetToDefaults = () => {
    setSidebarNavConfig(ALL_NAV_ITEMS.map((i) => ({ id: i.id, visible: true })));
  };

  const isDefault =
    !sidebarNavConfig ||
    (items.length === ALL_NAV_ITEMS.length &&
      items.every((item, i) => item.id === ALL_NAV_ITEMS[i]?.id && item.visible));

  return (
    <Section title="Sidebar">
      <div className="space-y-1">
        {items.map((item, index) => {
          const nav = navLookup.get(item.id);
          if (!nav) return null;
          const Icon = nav.icon;
          const isInbox = item.id === "inbox";
          return (
            <div
              key={item.id}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors ${
                item.visible ? "text-text-primary" : "text-text-tertiary"
              }`}
            >
              <button
                onClick={() => moveItem(index, -1)}
                disabled={index === 0}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                title="Move up"
              >
                <ChevronUp size={14} />
              </button>
              <button
                onClick={() => moveItem(index, 1)}
                disabled={index === items.length - 1}
                className="p-0.5 rounded text-text-tertiary hover:text-text-primary disabled:opacity-25 disabled:cursor-not-allowed transition-colors"
                title="Move down"
              >
                <ChevronDown size={14} />
              </button>
              <Icon size={16} className="shrink-0 ml-1" />
              <span className="flex-1 truncate">{nav.label}</span>
              <button
                onClick={() => toggleItem(index)}
                disabled={isInbox}
                className={`relative w-10 h-5 rounded-full transition-colors shrink-0 ${
                  isInbox
                    ? "bg-accent/40 cursor-not-allowed"
                    : item.visible
                      ? "bg-accent cursor-pointer"
                      : "bg-bg-tertiary cursor-pointer"
                }`}
                title={isInbox ? "Inbox is always visible" : item.visible ? "Hide" : "Show"}
              >
                <span
                  className={`absolute top-0.5 left-0.5 w-4 h-4 bg-white rounded-full shadow transition-transform ${
                    item.visible ? "translate-x-5" : ""
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
      {!isDefault && (
        <button
          onClick={resetToDefaults}
          className="flex items-center gap-1.5 text-xs text-accent hover:text-accent-hover mt-2 transition-colors"
        >
          <RotateCcw size={12} />
          Reset to defaults
        </button>
      )}
    </Section>
  );
}

export function GeneralTab() {
  const theme = useUIStore((s) => s.theme);
  const setTheme = useUIStore((s) => s.setTheme);
  const readingPanePosition = useUIStore((s) => s.readingPanePosition);
  const setReadingPanePosition = useUIStore((s) => s.setReadingPanePosition);
  const emailDensity = useUIStore((s) => s.emailDensity);
  const setEmailDensity = useUIStore((s) => s.setEmailDensity);
  const fontScale = useUIStore((s) => s.fontScale);
  const setFontScale = useUIStore((s) => s.setFontScale);
  const colorTheme = useUIStore((s) => s.colorTheme);
  const setColorTheme = useUIStore((s) => s.setColorTheme);
  const inboxViewMode = useUIStore((s) => s.inboxViewMode);
  const setInboxViewMode = useUIStore((s) => s.setInboxViewMode);
  const backgroundMode = useUIStore((s) => s.backgroundMode);
  const setBackgroundMode = useUIStore((s) => s.setBackgroundMode);

  const [blockRemoteImages, setBlockRemoteImages] = useState(true);
  const [phishingDetectionEnabled, setPhishingDetectionEnabled] = useState(true);
  const [phishingSensitivity, setPhishingSensitivity] = useState<"low" | "default" | "high">("default");
  const [autostartEnabled, setAutostartEnabled] = useState(false);
  const [cacheMaxMb, setCacheMaxMb] = useState("500");
  const [cacheSizeMb, setCacheSizeMb] = useState<number | null>(null);
  const [clearingCache, setClearingCache] = useState(false);

  useEffect(() => {
    async function load() {
      const blockImg = await getSetting("block_remote_images");
      setBlockRemoteImages(blockImg !== "false");
      const phishingEnabled = await getSetting("phishing_detection_enabled");
      setPhishingDetectionEnabled(phishingEnabled !== "false");
      const phishingSens = await getSetting("phishing_sensitivity");
      if (phishingSens === "low" || phishingSens === "high") setPhishingSensitivity(phishingSens);

      try {
        const { isEnabled } = await import("@tauri-apps/plugin-autostart");
        setAutostartEnabled(await isEnabled());
      } catch {
        // autostart plugin may not be available in dev
      }

      const cacheMax = await getSetting("attachment_cache_max_mb");
      setCacheMaxMb(cacheMax ?? "500");
      try {
        const { getCacheSize } = await import("@/services/attachments/cacheManager");
        const size = await getCacheSize();
        setCacheSizeMb(Math.round((size / (1024 * 1024)) * 10) / 10);
      } catch {
        // cache manager may not be available
      }
    }
    load();
  }, []);

  const handleAutostartToggle = useCallback(async () => {
    try {
      const { enable, disable } = await import("@tauri-apps/plugin-autostart");
      if (autostartEnabled) {
        await disable();
      } else {
        await enable();
      }
      setAutostartEnabled(!autostartEnabled);
    } catch (err) {
      console.error("Failed to toggle autostart:", err);
    }
  }, [autostartEnabled]);

  return (
    <>
      <Section title="Appearance">
        <SettingRow label="Theme">
          <select
            value={theme}
            onChange={(e) => {
              const val = e.target.value as "light" | "dark" | "system";
              setTheme(val);
              setSetting("theme", val);
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="system">System</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
        </SettingRow>
        <SettingRow label="Reading pane">
          <select
            value={readingPanePosition}
            onChange={(e) => {
              setReadingPanePosition(e.target.value as "right" | "bottom" | "hidden");
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="right">Right</option>
            <option value="bottom">Bottom</option>
            <option value="hidden">Off</option>
          </select>
        </SettingRow>
        <SettingRow label="Email density">
          <select
            value={emailDensity}
            onChange={(e) => {
              setEmailDensity(e.target.value as "compact" | "default" | "spacious");
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="compact">Compact</option>
            <option value="default">Default</option>
            <option value="spacious">Spacious</option>
          </select>
        </SettingRow>
        <SettingRow label="Font size">
          <select
            value={fontScale}
            onChange={(e) => {
              setFontScale(e.target.value as "small" | "default" | "large" | "xlarge");
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="small">Small</option>
            <option value="default">Default</option>
            <option value="large">Large</option>
            <option value="xlarge">Extra Large</option>
          </select>
        </SettingRow>
        <SettingRow label="Accent color">
          <div className="flex items-center gap-2">
            {COLOR_THEMES.map((t) => {
              const isSelected = colorTheme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setColorTheme(t.id)}
                  title={t.name}
                  className={`relative w-7 h-7 rounded-full transition-all ${
                    isSelected
                      ? "ring-2 ring-offset-2 ring-offset-bg-primary scale-110"
                      : "hover:scale-105"
                  }`}
                  style={{
                    backgroundColor: t.swatch,
                    boxShadow: isSelected
                      ? `0 0 0 2px var(--color-bg-primary), 0 0 0 4px ${t.swatch}`
                      : undefined,
                  }}
                >
                  {isSelected && (
                    <Check size={14} className="absolute inset-0 m-auto text-white drop-shadow-sm" />
                  )}
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow label="Inbox view mode">
          <select
            value={inboxViewMode}
            onChange={(e) => {
              setInboxViewMode(e.target.value as "unified" | "split");
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="unified">Unified</option>
            <option value="split">Split (Categories)</option>
          </select>
        </SettingRow>
        <SettingRow label="Background style">
          <select
            value={backgroundMode}
            onChange={(e) => setBackgroundMode(e.target.value as "flat" | "aurora" | "spotlight")}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="flat">Flat (no animation)</option>
            <option value="aurora">Aurora (subtle glow)</option>
            <option value="spotlight">Spotlight (follows cursor)</option>
          </select>
        </SettingRow>
      </Section>

      <SidebarNavEditor />

      <Section title="Startup">
        <ToggleRow
          label="Launch at login"
          description="Start Melo automatically when you log in (minimized to tray)"
          checked={autostartEnabled}
          onToggle={handleAutostartToggle}
        />
      </Section>

      <Section title="Privacy & Security">
        <ToggleRow
          label="Block remote images"
          description="Hides tracking pixels and remote images until you choose to load them"
          checked={blockRemoteImages}
          onToggle={async () => {
            const newVal = !blockRemoteImages;
            setBlockRemoteImages(newVal);
            await setSetting("block_remote_images", newVal ? "true" : "false");
          }}
        />
        <ToggleRow
          label="Phishing link detection"
          description="Scan message links for phishing indicators and show warnings"
          checked={phishingDetectionEnabled}
          onToggle={async () => {
            const newVal = !phishingDetectionEnabled;
            setPhishingDetectionEnabled(newVal);
            await setSetting("phishing_detection_enabled", newVal ? "true" : "false");
          }}
        />
        {phishingDetectionEnabled && (
          <SettingRow label="Detection sensitivity">
            <select
              value={phishingSensitivity}
              onChange={async (e) => {
                const val = e.target.value as "low" | "default" | "high";
                setPhishingSensitivity(val);
                await setSetting("phishing_sensitivity", val);
              }}
              className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
            >
              <option value="low">Low (fewer warnings)</option>
              <option value="default">Default</option>
              <option value="high">High (more warnings)</option>
            </select>
          </SettingRow>
        )}
      </Section>

      <Section title="Storage">
        <div className="flex items-center justify-between">
          <div>
            <span className="text-sm text-text-secondary">Attachment cache</span>
            <p className="text-xs text-text-tertiary mt-0.5">
              {cacheSizeMb !== null ? `${cacheSizeMb} MB used` : "Calculating..."}
            </p>
          </div>
          <Button
            variant="secondary"
            onClick={async () => {
              setClearingCache(true);
              try {
                const { clearAllCache } = await import("@/services/attachments/cacheManager");
                await clearAllCache();
                setCacheSizeMb(0);
              } catch (err) {
                console.error("Failed to clear cache:", err);
              } finally {
                setClearingCache(false);
              }
            }}
            disabled={clearingCache}
            className="bg-bg-tertiary text-text-primary border border-border-primary"
          >
            {clearingCache ? "Clearing..." : "Clear Cache"}
          </Button>
        </div>
        <SettingRow label="Max cache size">
          <select
            value={cacheMaxMb}
            onChange={async (e) => {
              const val = e.target.value;
              setCacheMaxMb(val);
              await setSetting("attachment_cache_max_mb", val);
            }}
            className="w-48 bg-bg-tertiary text-text-primary text-sm px-3 py-1.5 rounded-md border border-border-primary focus:border-accent outline-none"
          >
            <option value="100">100 MB</option>
            <option value="250">250 MB</option>
            <option value="500">500 MB</option>
            <option value="1000">1 GB</option>
            <option value="2000">2 GB</option>
          </select>
        </SettingRow>
      </Section>
    </>
  );
}
