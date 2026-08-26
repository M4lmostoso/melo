use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use tauri::Manager;

/// (account_id, thread_id, subject, from_name, from_address, snippet, date)
type FtsMessageMeta = (String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64);

#[allow(dead_code)]
#[derive(Debug, Serialize, Deserialize)]
pub struct VectorSearchHit {
    pub message_id: String,
    pub account_id: String,
    pub thread_id: String,
    pub subject: Option<String>,
    pub from_name: Option<String>,
    pub from_address: Option<String>,
    pub snippet: Option<String>,
    pub date: i64,
    pub score: f32,
    /// The passage whose embedding matched, when the hit came from the vector
    /// arm. Feeding this to the answering model instead of the snippet is the
    /// difference between quoting a subject line and quoting the actual text.
    pub chunk_text: Option<String>,
}

#[allow(dead_code)]
fn get_db_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|p| p.join("melo.db"))
        .map_err(|e| e.to_string())
}

#[allow(dead_code)]
// Convert raw BLOB bytes (little-endian f32) to a Vec<f32>.
// Returns an empty Vec when the length is not a multiple of 4 (corrupt blob).
fn blob_to_f32(blob: &[u8]) -> Vec<f32> {
    if blob.len() % 4 != 0 {
        return vec![];
    }
    blob.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

#[allow(dead_code)]
// Cosine similarity. Returns 0.0 for zero-length or mismatched vectors.
// The inner loop auto-vectorises with NEON/AVX2 when compiled with
// -C target-cpu=native (see .cargo/config.toml).
fn cosine_similarity(a: &[f32], b: &[f32]) -> f32 {
    if a.len() != b.len() || a.is_empty() {
        return 0.0;
    }
    let mut dot = 0.0f32;
    let mut norm_a = 0.0f32;
    let mut norm_b = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        norm_a += x * x;
        norm_b += y * y;
    }
    let denom = norm_a.sqrt() * norm_b.sqrt();
    if denom == 0.0 {
        0.0
    } else {
        dot / denom
    }
}

#[allow(dead_code)]
// Sanitise FTS terms so they are safe to pass to SQLite FTS5 MATCH.
// Wraps each token in double-quotes and removes characters that would break
// FTS5 query syntax.
fn build_fts_query(terms: &str) -> String {
    terms
        .split_whitespace()
        .filter(|t| t.len() > 1)
        .map(|t| {
            let clean: String = t.chars().filter(|c| c.is_alphanumeric()).collect();
            if clean.is_empty() {
                String::new()
            } else {
                format!("\"{}\"", clean)
            }
        })
        .filter(|t| !t.is_empty())
        .collect::<Vec<_>>()
        .join(" OR ")
}

// ─────────────────────────────────────────────────────────────────────────────
// store_embedding
//
// Stores an embedding as a raw little-endian binary BLOB.
// An empty Vec<f32> writes NULL (sentinel: no embeddable content).
// ─────────────────────────────────────────────────────────────────────────────

#[allow(dead_code)]
#[tauri::command]
pub async fn store_embedding(
    app: tauri::AppHandle,
    message_id: String,
    account_id: String,
    embedding: Vec<f32>,
    model: String,
    chunk_index: Option<i64>,
    chunk_text: Option<String>,
) -> Result<(), String> {
    let chunk_index = chunk_index.unwrap_or(0);
    let db_path = get_db_path(&app)?;

    tokio::task::spawn_blocking(move || {
        let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

        // Enable WAL mode so our write connection can coexist with the
        // tauri-plugin-sql (sqlx) reader connections without SQLITE_BUSY errors.
        // WAL mode is sticky: once set it persists for the DB file.
        conn.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;")
            .map_err(|e| e.to_string())?;

        // Retry for up to 15 s in case sqlx is mid-transaction.
        conn.busy_timeout(std::time::Duration::from_secs(15))
            .map_err(|e| e.to_string())?;

        if embedding.is_empty() {
            // NULL sentinel: message has no embeddable content. Always written
            // at chunk 0, the index the backfill's eligibility check keys on.
            conn.execute(
                "INSERT OR REPLACE INTO message_embeddings \
                 (message_id, account_id, chunk_index, chunk_text, embedding, model) \
                 VALUES (?1, ?2, 0, NULL, NULL, ?3)",
                rusqlite::params![message_id, account_id, model],
            )
            .map_err(|e| e.to_string())?;
        } else {
            let bytes: Vec<u8> = embedding
                .iter()
                .flat_map(|f| f.to_le_bytes())
                .collect();
            conn.execute(
                "INSERT OR REPLACE INTO message_embeddings \
                 (message_id, account_id, chunk_index, chunk_text, embedding, model) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                rusqlite::params![
                    message_id,
                    account_id,
                    chunk_index,
                    chunk_text,
                    bytes.as_slice(),
                    model
                ],
            )
            .map_err(|e| e.to_string())?;
        }

        Ok::<(), String>(())
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// ask_inbox_rust
//
// Hybrid FTS + vector retrieval with Reciprocal Rank Fusion (RRF, k=60).
//
// Algorithm:
//   1. FTS5 MATCH → top-50 hits → RRF scores (lazy iterator)
//   2. Count indexed embeddings to choose sequential vs parallel path:
//      a. ≤ 1000 rows: stream rows one at a time (true lazy, O(1) peak RAM
//                      beyond the current row), keep a rolling top-K buffer.
//      b. > 1000 rows: collect only (message_id, blob) pairs (no metadata)
//                      into memory, compute cosine with rayon, keep top-K.
//   3. RRF fusion of FTS and vector scores.
//   4. Fetch full metadata for the top-N IDs in a single targeted JOIN query.
//
// Filters applied to BOTH retrieval arms:
//   - `account_ids`: one id (single-account view) or all RAG-enabled ids
//     (unified view).
//   - SPAM/TRASH threads are excluded at query time — the backfill excludes
//     them at index time, but messages trashed AFTER indexing keep their
//     embedding row until permanent deletion.
//   - `after_ms`: optional lower bound on message date ("today", "last week"
//     questions).
//   - `model`: optional embedding-model filter so vectors from a previous
//     model (different dimensionality → cosine 0) never pollute ranking.
//
// Zero-embeddings safety:
//   - The SQL WHERE clause (`IS NOT NULL AND length > 0`) means rusqlite never
//     sees a NULL blob; the iterator simply yields zero rows when all
//     embeddings are NULL (backfill not yet started), and the code falls
//     through to FTS-only results without panicking.
// ─────────────────────────────────────────────────────────────────────────────

// Hard cap on the number of chunk vectors scanned in one query. Blobs are
// streamed in batches rather than collected, so this bounds work, not RAM:
// peak extra memory is one batch (VECTOR_BATCH_ROWS × 768 × 4 B ≈ 12 MB) plus
// the per-message best-score map.
const MAX_VECTOR_ROWS: usize = 200_000;

// Rows pulled into memory at a time before being scored in parallel.
const VECTOR_BATCH_ROWS: usize = 4_096;

// Below this, scoring a batch in parallel costs more than it saves.
const PARALLEL_THRESHOLD: usize = 256;

// How many vector hits take part in the fusion. Rank-based fusion gives every
// scanned message a non-zero score, so without a cutoff a vaguely-similar mail
// at vector rank 900 still competes with a keyword hit.
const VECTOR_FUSION_DEPTH: usize = 50;

// The full-text arm is weighted above the vector arm in the fusion: when a
// query does contain the words a mail actually uses, that is stronger evidence
// than embedding proximity.
const FTS_FUSION_WEIGHT: f64 = 1.3;

const NOT_TRASH_SPAM_SQL: &str = "NOT EXISTS (
    SELECT 1 FROM thread_labels tl
    WHERE tl.account_id = m.account_id
      AND tl.thread_id = m.thread_id
      AND tl.label_id IN ('SPAM', 'TRASH')
)";

fn in_placeholders(n: usize) -> String {
    std::iter::repeat("?").take(n).collect::<Vec<_>>().join(", ")
}

#[allow(dead_code)]
#[tauri::command]
pub async fn ask_inbox_rust(
    app: tauri::AppHandle,
    query_embedding: Vec<f32>,
    account_ids: Vec<String>,
    fts_terms: Option<String>,
    limit: Option<usize>,
    after_ms: Option<i64>,
    model: Option<String>,
) -> Result<Vec<VectorSearchHit>, String> {
    let db_path = get_db_path(&app)?;
    let max_results = limit.unwrap_or(20).min(50);
    if account_ids.is_empty() {
        return Ok(vec![]);
    }

    tokio::task::spawn_blocking(move || {
        let conn = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| e.to_string())?;

        conn.busy_timeout(std::time::Duration::from_secs(10))
            .map_err(|e| e.to_string())?;

        const K: f64 = 60.0;

        // ── Step 1: FTS search (lazy iterator) ──────────────────────────────

        let mut fts_rrf: HashMap<String, f64> = HashMap::new();
        // FTS-only hits need their metadata here since they may not have a
        // blob entry. Limited to top-50 so this is always small.
        let mut fts_meta: HashMap<String, FtsMessageMeta> = HashMap::new();

        if let Some(ref terms) = fts_terms {
            let fts_query = build_fts_query(terms);
            if !fts_query.is_empty() {
                let fts_sql = format!(
                    "SELECT m.id, m.account_id, m.thread_id, m.subject,
                            m.from_name, m.from_address, m.snippet, m.date
                     FROM messages_fts
                     JOIN messages m ON m.rowid = messages_fts.rowid
                     WHERE messages_fts MATCH ?
                       AND m.account_id IN ({})
                       {}
                       AND {}
                     ORDER BY rank
                     LIMIT 50",
                    in_placeholders(account_ids.len()),
                    if after_ms.is_some() { "AND m.date >= ?" } else { "" },
                    NOT_TRASH_SPAM_SQL,
                );
                let mut fts_params: Vec<rusqlite::types::Value> =
                    vec![rusqlite::types::Value::Text(fts_query)];
                fts_params.extend(
                    account_ids
                        .iter()
                        .map(|id| rusqlite::types::Value::Text(id.clone())),
                );
                if let Some(after) = after_ms {
                    fts_params.push(rusqlite::types::Value::Integer(after));
                }
                if let Ok(mut stmt) = conn.prepare(&fts_sql) {
                    if let Ok(rows) = stmt.query_map(
                        rusqlite::params_from_iter(fts_params),
                        |row| {
                            Ok((
                                row.get::<_, String>(0)?,
                                row.get::<_, String>(1)?,
                                row.get::<_, String>(2)?,
                                row.get::<_, Option<String>>(3)?,
                                row.get::<_, Option<String>>(4)?,
                                row.get::<_, Option<String>>(5)?,
                                row.get::<_, Option<String>>(6)?,
                                row.get::<_, i64>(7)?,
                            ))
                        },
                    ) {
                        for (rank, row) in rows.flatten().enumerate() {
                            let rrf = 1.0 / (K + rank as f64 + 1.0);
                            fts_rrf.insert(row.0.clone(), rrf);
                            fts_meta.insert(row.0, (row.1, row.2, row.3, row.4, row.5, row.6, row.7));
                        }
                    }
                }
            }
        }

        // ── Step 2: Vector similarity ────────────────────────────────────────
        //
        // Scored result: sorted Vec<(message_id, cosine_score)>, descending.

        let scored: Vec<(String, f32, i64)> = if !query_embedding.is_empty() {
            vector_score(
                &conn,
                &account_ids,
                &query_embedding,
                model.as_deref(),
                after_ms,
            )?
        } else {
            vec![]
        };

        // ── Step 3: RRF fusion ───────────────────────────────────────────────

        let mut rrf_total: HashMap<String, f64> = HashMap::new();

        // Vector RRF ranks (already sorted descending by cosine score),
        // truncated: rank-based fusion hands every scanned message a non-zero
        // score, so an untruncated arm lets a barely-similar mail outrank a
        // real keyword hit purely by being in the list.
        // message_id → the chunk that matched, for the context fetch below.
        let mut best_chunk: HashMap<String, i64> = HashMap::new();
        for (rank, (msg_id, _, chunk_index)) in
            scored.iter().take(VECTOR_FUSION_DEPTH).enumerate()
        {
            *rrf_total.entry(msg_id.clone()).or_insert(0.0) +=
                1.0 / (K + rank as f64 + 1.0);
            best_chunk.insert(msg_id.clone(), *chunk_index);
        }

        // FTS RRF, weighted above the vector arm.
        for (msg_id, rrf) in &fts_rrf {
            *rrf_total.entry(msg_id.clone()).or_insert(0.0) += rrf * FTS_FUSION_WEIGHT;
        }

        let mut ranked: Vec<(String, f64)> = rrf_total.into_iter().collect();
        ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

        // ── Step 4: Fetch metadata for top-N IDs ────────────────────────────
        //
        // We only fetch metadata for the top-N IDs — not for all scanned rows.

        let top_ids: Vec<String> = ranked
            .iter()
            .take(max_results)
            .map(|(id, _)| id.clone())
            .collect();

        if top_ids.is_empty() {
            return Ok::<Vec<VectorSearchHit>, String>(vec![]);
        }

        // Build a lookup from the targeted metadata query
        let meta_sql = format!(
            "SELECT m.id, m.account_id, m.thread_id, m.subject,
                    m.from_name, m.from_address, m.snippet, m.date
             FROM messages m
             WHERE m.id IN ({}) AND m.account_id IN ({})",
            in_placeholders(top_ids.len()),
            in_placeholders(account_ids.len()),
        );

        let mut meta_stmt = conn.prepare(&meta_sql).map_err(|e| e.to_string())?;

        let meta_params: Vec<rusqlite::types::Value> = top_ids
            .iter()
            .chain(account_ids.iter())
            .map(|s| rusqlite::types::Value::Text(s.clone()))
            .collect();

        // message_id → (account_id, thread_id, subject, from_name, from_address, snippet, date)
        type MetaTuple = (String, String, Option<String>, Option<String>, Option<String>, Option<String>, i64);
        let mut meta_map: HashMap<String, MetaTuple> = HashMap::new();

        if let Ok(rows) = meta_stmt.query_map(rusqlite::params_from_iter(meta_params), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, Option<String>>(6)?,
                row.get::<_, i64>(7)?,
            ))
        }) {
            for row in rows.flatten() {
                meta_map.insert(row.0.clone(), (row.1, row.2, row.3, row.4, row.5, row.6, row.7));
            }
        }

        // ── Step 4b: Fetch the matched passage for the top IDs ──────────────
        //
        // Only for the handful of results being returned: chunk_text is up to
        // ~1.5 KB a row, far too much to carry through the whole scan.

        let mut chunk_map: HashMap<String, String> = HashMap::new();
        let chunk_ids: Vec<&String> = top_ids
            .iter()
            .filter(|id| best_chunk.contains_key(*id))
            .collect();

        if !chunk_ids.is_empty() {
            let chunk_sql = format!(
                "SELECT me.message_id, me.chunk_index, me.chunk_text
                 FROM message_embeddings me
                 WHERE me.message_id IN ({}) AND me.account_id IN ({})
                   AND me.chunk_text IS NOT NULL",
                in_placeholders(chunk_ids.len()),
                in_placeholders(account_ids.len()),
            );
            let chunk_params: Vec<rusqlite::types::Value> = chunk_ids
                .iter()
                .map(|s| rusqlite::types::Value::Text((*s).clone()))
                .chain(
                    account_ids
                        .iter()
                        .map(|s| rusqlite::types::Value::Text(s.clone())),
                )
                .collect();

            if let Ok(mut chunk_stmt) = conn.prepare(&chunk_sql) {
                if let Ok(rows) = chunk_stmt.query_map(
                    rusqlite::params_from_iter(chunk_params),
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, i64>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                ) {
                    // The wanted chunk index differs per message, so the match
                    // happens here rather than in the WHERE clause.
                    for (msg_id, chunk_index, text) in rows.flatten() {
                        let Some(text) = text else { continue };
                        if best_chunk.get(&msg_id) == Some(&chunk_index) {
                            chunk_map.insert(msg_id, text);
                        }
                    }
                }
            }
        }

        // ── Step 5: Build result list ────────────────────────────────────────

        let hits: Vec<VectorSearchHit> = ranked
            .into_iter()
            .take(max_results)
            .filter_map(|(msg_id, score)| {
                // Prefer freshly-fetched metadata; fall back to FTS meta for
                // hits that only appeared in FTS (not in the messages query).
                if let Some((acct, thread, subj, fname, faddr, snip, date)) =
                    meta_map.get(&msg_id)
                {
                    Some(VectorSearchHit {
                        message_id: msg_id.clone(),
                        account_id: acct.clone(),
                        thread_id: thread.clone(),
                        subject: subj.clone(),
                        from_name: fname.clone(),
                        from_address: faddr.clone(),
                        snippet: snip.clone(),
                        date: *date,
                        score: score as f32,
                        chunk_text: chunk_map.get(&msg_id).cloned(),
                    })
                } else if let Some((acct, thread, subj, fname, faddr, snip, date)) =
                    fts_meta.get(&msg_id)
                {
                    Some(VectorSearchHit {
                        message_id: msg_id.clone(),
                        account_id: acct.clone(),
                        thread_id: thread.clone(),
                        subject: subj.clone(),
                        from_name: fname.clone(),
                        from_address: faddr.clone(),
                        snippet: snip.clone(),
                        date: *date,
                        score: score as f32,
                        chunk_text: chunk_map.get(&msg_id).cloned(),
                    })
                } else {
                    None
                }
            })
            .collect();

        Ok::<Vec<VectorSearchHit>, String>(hits)
    })
    .await
    .map_err(|e| e.to_string())?
}

// ─────────────────────────────────────────────────────────────────────────────
// vector_score — internal helper
//
// Returns Vec<(message_id, best_cosine, best_chunk_index)> sorted descending by
// score — one entry per message, not per chunk. Embeddings are stored per
// passage now, so several rows can belong to the same mail; the best-matching
// passage is what represents it.
//
// Rows are streamed in batches of VECTOR_BATCH_ROWS and scored with rayon,
// which keeps peak memory at one batch of blobs regardless of mailbox size —
// the previous "collect everything, then par_iter" path scaled its RAM with
// the index and had to be capped at 20k rows to stay safe.
// ─────────────────────────────────────────────────────────────────────────────

fn vector_score(
    conn: &Connection,
    account_ids: &[String],
    query_embedding: &[f32],
    model: Option<&str>,
    after_ms: Option<i64>,
) -> Result<Vec<(String, f32, i64)>, String> {
    let acct_in = in_placeholders(account_ids.len());
    let model_clause = if model.is_some() { "AND me.model = ?" } else { "" };

    // The embed scan: joined to messages so SPAM/TRASH threads and messages
    // outside the optional date window are excluded at query time.
    // Ordered by recency, capped at MAX_VECTOR_ROWS.
    let embed_sql = format!(
        "SELECT me.message_id, me.chunk_index, me.embedding
         FROM message_embeddings me
         JOIN messages m ON m.id = me.message_id AND m.account_id = me.account_id
         WHERE me.account_id IN ({acct_in})
           AND me.embedding IS NOT NULL
           AND length(me.embedding) > 0
           {model_clause}
           {date_clause}
           AND {not_trash}
         ORDER BY me.created_at DESC
         LIMIT ?",
        date_clause = if after_ms.is_some() { "AND m.date >= ?" } else { "" },
        not_trash = NOT_TRASH_SPAM_SQL,
    );
    let mut embed_params: Vec<rusqlite::types::Value> = account_ids
        .iter()
        .map(|id| rusqlite::types::Value::Text(id.clone()))
        .collect();
    if let Some(m) = model {
        embed_params.push(rusqlite::types::Value::Text(m.to_string()));
    }
    if let Some(after) = after_ms {
        embed_params.push(rusqlite::types::Value::Integer(after));
    }
    embed_params.push(rusqlite::types::Value::Integer(MAX_VECTOR_ROWS as i64));

    let mut stmt = conn.prepare(&embed_sql).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(rusqlite::params_from_iter(embed_params), |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;

    // message_id → (best score, chunk index of that score)
    let mut best: HashMap<String, (f32, i64)> = HashMap::new();
    let mut batch: Vec<(String, i64, Vec<u8>)> = Vec::with_capacity(VECTOR_BATCH_ROWS);

    let absorb = |batch: &mut Vec<(String, i64, Vec<u8>)>,
                      best: &mut HashMap<String, (f32, i64)>| {
        if batch.is_empty() {
            return;
        }
        let scored: Vec<(String, i64, f32)> = if batch.len() >= PARALLEL_THRESHOLD {
            use rayon::prelude::*;
            batch
                .par_iter()
                .filter_map(|(msg_id, chunk, blob)| {
                    let emb = blob_to_f32(blob);
                    if emb.is_empty() {
                        return None; // corrupt blob — skip
                    }
                    Some((msg_id.clone(), *chunk, cosine_similarity(query_embedding, &emb)))
                })
                .collect()
        } else {
            batch
                .iter()
                .filter_map(|(msg_id, chunk, blob)| {
                    let emb = blob_to_f32(blob);
                    if emb.is_empty() {
                        return None;
                    }
                    Some((msg_id.clone(), *chunk, cosine_similarity(query_embedding, &emb)))
                })
                .collect()
        };

        for (msg_id, chunk, score) in scored {
            match best.get_mut(&msg_id) {
                Some(entry) if entry.0 >= score => {}
                Some(entry) => *entry = (score, chunk),
                None => {
                    best.insert(msg_id, (score, chunk));
                }
            }
        }
        batch.clear();
    };

    for row in rows.flatten() {
        batch.push(row);
        if batch.len() >= VECTOR_BATCH_ROWS {
            absorb(&mut batch, &mut best);
        }
    }
    absorb(&mut batch, &mut best);

    let mut scored: Vec<(String, f32, i64)> = best
        .into_iter()
        .map(|(msg_id, (score, chunk))| (msg_id, score, chunk))
        .collect();

    scored.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    Ok(scored)
}
