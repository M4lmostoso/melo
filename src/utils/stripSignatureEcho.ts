/**
 * Remove a signature the AI wrote at the end of a generated body when the
 * composer appends the real one anyway.
 *
 * The models imitate what they are shown: the thread and the user's past
 * replies all end with the signature, so drafts came back ending with
 * "Mirko Landenna / Business Development Manager / Mob. … / TM.E. S.p.A …"
 * right above the real signature (2026-11-13). The prompt now forbids it
 * (`SIGNATURE_APPENDED_RULE`); this is the safety net for models that ignore it.
 *
 * Only TRAILING lines whose text is part of the signature are dropped, so a
 * closing formula ("Cordialement,") or a body line that merely mentions the
 * company stays. Pure DOM, no Tauri imports.
 */

/** Letters and digits only, lowercase: "TM.E. S.p.A – Termomeccanica" ≈ "tmespatermomeccanica". */
function squash(text: string): string {
  return text.normalize("NFKD").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

/** Shortest line considered a signature echo (avoids dropping "—", "M." …). */
const MIN_LINE = 4;

export function stripSignatureEcho(bodyHtml: string, signatureHtml: string | null | undefined): string {
  if (!signatureHtml || !bodyHtml) return bodyHtml;
  const parse = (html: string) => new DOMParser().parseFromString(`<body>${html}</body>`, "text/html").body;

  const signature = squash(parse(signatureHtml).textContent ?? "");
  if (signature.length < MIN_LINE) return bodyHtml;
  const isEcho = (text: string) => {
    const s = squash(text);
    return s.length >= MIN_LINE && signature.includes(s);
  };

  const root = parse(bodyHtml);
  let changed = false;

  for (;;) {
    const last = root.lastElementChild ?? null;
    // Trailing text nodes / empty paragraphs between the echo lines.
    const trailing = root.lastChild;
    if (trailing && trailing.nodeType === Node.TEXT_NODE && !(trailing.textContent ?? "").trim()) {
      trailing.remove();
      continue;
    }
    if (!last) break;
    const text = last.textContent ?? "";
    if (!text.trim() && !last.querySelector("img")) {
      last.remove();
      changed = true;
      continue;
    }
    if (isEcho(text)) {
      if (root.children.length === 1) break; // never empty the body
      last.remove();
      changed = true;
      continue;
    }
    // A block of <br>-separated lines ("Cordialement,<br>Mirko Landenna<br>Mob. …"):
    // drop the trailing lines that echo the signature, keep the rest.
    const html = last.innerHTML;
    const lines = html.split(/<br\s*\/?>/i);
    if (lines.length > 1) {
      let keep = lines.length;
      while (keep > 1 && isEcho(parse(lines[keep - 1]!).textContent ?? "")) keep--;
      while (keep > 1 && !(parse(lines[keep - 1]!).textContent ?? "").trim()) keep--;
      if (keep < lines.length) {
        last.innerHTML = lines.slice(0, keep).join("<br>");
        changed = true;
      }
    }
    break;
  }

  return changed ? root.innerHTML.trim() : bodyHtml;
}
