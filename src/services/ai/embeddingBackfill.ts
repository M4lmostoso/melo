import { getSetting } from "@/services/db/settings";
import { getDb } from "@/services/db/connection";
import {
  chunkForEmbedding,
  generateEmbedding,
  storeEmbedding,
  getEmbeddingPrefixes,
} from "./ollamaEmbeddings";

let running = false;
let stopRequested = false;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Store last error for diagnostics
let lastError: string | null = null;
export function getLastError(): string | null { return lastError; }

type MsgRow = {
  id: string;
  account_id: string;
  body_text: string | null;
  subject: string | null;
  snippet: string | null;
};

// Writes a NULL sentinel directly via the SQL plugin (no Rust invoke).
// Used as a safe fallback when the Rust store_embedding command fails,
// ensuring the message is excluded from future backfill batches.
// OR REPLACE (not OR IGNORE): a leftover row from a previous embedding model
// must be overwritten, or the model-mismatch eligibility check would reselect
// the same message forever.
async function writeSentinel(
  db: Awaited<ReturnType<typeof getDb>>,
  messageId: string,
  accountId: string,
  model: string,
): Promise<void> {
  await db.execute(
    `INSERT OR REPLACE INTO message_embeddings (message_id, account_id, chunk_index, chunk_text, embedding, model)
     VALUES ($1, $2, 0, NULL, NULL, $3)`,
    [messageId, accountId, model],
  );
}

export async function runEmbeddingBackfill(): Promise<void> {
  if (running) {
    console.log("[RAG] Backfill already running");
    return;
  }

  const ragEnabled = await getSetting("rag_enabled");
  if (ragEnabled !== "true") {
    console.log("[RAG] Not enabled");
    return;
  }

  const serverUrl = await getSetting("ollama_server_url");
  if (!serverUrl) {
    console.log("[RAG] No Ollama URL configured");
    return;
  }

  console.log(`[RAG] Starting backfill with ${serverUrl}`);
  const model = (await getSetting("embedding_model")) ?? "nomic-embed-text";
  // Default reduced to 384 tokens (~1536 chars) to stay within the 512-token
  // context limit of nomic-embed-text-v2-moe (prefix + content must fit).
  const chunkSize = parseInt((await getSetting("rag_chunk_size")) ?? "384", 10);
  const batchSize = parseInt((await getSetting("rag_batch_size")) ?? "10", 10);

  running = true;
  stopRequested = false;

  // Stop the backfill after this many consecutive Ollama failures on
  // non-empty content — avoids silently writing sentinels for the entire
  // mailbox when Ollama has crashed or run out of memory.
  const MAX_CONSECUTIVE_FAILURES = 5;

  // Bounds the embedding cost of one very long mail — the tail of a 40-page
  // newsletter is not worth the round-trips.
  const MAX_CHUNKS_PER_MESSAGE = 8;
  let consecutiveFailures = 0;

  try {
    const db = await getDb();

    while (!stopRequested) {
      // Rows embedded with a DIFFERENT model are eligible again: switching
      // embedding model must transparently re-index (old vectors have the
      // wrong dimensionality and are filtered out at query time).
      const batch = await db.select<MsgRow[]>(
        `SELECT m.id, m.account_id, m.body_text, m.subject, m.snippet
         FROM messages m
         JOIN accounts a ON a.id = m.account_id
         LEFT JOIN message_embeddings me
           ON me.message_id = m.id AND me.account_id = m.account_id AND me.chunk_index = 0
         WHERE (me.message_id IS NULL OR me.model != $1)
           AND m.account_id IS NOT NULL
           AND a.rag_enabled = 1
           AND NOT EXISTS (
             SELECT 1 FROM thread_labels tl
             WHERE tl.account_id = m.account_id
               AND tl.thread_id = m.thread_id
               AND tl.label_id IN ('SPAM', 'TRASH')
           )
         ORDER BY m.date DESC
         LIMIT $2`,
        [model, batchSize],
      );

      if (batch.length === 0) {
        console.log("[RAG] No more batches - indexing complete");
        break;
      }

      console.log(`[RAG] Processing batch of ${batch.length} messages`);

      for (const msg of batch) {
        if (stopRequested) break;

        const rawText = [msg.subject ?? "", msg.body_text ?? msg.snippet ?? ""]
          .join(" ")
          .trim();
        // One vector per passage, not per message: a single truncated vector
        // left everything past the first few paragraphs unreachable.
        const chunks = chunkForEmbedding(rawText, chunkSize, MAX_CHUNKS_PER_MESSAGE);

        if (chunks.length === 0) {
          // Empty content — mark via Rust (INSERT OR REPLACE, same path as real embeddings)
          try { await storeEmbedding(msg.id, msg.account_id, [], model); } catch (e) {
            console.error(`[RAG] sentinel (empty text) failed for ${msg.id}:`, e);
          }
          continue;
        }

        const { document: docPrefix } = getEmbeddingPrefixes(model);

        // Chunk 0 is the completion marker the eligibility query keys on, so
        // it is written LAST: a crash mid-message then leaves the message
        // eligible again rather than half-indexed and considered done.
        const order = chunks.map((_, i) => i).slice(1).concat(0);
        let messageFailed = false;

        for (const chunkIndex of order) {
          if (stopRequested) break;

          const text = chunks[chunkIndex]!;
          const prefixedText = docPrefix ? `${docPrefix}${text}` : text;
          const embedding = await generateEmbedding(prefixedText, serverUrl, model);

          // Sanitise: JSON can't carry NaN/Infinity (they become null), which
          // breaks serde deserialisation on the Rust side. Replace with 0.
          const safeEmbedding = embedding
            ? embedding.map((v) => (Number.isFinite(v) ? v : 0))
            : null;

          if (safeEmbedding && safeEmbedding.length > 0) {
            try {
              await storeEmbedding(msg.id, msg.account_id, safeEmbedding, model, chunkIndex, text);
            } catch (e) {
              lastError = `store_embedding failed for ${msg.id}#${chunkIndex}: ${e}`;
              console.error("[RAG] store_embedding error:", e);
              // Fall back to sqlx sentinel so the message is excluded next time
              if (chunkIndex === 0) {
                try { await writeSentinel(db, msg.id, msg.account_id, model); } catch (e2) {
                  console.error(`[RAG] writeSentinel fallback also failed for ${msg.id}:`, e2);
                }
              }
            }
          } else {
            // Ollama couldn't process this specific passage (timeout, bad
            // content, etc.). Mark the message via a sentinel so it is skipped
            // in future runs; only stop entirely if ALL recent messages fail.
            messageFailed = true;
            console.warn(`[RAG] Ollama returned null for ${msg.id}#${chunkIndex}`);
            try {
              await storeEmbedding(msg.id, msg.account_id, [], model);
              console.log(`[RAG] Sentinel (Rust) written for ${msg.id}`);
            } catch (e) {
              console.error(`[RAG] sentinel (Rust) failed for ${msg.id}:`, e);
              try { await writeSentinel(db, msg.id, msg.account_id, model); } catch (e2) {
                console.error(`[RAG] sentinel (sqlx) also failed for ${msg.id}:`, e2);
              }
            }
            break;
          }

          // Thermal pause between passages — keeps Ollama responsive
          await delay(50);
        }

        if (messageFailed) {
          consecutiveFailures++;
          if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
            lastError = `Ollama non risponde — il backfill si è fermato dopo ${consecutiveFailures} errori consecutivi. Verifica che Ollama sia attivo e poi riprendi l'indicizzazione.`;
            console.error("[RAG]", lastError);
            stopRequested = true;
            break;
          }
        } else {
          consecutiveFailures = 0;
        }

      }
    }
  } finally {
    running = false;
  }
}

export function stopEmbeddingBackfill(): void {
  stopRequested = true;
}

export async function clearAllEmbeddings(): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM message_embeddings`);
}

export function isEmbeddingBackfillRunning(): boolean {
  return running;
}

export async function getPendingCount(): Promise<number> {
  const db = await getDb();
  const model = (await getSetting("embedding_model")) ?? "nomic-embed-text";
  // Use exact same query as backfill eligibility (incl. model mismatch)
  const result = await db.select<{ cnt: number }[]>(
    `SELECT COUNT(*) as cnt FROM messages m
     JOIN accounts a ON a.id = m.account_id
     LEFT JOIN message_embeddings me ON me.message_id = m.id AND me.account_id = m.account_id AND me.chunk_index = 0
     WHERE (me.message_id IS NULL OR me.model != $1)
       AND a.rag_enabled = 1
       AND m.account_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = m.account_id
           AND tl.thread_id = m.thread_id
           AND tl.label_id IN ('SPAM', 'TRASH')
       )`,
    [model],
  );
  return result[0]?.cnt ?? 0;
}

export async function getDiagnostics(): Promise<{
  totalMessages: number;
  ragAccounts: number;
  eligibleMessages: number;
  indexed: number;
  pending: number;
  sentinels: number;
}> {
  const db = await getDb();
  const model = (await getSetting("embedding_model")) ?? "nomic-embed-text";
  const [total] = await db.select<{ cnt: number }[]>(`SELECT COUNT(*) as cnt FROM messages`);
  const [ragAcc] = await db.select<{ cnt: number }[]>(`SELECT COUNT(*) as cnt FROM accounts WHERE rag_enabled = 1`);

  // Count only current-model embeddings for rag-enabled accounts, excluding
  // SPAM/TRASH (consistent with progress bar and backfill eligibility)
  const [indexed] = await db.select<{ cnt: number }[]>(
    `SELECT COUNT(*) as cnt FROM message_embeddings me
     JOIN accounts a ON a.id = me.account_id
     JOIN messages m ON m.id = me.message_id
     WHERE a.rag_enabled = 1 AND me.embedding IS NOT NULL AND length(me.embedding) > 0
       AND me.model = $1
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = m.account_id
           AND tl.thread_id = m.thread_id
           AND tl.label_id IN ('SPAM', 'TRASH')
       )`,
    [model],
  );
  const [sentinels] = await db.select<{ cnt: number }[]>(
    `SELECT COUNT(*) as cnt FROM message_embeddings me
     JOIN accounts a ON a.id = me.account_id
     JOIN messages m ON m.id = me.message_id
     WHERE a.rag_enabled = 1 AND me.embedding IS NULL
       AND me.model = $1
       AND NOT EXISTS (
         SELECT 1 FROM thread_labels tl
         WHERE tl.account_id = m.account_id
           AND tl.thread_id = m.thread_id
           AND tl.label_id IN ('SPAM', 'TRASH')
       )`,
    [model],
  );

  const pending = await getPendingCount();
  const eligibleMessages = (indexed?.cnt ?? 0) + (sentinels?.cnt ?? 0) + pending;

  return {
    totalMessages: total?.cnt ?? 0,
    ragAccounts: ragAcc?.cnt ?? 0,
    eligibleMessages,
    indexed: indexed?.cnt ?? 0,
    pending,
    sentinels: sentinels?.cnt ?? 0,
  };
}
