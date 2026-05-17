import { useState, useEffect, useCallback } from "react";
import { useAccountStore } from "@/stores/accountStore";
import { getSetting, setSetting } from "@/services/db/settings";
import { Section, ToggleRow } from "./shared";
import { Button } from "@/components/ui/Button";

export function NotificationsTab() {
  const accounts = useAccountStore((s) => s.accounts);

  const [notificationsEnabled, setNotificationsEnabled] = useState(true);
  const [smartNotifications, setSmartNotifications] = useState(true);
  const [notifyCategories, setNotifyCategories] = useState<Set<string>>(() => new Set(["Primary"]));
  const [vipSenders, setVipSenders] = useState<{ email_address: string; display_name: string | null }[]>([]);
  const [newVipEmail, setNewVipEmail] = useState("");

  useEffect(() => {
    async function load() {
      const notif = await getSetting("notifications_enabled");
      setNotificationsEnabled(notif !== "false");

      const smartNotif = await getSetting("smart_notifications");
      setSmartNotifications(smartNotif !== "false");

      const notifCats = await getSetting("notify_categories");
      if (notifCats) {
        setNotifyCategories(new Set(notifCats.split(",").map((s) => s.trim()).filter(Boolean)));
      }

      try {
        const { getAllVipSenders } = await import("@/services/db/notificationVips");
        const activeId = accounts.find((a) => a.isActive)?.id;
        if (activeId) {
          const vips = await getAllVipSenders(activeId);
          setVipSenders(vips.map((v) => ({ email_address: v.email_address, display_name: v.display_name })));
        }
      } catch {
        // VIP table may not exist yet
      }
    }
    load();
  }, [accounts]);

  const handleNotificationsToggle = useCallback(async () => {
    const newVal = !notificationsEnabled;
    setNotificationsEnabled(newVal);
    await setSetting("notifications_enabled", newVal ? "true" : "false");
  }, [notificationsEnabled]);

  return (
    <>
      <Section title="Notifications">
        <ToggleRow
          label="Enable notifications"
          checked={notificationsEnabled}
          onToggle={handleNotificationsToggle}
        />
        <ToggleRow
          label="Smart notifications"
          description="Only notify for selected categories and VIP senders"
          checked={smartNotifications}
          onToggle={async () => {
            const newVal = !smartNotifications;
            setSmartNotifications(newVal);
            await setSetting("smart_notifications", newVal ? "true" : "false");
          }}
        />
      </Section>

      {smartNotifications && (
        <>
          <Section title="Category Filters">
            <div>
              <span className="text-sm text-text-secondary">Notify for categories</span>
              <div className="flex flex-wrap gap-2 mt-2">
                {(["Primary", "Updates", "Promotions", "Social", "Newsletters"] as const).map((cat) => (
                  <button
                    key={cat}
                    onClick={async () => {
                      const next = new Set(notifyCategories);
                      if (next.has(cat)) next.delete(cat);
                      else next.add(cat);
                      setNotifyCategories(next);
                      await setSetting("notify_categories", [...next].join(","));
                    }}
                    className={`px-2.5 py-1 text-xs rounded-full transition-colors border ${
                      notifyCategories.has(cat)
                        ? "bg-accent/15 text-accent border-accent/30"
                        : "bg-bg-tertiary text-text-tertiary border-border-primary hover:text-text-primary"
                    }`}
                  >
                    {cat}
                  </button>
                ))}
              </div>
            </div>
          </Section>

          <Section title="VIP Senders">
            <p className="text-xs text-text-tertiary mb-2">
              These senders always trigger notifications regardless of category
            </p>
            <div className="space-y-1.5">
              {vipSenders.map((vip) => (
                <div key={vip.email_address} className="flex items-center justify-between py-1.5 px-3 bg-bg-secondary rounded-md">
                  <span className="text-xs text-text-primary truncate">
                    {vip.display_name ? `${vip.display_name} (${vip.email_address})` : vip.email_address}
                  </span>
                  <button
                    onClick={async () => {
                      const activeId = accounts.find((a) => a.isActive)?.id;
                      if (!activeId) return;
                      const { removeVipSender } = await import("@/services/db/notificationVips");
                      await removeVipSender(activeId, vip.email_address);
                      setVipSenders((prev) => prev.filter((v) => v.email_address !== vip.email_address));
                    }}
                    className="text-xs text-danger hover:text-danger/80 ml-2 shrink-0"
                  >
                    Remove
                  </button>
                </div>
              ))}
            </div>
            <div className="flex gap-2 mt-2">
              <input
                type="email"
                value={newVipEmail}
                onChange={(e) => setNewVipEmail(e.target.value)}
                placeholder="email@example.com"
                className="flex-1 px-3 py-1.5 bg-bg-tertiary border border-border-primary rounded-md text-xs text-text-primary outline-none focus:border-accent"
                onKeyDown={async (e) => {
                  if (e.key !== "Enter" || !newVipEmail.trim()) return;
                  const activeId = accounts.find((a) => a.isActive)?.id;
                  if (!activeId) return;
                  const { addVipSender } = await import("@/services/db/notificationVips");
                  await addVipSender(activeId, newVipEmail.trim());
                  setVipSenders((prev) => [...prev, { email_address: newVipEmail.trim().toLowerCase(), display_name: null }]);
                  setNewVipEmail("");
                }}
              />
              <Button
                variant="primary"
                onClick={async () => {
                  if (!newVipEmail.trim()) return;
                  const activeId = accounts.find((a) => a.isActive)?.id;
                  if (!activeId) return;
                  const { addVipSender } = await import("@/services/db/notificationVips");
                  await addVipSender(activeId, newVipEmail.trim());
                  setVipSenders((prev) => [...prev, { email_address: newVipEmail.trim().toLowerCase(), display_name: null }]);
                  setNewVipEmail("");
                }}
                disabled={!newVipEmail.trim()}
              >
                Add
              </Button>
            </div>
          </Section>
        </>
      )}
    </>
  );
}
