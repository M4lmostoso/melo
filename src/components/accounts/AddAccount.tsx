import { useState } from "react";
import { Mail, Calendar } from "lucide-react";
import { startOAuthFlow } from "@/services/gmail/auth";
import { insertAccount } from "@/services/db/accounts";
import { getClientId, getClientSecret } from "@/services/gmail/tokenManager";
import { useAccountStore } from "@/stores/accountStore";
import { Modal } from "@/components/ui/Modal";
import { SetupClientId } from "./SetupClientId";
import { AddImapAccount } from "./AddImapAccount";
import { AddCalDavAccount } from "./AddCalDavAccount";
import { getCurrentUnixTimestamp } from "@/utils/timestamp";
import { t } from "@/i18n";

interface AddAccountProps {
  onClose: () => void;
  onSuccess: () => void;
}

type View = "select-provider" | "gmail" | "icloud" | "imap" | "caldav";

export function AddAccount({ onClose, onSuccess }: AddAccountProps) {
  const [view, setView] = useState<View>("select-provider");
  const [status, setStatus] = useState<
    "idle" | "checking" | "authenticating" | "error"
  >("idle");
  const [error, setError] = useState<string | null>(null);
  const [needsSetup, setNeedsSetup] = useState(false);
  const addAccount = useAccountStore((s) => s.addAccount);

  const handleAddGmailAccount = async () => {
    setStatus("checking");
    setError(null);

    try {
      const clientId = await getClientId();
      const clientSecret = await getClientSecret();
      setStatus("authenticating");

      const { tokens, userInfo } = await startOAuthFlow(clientId, clientSecret);

      const accountId = crypto.randomUUID();
      const expiresAt = getCurrentUnixTimestamp() + tokens.expires_in;

      await insertAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token ?? "",
        tokenExpiresAt: expiresAt,
      });

      addAccount({
        id: accountId,
        email: userInfo.email,
        displayName: userInfo.name,
        avatarUrl: userInfo.picture,
        isActive: true,
        color: null,
        includeInGlobal: true,
        sortOrder: 0,
        label: null,
      });

      onSuccess();
    } catch (err) {
      console.error("Add account error:", err);
      const message =
        err instanceof Error ? err.message : String(err);
      if (message.includes("Client ID not configured")) {
        setNeedsSetup(true);
      } else {
        setError(message);
        setStatus("error");
      }
    }
  };

  if (needsSetup) {
    return (
      <SetupClientId
        onComplete={() => {
          setNeedsSetup(false);
          setStatus("idle");
        }}
        onCancel={onClose}
      />
    );
  }

  if (view === "caldav") {
    return (
      <AddCalDavAccount
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={() => setView("select-provider")}
      />
    );
  }

  if (view === "icloud") {
    return (
      <AddImapAccount
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={() => setView("select-provider")}
        providerPreset="icloud"
      />
    );
  }

  if (view === "imap") {
    return (
      <AddImapAccount
        onClose={onClose}
        onSuccess={onSuccess}
        onBack={() => setView("select-provider")}
      />
    );
  }

  if (view === "gmail") {
    return (
      <Modal isOpen={true} onClose={onClose} title={t("accounts.addAccount.titleGmail")} width="w-full max-w-md">
        <div className="p-4">
          <p className="text-text-secondary text-sm mb-6">
            {t("accounts.addAccount.connectGmailDesc")}
          </p>

          {error && (
            <div className="bg-danger/10 border border-danger/20 rounded-lg p-3 mb-4 text-sm text-danger">
              {error}
            </div>
          )}

          {status === "authenticating" && (
            <div className="text-center py-4 text-text-secondary text-sm">
              <div className="mb-2">{t("accounts.addAccount.waitingForSignIn")}</div>
              <div className="text-xs text-text-tertiary">
                {t("accounts.addAccount.completeSignInBrowser")}
              </div>
            </div>
          )}

          <div className="flex gap-3 justify-between">
            <button
              onClick={() => {
                setView("select-provider");
                setStatus("idle");
                setError(null);
              }}
              className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
            >
              {t("common.back")}
            </button>
            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
              >
                {t("common.cancel")}
              </button>
              <button
                onClick={handleAddGmailAccount}
                disabled={status === "authenticating" || status === "checking"}
                className="px-4 py-2 text-sm bg-accent text-white rounded-lg hover:bg-accent-hover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {status === "authenticating"
                  ? t("common.waiting")
                  : status === "checking"
                    ? t("common.checking")
                    : t("accounts.addAccount.signInWithGoogle")}
              </button>
            </div>
          </div>
        </div>
      </Modal>
    );
  }

  // Provider selection view
  return (
    <Modal isOpen={true} onClose={onClose} title={t("accounts.addAccount.title")} width="w-full max-w-md">
      <div className="p-4">
        <p className="text-text-secondary text-sm mb-4">
          {t("accounts.addAccount.chooseProvider")}
        </p>

        <div className="space-y-3">
          <button
            onClick={() => setView("gmail")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <svg className="w-5 h-5" viewBox="0 0 24 24">
                <path
                  d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"
                  fill="#4285F4"
                />
                <path
                  d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
                  fill="#34A853"
                />
                <path
                  d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
                  fill="#FBBC05"
                />
                <path
                  d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
                  fill="#EA4335"
                />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                {t("accounts.addAccount.googleGmail")}
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                {t("accounts.addAccount.googleGmailDesc")}
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("icloud")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <svg className="w-5 h-5 text-text-secondary" viewBox="0 0 814 1000" fill="currentColor">
                <path d="M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5-39.5-164-39.5c-76 0-103.7 40.8-165.9 40.8s-105-57.8-155.5-127.4C46 790.7 0 663.1 0 541.8c0-207.4 135.4-317 269-317 70.1 0 128.4 46.4 172.5 46.4 42.8 0 109.6-49 192.5-49 31.2 0 108.2 2.6 168.1 75.5zm-234.5-161.4c31.9-38.1 54.4-90.6 54.4-143.1 0-7.1-.6-14.3-1.9-20.1-51.5 1.9-110.8 34.4-147.1 75.8-28.5 32.4-55.1 84.9-55.1 138.6 0 7.8 1.3 15.6 1.9 18.1 3.2.6 8.4 1.3 13.6 1.3 46.5 0 102.5-30.4 134.2-70.6z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                {t("accounts.addAccount.iCloud")}
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                {t("accounts.addAccount.iCloudDesc")}
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("imap")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Mail className="w-5 h-5 text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                {t("accounts.addAccount.imapSmtp")}
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                {t("accounts.addAccount.imapSmtpDesc")}
              </div>
            </div>
          </button>

          <button
            onClick={() => setView("caldav")}
            className="w-full flex items-center gap-4 p-4 rounded-lg border border-border-primary bg-bg-secondary hover:bg-bg-hover transition-colors text-left group"
          >
            <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-bg-tertiary flex items-center justify-center">
              <Calendar className="w-5 h-5 text-text-secondary" />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm font-medium text-text-primary group-hover:text-accent transition-colors">
                {t("accounts.addAccount.calDav")}
              </div>
              <div className="text-xs text-text-tertiary mt-0.5">
                {t("accounts.addAccount.calDavDesc")}
              </div>
            </div>
          </button>
        </div>

        <div className="flex justify-end mt-4">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm text-text-secondary hover:text-text-primary transition-colors"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </Modal>
  );
}
