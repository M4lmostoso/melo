import { useParams } from "@tanstack/react-router";
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

type SettingsTab =
  | "general"
  | "notifications"
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

const tabs: { id: SettingsTab; label: string; icon: LucideIcon }[] = [
  { id: "general", label: "General", icon: Settings },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "composing", label: "Composing", icon: PenLine },
  { id: "mail-rules", label: "Mail Rules", icon: Filter },
  { id: "people", label: "People", icon: Users },
  { id: "accounts", label: "Accounts", icon: UserCircle },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "shortcuts", label: "Shortcuts", icon: Keyboard },
  { id: "ai", label: "AI", icon: Sparkles },
  { id: "intelligence", label: "Intelligence", icon: Brain },
  { id: "tasks", label: "Tasks", icon: CheckSquare },
  { id: "about", label: "About", icon: Info },
];

export function SettingsPage() {
  const { tab } = useParams({ strict: false }) as { tab?: string };
  const activeTab = (tab && tabs.some((t) => t.id === tab) ? tab : "general") as SettingsTab;
  const setActiveTab = (t: SettingsTab) => navigateToSettings(t);
  const activeTabDef = tabs.find((t) => t.id === activeTab);

  return (
    <div className="flex-1 flex flex-col min-w-0 overflow-hidden bg-bg-primary/50">
      {/* Header */}
      <div className="flex items-center gap-3 px-5 py-3 border-b border-border-primary shrink-0 bg-bg-primary/60 backdrop-blur-sm">
        <button
          onClick={() => navigateToLabel("inbox")}
          className="p-1.5 -ml-1 rounded-md text-text-secondary hover:text-text-primary hover:bg-bg-hover transition-colors"
          title="Back to Inbox"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-base font-semibold text-text-primary">Settings</h1>
      </div>

      {/* Body: sidebar nav + content */}
      <div className="flex flex-1 min-h-0">
        {/* Vertical tab sidebar */}
        <nav className="w-48 border-r border-border-primary py-2 overflow-y-auto shrink-0 bg-bg-primary/30">
          {tabs.map((tab) => {
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
        </nav>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto">
          <div className="max-w-2xl px-8 py-6">
            {activeTabDef && (
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-text-primary">{activeTabDef.label}</h2>
              </div>
            )}

            <div className="space-y-8">
              {activeTab === "general" && <GeneralTab />}
              {activeTab === "notifications" && <NotificationsTab />}
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
