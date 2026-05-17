import { useState, useCallback, useEffect } from "react";
import { Loader2, CheckCircle2, XCircle } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { TextField } from "@/components/ui/TextField";
import { discoverCalDavSettings, testCalDavConnection, listCalDavCalendars } from "@/services/calendar/autoDiscovery";
import { updateAccountCalDav, type DbAccount } from "@/services/db/accounts";
import { removeCalendarProvider } from "@/services/calendar/providerFactory";
import { upsertCalendar, getCalendarsForAccount, updateCalendarUserMeta } from "@/services/db/calendars";

const CALENDAR_COLORS = [
  "#D50000", "#E67C73", "#F4511E", "#F6BF26",
  "#33B679", "#0B8043", "#039BE5", "#3F51B5",
  "#7986CB", "#8E24AA", "#616161",
];

interface CalDavSettingsProps {
  account: DbAccount;
  onSaved: () => void;
}

export function CalDavSettings({ account, onSaved }: CalDavSettingsProps) {
  const [caldavUrl, setCaldavUrl] = useState(account.caldav_url ?? "");
  const [username, setUsername] = useState(account.caldav_username ?? account.email);
  const [password, setPassword] = useState(account.caldav_password ?? "");
  const [label, setLabel] = useState("");
  const [color, setColor] = useState(CALENDAR_COLORS[7]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ success: boolean; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [discovered, setDiscovered] = useState(false);

  // Load existing user_label/user_color from the primary calendar (edit mode)
  useEffect(() => {
    if (!account.caldav_url) return;
    getCalendarsForAccount(account.id).then((cals) => {
      const primary = cals.find((c) => c.is_primary) ?? cals[0];
      if (primary) {
        setLabel(primary.user_label ?? "");
        setColor(primary.user_color ?? CALENDAR_COLORS[7]);
      }
    });
  }, [account.id, account.caldav_url]);

  // Auto-discover on mount if not already configured
  useEffect(() => {
    if (!account.caldav_url && !discovered) {
      setDiscovered(true);
      discoverCalDavSettings(account.email).then((result) => {
        if (result.caldavUrl) {
          setCaldavUrl(result.caldavUrl);
        }
      });
    }
  }, [account.email, account.caldav_url, discovered]);

  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    const result = await testCalDavConnection(caldavUrl, username, password);
    setTestResult(result);
    setTesting(false);
  }, [caldavUrl, username, password]);

  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      await updateAccountCalDav(account.id, {
        caldavUrl,
        caldavUsername: username,
        caldavPassword: password,
        calendarProvider: "caldav",
      });
      removeCalendarProvider(account.id);

      // Sync calendars from server (non-fatal if server unreachable)
      try {
        const providerCalendars = await listCalDavCalendars(caldavUrl, username, password);
        for (const cal of providerCalendars) {
          await upsertCalendar({
            accountId: account.id,
            provider: "caldav",
            remoteId: cal.remoteId,
            displayName: cal.displayName,
            color: cal.color,
            isPrimary: cal.isPrimary,
          });
        }
      } catch {
        // Non-fatal — calendars will sync when opening the calendar view
      }

      // Always persist user label/color — independent of server reachability
      try {
        const savedCals = await getCalendarsForAccount(account.id);
        for (const cal of savedCals) {
          await updateCalendarUserMeta(
            cal.id,
            (cal.is_primary && label.trim()) ? label.trim() : (cal.user_label ?? null),
            color || (cal.user_color ?? null),
          );
        }
      } catch (err) {
        console.error("Failed to save calendar user meta:", err);
      }

      onSaved();
    } catch (err) {
      console.error("Failed to save CalDAV settings:", err);
    } finally {
      setSaving(false);
    }
  }, [account.id, caldavUrl, username, password, label, color, onSaved]);

  const handleRemove = useCallback(async () => {
    setSaving(true);
    try {
      await updateAccountCalDav(account.id, {
        caldavUrl: "",
        caldavUsername: "",
        caldavPassword: "",
        calendarProvider: "",
      });
      removeCalendarProvider(account.id);
      setCaldavUrl("");
      setUsername(account.email);
      setPassword("");
      setTestResult(null);
      onSaved();
    } finally {
      setSaving(false);
    }
  }, [account.id, account.email, onSaved]);

  const isConfigured = !!account.caldav_url;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium text-text-primary">Calendar (CalDAV)</h4>
        {isConfigured && (
          <span className="text-xs text-success font-medium">Connected</span>
        )}
      </div>
      <p className="text-xs text-text-tertiary">
        Connect a CalDAV calendar server to enable calendar features for this IMAP account.
      </p>

      <TextField
        label="Label (optional)"
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        placeholder="e.g. Work Exchange"
      />

      <div className="space-y-1.5">
        <span className="text-xs font-medium text-text-secondary">Color</span>
        <div className="flex items-center gap-2 flex-wrap">
          {CALENDAR_COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className="w-6 h-6 rounded-full shrink-0 transition-transform hover:scale-110 focus:outline-none"
              style={{ backgroundColor: c, boxShadow: color === c ? `0 0 0 2px white, 0 0 0 3.5px ${c}` : undefined }}
              aria-label={c}
            />
          ))}
        </div>
      </div>

      <TextField
        label="CalDAV Server URL"
        type="url"
        value={caldavUrl}
        onChange={(e) => setCaldavUrl(e.target.value)}
        placeholder="https://caldav.example.com/"
      />

      <TextField
        label="Username"
        type="text"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        placeholder="your@email.com"
      />

      <TextField
        label="Password / App Password"
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="App-specific password"
      />

      {testResult && (
        <div className={`flex items-center gap-2 text-xs ${testResult.success ? "text-success" : "text-danger"}`}>
          {testResult.success ? <CheckCircle2 size={14} /> : <XCircle size={14} />}
          {testResult.message}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={handleTest}
          disabled={testing || !caldavUrl || !password}
        >
          {testing && <Loader2 size={14} className="animate-spin" />}
          {testing ? "Testing..." : "Test Connection"}
        </Button>

        <Button
          variant="primary"
          size="sm"
          onClick={handleSave}
          disabled={saving || !caldavUrl || !password}
        >
          {saving ? "Saving..." : "Save"}
        </Button>

        {isConfigured && (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleRemove}
            disabled={saving}
          >
            Remove
          </Button>
        )}
      </div>
    </div>
  );
}
