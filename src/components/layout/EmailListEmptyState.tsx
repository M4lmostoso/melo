import { Filter, FolderSearch } from "lucide-react";
import { t } from "@/i18n";
import { EmptyState } from "../ui/EmptyState";
import {
  InboxClearIllustration,
  NoSearchResultsIllustration,
  NoAccountIllustration,
  GenericEmptyIllustration,
  ScheduledEmptyIllustration,
  SnoozedEmptyIllustration,
  DraftsEmptyIllustration,
  UnreadEmptyIllustration,
  StarredEmptyIllustration,
  StarredRecentIllustration,
} from "../ui/illustrations";

/**
 * Picks the right empty-state illustration/copy for the current list context
 * (search, read filter, account state, label/category). Pure presentational —
 * extracted from EmailList.tsx to keep the list component focused.
 */
export function EmailListEmptyState({
  searchQuery,
  activeAccountId,
  activeLabel,
  readFilter,
  activeCategory,
  hasGlobalAccounts,
}: {
  searchQuery: string | null;
  activeAccountId: string | null;
  activeLabel: string;
  readFilter: string;
  activeCategory: string;
  hasGlobalAccounts: boolean;
}) {
  if (searchQuery) {
    return <EmptyState illustration={NoSearchResultsIllustration} title={t("layout.emailList.emptySearch.title")} subtitle={t("layout.emailList.emptySearch.subtitle")} />;
  }
  if (readFilter !== "all") {
    return <EmptyState icon={Filter} title={t("layout.emailList.emptyFilter.title", { filter: readFilter })} subtitle={t("layout.emailList.emptyFilter.subtitle")} />;
  }
  if (!activeAccountId && !hasGlobalAccounts) {
    return <EmptyState illustration={NoAccountIllustration} title={t("layout.emailList.emptyNoAccount.title")} subtitle={t("layout.emailList.emptyNoAccount.subtitle")} />;
  }

  switch (activeLabel) {
    case "unified-inbox":
    case "inbox":
      if (activeCategory !== "All") {
        const categoryMessages: Record<string, { title: string; subtitle: string }> = {
          Primary: { title: t("layout.emailList.emptyPrimary.title"), subtitle: t("layout.emailList.emptyPrimary.subtitle") },
          Updates: { title: t("layout.emailList.emptyUpdates.title"), subtitle: t("layout.emailList.emptyUpdates.subtitle") },
          Promotions: { title: t("layout.emailList.emptyPromotions.title"), subtitle: t("layout.emailList.emptyPromotions.subtitle") },
          Social: { title: t("layout.emailList.emptySocial.title"), subtitle: t("layout.emailList.emptySocial.subtitle") },
          Newsletters: { title: t("layout.emailList.emptyNewsletters.title"), subtitle: t("layout.emailList.emptyNewsletters.subtitle") },
        };
        const msg = categoryMessages[activeCategory];
        if (msg) return <EmptyState illustration={InboxClearIllustration} title={msg.title} subtitle={msg.subtitle} />;
      }
      return <EmptyState illustration={InboxClearIllustration} title={t("layout.emailList.emptyInbox.title")} subtitle={t("layout.emailList.emptyInbox.subtitle")} />;
    case "starred":
      return <EmptyState illustration={StarredEmptyIllustration} title={t("layout.emailList.emptyStarred.title")} subtitle={t("layout.emailList.emptyStarred.subtitle")} />;
    case "snoozed":
      return <EmptyState illustration={SnoozedEmptyIllustration} title={t("layout.emailList.emptySnoozed.title")} subtitle={t("layout.emailList.emptySnoozed.subtitle")} />;
    case "scheduled":
      return <EmptyState illustration={ScheduledEmptyIllustration} title={t("layout.emailList.emptyScheduled.title")} subtitle={t("layout.emailList.emptyScheduled.subtitle")} />;
    case "sent":
      return <EmptyState illustration={GenericEmptyIllustration} title={t("layout.emailList.emptySent.title")} />;
    case "drafts":
      return <EmptyState illustration={DraftsEmptyIllustration} title={t("layout.emailList.emptyDrafts.title")} />;
    case "trash":
      return <EmptyState illustration={GenericEmptyIllustration} title={t("layout.emailList.emptyTrash.title")} />;
    case "spam":
      return <EmptyState illustration={GenericEmptyIllustration} title={t("layout.emailList.emptySpam.title")} subtitle={t("layout.emailList.emptySpam.subtitle")} />;
    case "all":
      return <EmptyState illustration={GenericEmptyIllustration} title={t("layout.emailList.emptyAll.title")} />;
    default:
      if (activeLabel === "smart-folder:sf-unread") {
        return <EmptyState illustration={UnreadEmptyIllustration} title={t("layout.emailList.emptyUnread.title")} subtitle={t("layout.emailList.emptyUnread.subtitle")} />;
      }
      if (activeLabel === "smart-folder:sf-starred-recent") {
        return <EmptyState illustration={StarredRecentIllustration} title={t("layout.emailList.emptyStarredRecent.title")} subtitle={t("layout.emailList.emptyStarredRecent.subtitle")} />;
      }
      if (activeLabel.startsWith("smart-folder:")) {
        return <EmptyState icon={FolderSearch} title={t("layout.emailList.emptySmartFolder.title")} subtitle={t("layout.emailList.emptySmartFolder.subtitle")} />;
      }
      return <EmptyState illustration={GenericEmptyIllustration} title={t("layout.emailList.emptyLabel.title")} subtitle={t("layout.emailList.emptyLabel.subtitle")} />;
  }
}
