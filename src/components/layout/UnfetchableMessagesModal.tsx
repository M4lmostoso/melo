import { t } from "@/i18n";
import { Modal } from "@/components/ui/Modal";
import { UnfetchableMessagesList } from "@/components/settings/UnfetchableMessagesList";

interface UnfetchableMessagesModalProps {
  /** Restrict to one account (sidebar warning); omit for all accounts (Settings). */
  accountId?: string;
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Detail dialog listing genuinely-unfetchable messages. Opened either from
 * the amber sync warning on an account in the sidebar (scoped to that
 * account) or from the Settings → Accounts summary (all accounts).
 */
export function UnfetchableMessagesModal({ accountId, isOpen, onClose }: UnfetchableMessagesModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={t("unfetchableMessages.title")}
      width="w-[34rem] max-w-[90vw]"
      panelClassName="max-h-[80vh] flex flex-col"
    >
      <div className="px-4 py-3 overflow-y-auto">
        <p className="text-xs text-text-tertiary leading-relaxed mb-2">
          {t("unfetchableMessages.description")}
        </p>
        <UnfetchableMessagesList accountId={accountId} showAccount={!accountId} />
        {accountId && (
          <p className="text-xs text-text-tertiary leading-relaxed mt-3">
            {t("unfetchableMessages.settingsHint")}
          </p>
        )}
      </div>
    </Modal>
  );
}
