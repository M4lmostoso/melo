import { askMyInbox } from "./askInbox";
import type { SearchResult } from "@/services/db/search";

export interface Citation {
   id: string;
   label: string;
   threadId: string;
   messageId?: string;
 }

export interface SearchAnswerResult {
  answer: string;
  citations: Citation[];
  /** Citations keyed by the literal `[...]` marker text found in the answer. */
  citationsByToken: Record<string, Citation[]>;
  hits: SearchResult[];
}

const QUESTION_STARTERS = new Set([
  // English
  "what", "when", "who", "where", "how", "why", "which", "did", "does",
  "has", "have", "is", "are", "can", "could", "would", "should", "tell",
  "find", "show", "list", "do",
  // Italian — single starters
  "cosa", "quando", "chi", "dove", "come", "perché", "perche", "quale",
  "quali", "hai", "ho", "trova", "mostra", "elenca", "dimmi", "sai",
]);

// Two-word Italian question openers: "per quando", "da quando", "entro quando", etc.
const QUESTION_BIGRAMS = new Set([
  "per quando", "per quale", "per quali", "per chi", "per cosa",
  "da quando", "da dove", "da chi",
  "entro quando", "in che",
]);

export function isQuestionQuery(query: string): boolean {
  const trimmed = query.trim();
  if (trimmed.length < 5) return false;
  if (trimmed.includes("?")) return true;
  const lower = trimmed.toLowerCase();
  const words = lower.split(/\s+/);
  if (words.length < 3) return false;
  // Check two-word opener
  const bigram = `${words[0]} ${words[1]}`;
  if (QUESTION_BIGRAMS.has(bigram)) return true;
  // Check single-word opener
  return QUESTION_STARTERS.has(words[0]!);
}

// ---------------------------------------------------------------------------
// Citation resolution
//
// The model is asked to cite context emails with a short "[#3]" marker, but it
// routinely echoes the raw message id instead — and long ids get mangled
// (a dropped character in the account UUID is enough). Exact-string matching
// therefore silently produced zero citations: no source chips in the answer
// AND an empty thread list, because the list is fed from the citations.
// Resolution is deliberately forgiving: exact → normalized → positional index
// → id tail (folder+uid) → nearest unique id within a small edit distance.
// ---------------------------------------------------------------------------

const MAX_ID_DISTANCE = 4;

function normalizeId(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Distinctive tail of an id: for IMAP ("imap-{account}-{folder}-{uid}") the
// folder + uid, which survives a mangled account UUID.
function idTail(value: string): string {
  const parts = value.split("-").filter(Boolean);
  return normalizeId(parts.slice(-2).join("-"));
}

function editDistance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const v = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + cost);
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

interface SourceIndex {
  list: SearchResult[];
  byId: Map<string, SearchResult>;
  byNorm: Map<string, SearchResult>;
  byTail: Map<string, SearchResult | null>;
}

function indexSources(sources: SearchResult[]): SourceIndex {
  const byId = new Map<string, SearchResult>();
  const byNorm = new Map<string, SearchResult>();
  const byTail = new Map<string, SearchResult | null>();
  for (const s of sources) {
    byId.set(s.message_id, s);
    const norm = normalizeId(s.message_id);
    if (!byNorm.has(norm)) byNorm.set(norm, s);
    const tail = idTail(s.message_id);
    if (!tail) continue;
    // Ambiguous tails resolve to nothing rather than to the wrong message.
    byTail.set(tail, byTail.has(tail) ? null : s);
  }
  return { list: sources, byId, byNorm, byTail };
}

function resolveToken(raw: string, idx: SourceIndex): SearchResult | null {
  const cleaned = raw
    .replace(/^Message\s+ID:\s*/i, "")
    .trim()
    .replace(/^#/, "")
    .trim();
  if (!cleaned) return null;

  const exact = idx.byId.get(cleaned);
  if (exact) return exact;

  const norm = normalizeId(cleaned);
  if (!norm) return null;

  const normHit = idx.byNorm.get(norm);
  if (normHit) return normHit;

  // Positional marker: "[#3]" / "[3]" — the numbering used in the context.
  if (/^\d{1,2}$/.test(cleaned)) {
    const pos = parseInt(cleaned, 10) - 1;
    if (pos >= 0 && pos < idx.list.length) return idx.list[pos]!;
    return null;
  }

  const tailHit = idx.byTail.get(idTail(cleaned));
  if (tailHit) return tailHit;

  // Last resort: a single near-identical id (typically one dropped character).
  let best: SearchResult | null = null;
  let bestDist = MAX_ID_DISTANCE + 1;
  let tie = false;
  for (const s of idx.list) {
    const d = editDistance(norm, normalizeId(s.message_id), MAX_ID_DISTANCE);
    if (d < bestDist) {
      bestDist = d;
      best = s;
      tie = false;
    } else if (d === bestDist) {
      tie = true;
    }
  }
  if (best && !tie && bestDist <= MAX_ID_DISTANCE) return best;
  return null;
}

function toCitation(src: SearchResult): Citation {
  const label = src.from_name
    ? `${src.from_name} — ${src.subject ?? "(no subject)"}`
    : (src.subject ?? "(no subject)");
  return { id: src.message_id, label, threadId: src.thread_id, messageId: src.message_id };
}

/**
 * Resolves every `[...]` marker in the answer. Returns the deduped citation
 * list plus a lookup keyed by the *literal* bracket contents, so the renderer
 * can turn the same markers into chips (one marker may carry several ids).
 */
export function buildCitations(
  answer: string,
  sources: SearchResult[],
): { citations: Citation[]; byToken: Record<string, Citation[]> } {
  const idx = indexSources(sources);
  const citations: Citation[] = [];
  const byToken: Record<string, Citation[]> = {};
  const seen = new Set<string>();
  const pattern = /\[([^\]]+)\]/g;
  let m: RegExpExecArray | null;

  while ((m = pattern.exec(answer)) !== null) {
    const rawInner = m[1]!;
    if (rawInner in byToken) continue;
    const resolved: Citation[] = [];
    // A single marker may list several ids: "[a, b]" / "[a; b]".
    for (const token of rawInner.split(/[,;]/)) {
      const src = resolveToken(token, idx);
      if (!src) continue;
      const cit = toCitation(src);
      if (!resolved.some((c) => c.id === cit.id)) resolved.push(cit);
      if (seen.has(cit.id)) continue;
      seen.add(cit.id);
      citations.push(cit);
    }
    if (resolved.length > 0) byToken[rawInner] = resolved;
  }

  return { citations, byToken };
}

export async function getSearchAnswer(
  query: string,
  accountId: string | null,
): Promise<SearchAnswerResult> {
  const result = await askMyInbox(query, accountId);
  const { citations, byToken } = buildCitations(result.answer, result.sourceMessages);
  return {
    answer: result.answer,
    citations,
    citationsByToken: byToken,
    hits: result.sourceMessages,
  };
}
