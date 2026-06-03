import { useParams } from "@tanstack/react-router";
import { t } from "@/i18n";
import { navigateToLabel, navigateToSettings } from "@/router/navigate";
import {
  ArrowLeft,
  Settings,
  Bell,
  PenLine,
  Filter,
  Users,
  UserCircle,
  CalendarDays,
  Keyboard,
  Sparkles,
  Brain,
  CheckSquare,
  Info,
  Volume2,
  type LucideIcon,
} from "lucide-react";
import { GeneralTab } from "./tabs/GeneralTab";
import { NotificationsTab } from "./tabs/NotificationsTab";
import { ComposingTab } from "./tabs/ComposingTab";
import { MailRulesTab } from "./tabs/MailRulesTab";
import { PeopleTab } from "./tabs/PeopleTab";
import { AccountsTab } from "./tabs/AccountsTab";
import { ShortcutsTab } from "./tabs/ShortcutsTab";
import { AITab } from "./tabs/AITab";
import { IntelligenceTab } from "./tabs/IntelligenceTab";
import { TasksTab } from "./tabs/TasksTab";
import { CalendarTab } from "./tabs/CalendarTab";
import { AboutTab } from "./tabs/AboutTab";
import { SoundsTab } from "./tabs/SoundsTab";

type SettingsTab =
  | "general"
  | "notifications"
  | "sounds"
  | "composing"
  | "mail-rules"
  | "people"
  | "accounts"
  | "calendar"
  | "shortcuts"
  | "ai"
  | "intelligence"
  | "tasks"
  | "about";

type TabDef = { id: SettingsTab; label: string; icon: LucideIcon };
type TabGroup = { label?: string; tabs: TabDef[] };

const tabGroups: TabGroup[] = [
  {
    tabs: [
      { id: "general", label: t("settings.tabs.general"), icon: Settings },
      { id: "notifications", label: t("settings.tabs.notifications"), icon: Bell },
      { id: "sounds", label: t("settings.tabs.sounds"), icon: Volume2 },
      { id: "composing", label: t("settings.tabs.composing"), icon: PenLine },
      { id: "mail-rules", label: t("settings.tabs.mailRules"), icon: Filter },
    ],
  },
  {
    label: t("settings.sidebar.accounts"),
    tabs: [
      { id: "accounts", label: t("settings.tabs.accounts"), icon: UserCircle },
      { id: "people", label: t("settings.tabs.people"), icon: Users },
      { id: "calendar", label: t("settings.tabs.calendar"), icon: CalendarDays },
    ],
  },
  {
    label: t("settings.sidebar.intelligence"),
    tabs: [
      { id: "ai", label: t("settings.tabs.ai"), icon: Sparkles },
      { id: "intelligence", label: t("settings.tabs.intelligence"), icon: Brain },
    ],
  },
  {
    label: t("settings.sidebar.tools"),
    tabs: [
      { id: "shortcuts", label: t("settings.tabs.shortcuts"), icon: Keyboard },
      { id: "tasks", label: t("settings.tabs.tasks"), icon: CheckSquare },
      { id: "about", label: t("settings.tabs.about"), icon: Info },
    ],
  },
];

const allTabs: TabDef[] = tabGroups.flatMap((g) => g.tabs);

export function SettingsPage() {
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const activeTab = (tab && allTabs.some((t) => t.id === tab) ? tab : "general") as SettingsTab;
  const setActiveTab = (t: SettingsTab) => navigateToSettings(t);
  const activeTabDef = allTabs.find((t) => t.id === activeTab);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg-primary/50">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-primary shrink-0 bg-bg-primary/60 backdrop-blur-sm">
        <button
          onClick={() => navigateToLabel("inbox")}
          className="p-1.5 -ml-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          title={t("settings.backToInbox")}
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-base font-semibold text-text-primary">{t("settings.title")}</h1>
      </div>

      {/* Body: sidebar nav + content */}
      <div className="flex flex-1 min-h-0">
        {/* Vertical tab sidebar */}
        <nav className="w-48 border-r border-border-primary py-3 overflow-y-auto shrink-0 bg-bg-primary/30">
          {tabGroups.map((group, gi) => (
            <div key={gi} className={gi > 0 ? "mt-1" : ""}>
              {group.label && (
                <div className="px-4 pt-3 pb-1">
                  <span className="text-[0.6875rem] font-semibold uppercase tracking-wider text-text-tertiary/70">
                    {group.label}
                  </span>
                </div>
              )}
              {group.tabs.map((tab) => {
                const Icon = tab.icon;
                const isActive = activeTab === tab.id;
                return (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`flex items-center gap-2.5 w-full px-4 py-2 text-[0.8125rem] transition-colors ${
                      isActive
                        ? "bg-bg-selected text-accent font-medium"
                        : "text-text-secondary hover:bg-bg-hover hover:text-text-primary"
                    }`}
                  >
                    <Icon size={15} className="shrink-0" />
                    {tab.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <div className="w-full px-8 py-6">
            {activeTabDef && (
              <div className="mb-6 flex items-center gap-3">
                <activeTabDef.icon size={20} className="text-accent shrink-0" />
                <h2 className="text-lg font-semibold text-text-primary">{activeTabDef.label}</h2>
              </div>
            )}

            <div className="space-y-4">
              {activeTab === "general" && <GeneralTab />}
              {activeTab === "notifications" && <NotificationsTab />}
              {activeTab === "sounds" && <SoundsTab />}
              {activeTab === "composing" && <ComposingTab />}
              {activeTab === "mail-rules" && <MailRulesTab />}
              {activeTab === "people" && <PeopleTab />}
              {activeTab === "accounts" && <AccountsTab />}
              {activeTab === "calendar" && <CalendarTab />}
              {activeTab === "shortcuts" && <ShortcutsTab />}
              {activeTab === "ai" && <AITab />}
              {activeTab === "intelligence" && <IntelligenceTab />}
              {activeTab === "tasks" && <TasksTab />}
              {activeTab === "about" && <AboutTab />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
