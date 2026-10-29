import { useEffect, useMemo, useState } from "react";
import { invoke, convertFileSrc } from "@tauri-apps/api/core";
import { t } from "@/i18n";
import { EmailRenderer } from "./EmailRenderer";
import { formatFullDate } from "@/utils/date";
import { formatFileSize, getFileIcon } from "@/utils/fileTypeHelpers";

interface EmlPart {
  filename: string;
  mimeType: string;
  size: number;
  contentId: string | null;
  isInline: boolean;
  path: string;
}

interface ParsedEml {
  subject: string | null;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string | null;
  ccAddresses: string | null;
  date: number | null;
  bodyHtml: string | null;
  bodyText: string | null;
  parts: EmlPart[];
}

/**
 * Preview of a `message/rfc822` attachment (a forwarded-as-attachment mail).
 * Rust parses the cached .eml and extracts its parts to disk; the body goes
 * through the regular EmailRenderer (sanitized, remote images blocked) with
 * inline `cid:` images served from the extracted files.
 */
export function EmlPreview({ path, fill = false }: { path: string; fill?: boolean }) {
  const [eml, setEml] = useState<ParsedEml | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<ParsedEml>("parse_eml_file", { path })
      .then((parsed) => { if (!cancelled) setEml(parsed); })
      .catch((err) => {
        console.error("Failed to parse .eml attachment:", err);
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [path]);

  const cidMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const part of eml?.parts ?? []) {
      if (part.contentId) map.set(part.contentId.replace(/[<>]/g, "").trim(), convertFileSrc(part.path));
    }
    return map;
  }, [eml]);

  if (failed) {
    return <p className="text-sm text-text-tertiary">{t("email.emlPreview.parseFailed")}</p>;
  }
  if (!eml) {
    return <p className="text-sm text-text-tertiary">{t("email.attachmentList.loadingPreview")}</p>;
  }

  // Inline images already shown in the body are not listed again.
  const html = eml.bodyHtml?.toLowerCase() ?? "";
  const files = eml.parts.filter((p) => !(p.contentId && html.includes(`cid:${p.contentId.toLowerCase()}`)));
  const from = eml.fromName ? `${eml.fromName} <${eml.fromAddress ?? ""}>` : eml.fromAddress;

  const openPart = async (part: EmlPart) => {
    const { openPath } = await import("@tauri-apps/plugin-opener");
    await openPath(part.path).catch((err) => console.error("Open .eml part failed:", err));
  };

  return (
    <div className={`self-stretch w-full overflow-auto flex flex-col gap-3 ${fill ? "max-h-full" : "max-h-[70vh]"}`}>
      <div className="shrink-0 border-b border-border-secondary pb-3">
        <h2 className="text-base font-semibold text-text-primary mb-1.5">
          {eml.subject || t("email.noSubject")}
        </h2>
        <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-xs">
          {from && (<><dt className="text-text-tertiary">{t("email.emlPreview.from")}</dt><dd className="text-text-secondary break-words">{from}</dd></>)}
          {eml.toAddresses && (<><dt className="text-text-tertiary">{t("messageItem.to")}</dt><dd className="text-text-secondary break-words">{eml.toAddresses}</dd></>)}
          {eml.ccAddresses && (<><dt className="text-text-tertiary">{t("messageItem.cc")}</dt><dd className="text-text-secondary break-words">{eml.ccAddresses}</dd></>)}
          {eml.date != null && (<><dt className="text-text-tertiary">{t("email.emlPreview.date")}</dt><dd className="text-text-secondary">{formatFullDate(eml.date)}</dd></>)}
        </dl>
        {files.length > 0 && (
          <div className="flex flex-wrap gap-2 mt-3">
            {files.map((part) => (
              <button
                key={part.path}
                onClick={() => void openPart(part)}
                title={t("email.emlPreview.openPart")}
                className="flex items-center gap-2 px-3 py-1.5 text-xs rounded-md border border-border-primary hover:bg-bg-hover transition-colors"
              >
                <span className="text-text-tertiary">{getFileIcon(part.mimeType, part.filename)}</span>
                <span className="text-text-secondary truncate max-w-[220px]">{part.filename}</span>
                <span className="text-text-tertiary whitespace-nowrap">{formatFileSize(part.size)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
      <EmailRenderer
        html={eml.bodyHtml}
        text={eml.bodyText}
        blockImages
        senderAddress={eml.fromAddress}
        cidMap={cidMap}
      />
    </div>
  );
}
