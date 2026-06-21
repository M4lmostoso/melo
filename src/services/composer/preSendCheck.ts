// Pure, side-effect-free helpers for the pre-send guard
// (missing subject / forgotten attachment). Kept provider-agnostic so they're
// trivial to unit-test and reusable from any send entrypoint.

export type PreSendWarning = "subject" | "attachment";

// Stems/phrases that, when present in the body the user actually typed, suggest
// an attachment was intended. Matched case-insensitively as substrings so
// conjugations and plurals are covered (Italian "allegato/allegati/allego",
// English "attached/attaching/attachment", French "pièce jointe/ci-joint").
// Only checked when the message has zero attachments, so false positives just
// surface a dismissible confirmation — never block a legitimate send.
const ATTACHMENT_HINTS = [
  // English
  "attach",
  "enclos",
  // Italian
  "allega",
  "allego",
  "allegh",
  // French
  "pièce jointe",
  "pièces jointes",
  "ci-joint",
  "ci joint",
];

// French abbreviation "PJ" / "P.J." (case-insensitive). Matched at word
// boundaries — not as a bare substring — so it doesn't fire inside unrelated
// words that happen to contain "pj".
const ATTACHMENT_ABBREVIATIONS = /\bp\.?\s?j\.?\b/i;

/** True when the body text hints at an attachment (see ATTACHMENT_HINTS). */
export function mentionsAttachment(bodyText: string): boolean {
  if (!bodyText) return false;
  const text = bodyText.toLowerCase();
  if (ATTACHMENT_HINTS.some((hint) => text.includes(hint))) return true;
  return ATTACHMENT_ABBREVIATIONS.test(bodyText);
}

/**
 * Collect the warnings that should gate a send. `bodyText` must be only the
 * user-typed body (not the quoted reply), so quoting an old "attached" mail
 * doesn't trigger a false attachment warning.
 */
export function getPreSendWarnings(params: {
  subject: string;
  attachmentCount: number;
  bodyText: string;
}): PreSendWarning[] {
  const warnings: PreSendWarning[] = [];
  if (params.subject.trim().length === 0) warnings.push("subject");
  if (params.attachmentCount === 0 && mentionsAttachment(params.bodyText)) {
    warnings.push("attachment");
  }
  return warnings;
}
