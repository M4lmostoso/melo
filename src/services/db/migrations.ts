import { getDb } from "./connection";
import { MIGRATIONS_CORE } from "./migrations/core";
import { MIGRATIONS_AI } from "./migrations/ai";
import { MIGRATIONS_IMAP } from "./migrations/imap";
import { MIGRATIONS_LABELS } from "./migrations/labels";

// Ordered DB migrations, split by era into ./migrations/* for readability.
// Each entry is a one-time, independent { version, description, sql }; the
// runner below applies any with a version greater than the stored schema version.
const MIGRATIONS = [
  ...MIGRATIONS_CORE,
  ...MIGRATIONS_AI,
  ...MIGRATIONS_IMAP,
  ...MIGRATIONS_LABELS,
];


// ---------------------------------------------------------------------------
// Post-migration data repair
// ---------------------------------------------------------------------------

/**
 * Windows-1252 code points that don't exist in Latin-1 (the 0x80–0x9F block).
 * Maps Unicode code point → Windows-1252 byte value.
 */
const WIN1252_EXTRA: Record<number, number> = {
  0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84,
  0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88,
  0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C,
  0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93,
  0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
  0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B,
  0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F,
};

function fixMojibake(s: string): string {
  let current = s;
  for (let iter = 0; iter < 3; iter++) {
    const bytes: number[] = [];
    let canMap = true;
    for (const ch of current) {
      const cp = ch.codePointAt(0)!;
      if (cp <= 0xFF) {
        bytes.push(cp);
      } else if (WIN1252_EXTRA[cp] !== undefined) {
        bytes.push(WIN1252_EXTRA[cp]!);
      } else {
        canMap = false;
        break;
      }
    }
    if (!canMap || !bytes.some((b) => b > 0x7F)) break;
    try {
      const fixed = new TextDecoder('utf-8', { fatal: true }).decode(new Uint8Array(bytes));
      if (fixed !== current) { current = fixed; continue; }
    } catch { /* invalid UTF-8 — stop */ }
    break;
  }
  return current;
}

/**
 * One-shot repair of Windows-1252 mojibake in existing subject/from_name fields.
 * Stored in settings so it only runs once per installation.
 */
export async function repairMojibakeData(): Promise<void> {
  const { getSetting, setSetting } = await import('./settings');
  const already = await getSetting('mojibake_repair_v1');
  if (already === '1') return;

  const db = await getDb();

  // Threads
  const threadRows = await db.select<{ id: string; account_id: string; subject: string }[]>(
    `SELECT id, account_id, subject FROM threads WHERE subject IS NOT NULL AND subject != ''`,
  );
  for (const row of threadRows) {
    const fixed = fixMojibake(row.subject);
    if (fixed !== row.subject) {
      await db.execute(
        `UPDATE threads SET subject = $1 WHERE account_id = $2 AND id = $3`,
        [fixed, row.account_id, row.id],
      );
    }
  }

  // Messages — subject and from_name
  const msgRows = await db.select<{ id: string; account_id: string; subject: string | null; from_name: string | null }[]>(
    `SELECT id, account_id, subject, from_name FROM messages WHERE subject IS NOT NULL OR from_name IS NOT NULL`,
  );
  for (const row of msgRows) {
    const fixedSubject = row.subject ? fixMojibake(row.subject) : null;
    const fixedName = row.from_name ? fixMojibake(row.from_name) : null;
    if (fixedSubject !== row.subject || fixedName !== row.from_name) {
      await db.execute(
        `UPDATE messages SET subject = $1, from_name = $2 WHERE account_id = $3 AND id = $4`,
        [fixedSubject, fixedName, row.account_id, row.id],
      );
    }
  }

  await setSetting('mojibake_repair_v1', '1');
  console.log(`[migrations] mojibake repair done: ${threadRows.length} threads, ${msgRows.length} messages checked`);
}

/**
 * One-shot repair: recalculate has_attachments on all threads excluding inline
 * and CID embedded images. Tracked in settings so it runs only once.
 * Call this fire-and-forget after startup — it must NOT block the splash screen.
 */
export async function repairHasAttachmentsFlags(): Promise<void> {
  const { getSetting, setSetting } = await import('./settings');
  const already = await getSetting('has_attachments_repair_v1');
  if (already === '1') return;

  const db = await getDb();
  await db.execute(
    `UPDATE threads
     SET has_attachments = CASE
       WHEN EXISTS (
         SELECT 1 FROM attachments a
         JOIN messages m ON a.message_id = m.id
         WHERE m.account_id = threads.account_id
           AND m.thread_id = threads.id
           AND m.is_trashed = 0
           AND a.is_inline = 0
           AND a.content_id IS NULL
       ) THEN 1 ELSE 0 END`,
  );
  await setSetting('has_attachments_repair_v1', '1');
  console.log('[migrations] has_attachments repair done');
}

/**
 * Split a SQL string into individual statements, correctly handling
 * BEGIN...END blocks (e.g. inside CREATE TRIGGER) that contain semicolons.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let depth = 0;
  const upper = sql.toUpperCase();

  for (let i = 0; i < sql.length; i++) {
    // Check for BEGIN keyword at word boundary
    if (
      upper.startsWith("BEGIN", i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 5 >= sql.length || /\W/.test(sql[i + 5]!))
    ) {
      depth++;
    }

    // Check for END keyword at word boundary
    if (
      upper.startsWith("END", i) &&
      (i === 0 || /\W/.test(sql[i - 1]!)) &&
      (i + 3 >= sql.length || /\W/.test(sql[i + 3]!)) &&
      depth > 0
    ) {
      depth--;
    }

    if (sql[i] === ";" && depth === 0) {
      const trimmed = current.trim();
      if (trimmed.length > 0) statements.push(trimmed);
      current = "";
    } else {
      current += sql[i];
    }
  }

  const trimmed = current.trim();
  if (trimmed.length > 0) statements.push(trimmed);

  return statements;
}

let _migrationPromise: Promise<void> | null = null;

export function runMigrations(): Promise<void> {
  if (!_migrationPromise) {
    _migrationPromise = _runMigrations();
  }
  return _migrationPromise;
}

async function _runMigrations(): Promise<void> {
  const db = await getDb();

  // Ensure migrations table exists
  await db.execute(`
    CREATE TABLE IF NOT EXISTS _migrations (
      version INTEGER PRIMARY KEY,
      description TEXT,
      applied_at INTEGER DEFAULT (unixepoch())
    )
  `);

  // Get already-applied versions
  const applied = await db.select<{ version: number }[]>(
    "SELECT version FROM _migrations ORDER BY version",
  );
  const appliedVersions = new Set(applied.map((r) => r.version));

  // Repair: if migration 14 is marked applied but imap_folder_path column is missing
  // from labels (schema change failed to persist), force re-run from v14.
  if (appliedVersions.has(14)) {
    const cols = await db.select<{ name: string }[]>(
      "SELECT name FROM pragma_table_info('labels') WHERE name = 'imap_folder_path'",
    );
    if (cols.length === 0) {
      console.warn("Migration v14 marked applied but imap_folder_path column missing — re-running from v14");
      await db.execute("DELETE FROM _migrations WHERE version >= 14");
      for (const v of [...appliedVersions].filter((v) => v >= 14)) appliedVersions.delete(v);
    }
  }

  // Repair: if migration 18 is marked applied but tasks table is missing,
  // remove the stale record so it re-runs
  if (appliedVersions.has(18)) {
    const tables = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='tasks'",
    );
    if (tables.length === 0) {
      console.warn("Migration v18 marked applied but tasks table missing — re-running");
      await db.execute("DELETE FROM _migrations WHERE version = 18");
      appliedVersions.delete(18);
    }
  }

  // Repair: if migration 25 is marked applied but group_id column is missing
  // from signatures, force re-run v25.
  if (appliedVersions.has(25)) {
    const cols = await db.select<{ name: string }[]>(
      "SELECT name FROM pragma_table_info('signatures') WHERE name = 'group_id'",
    );
    if (cols.length === 0) {
      console.warn("Migration v25 marked applied but group_id column missing — re-running v25");
      await db.execute("DELETE FROM _migrations WHERE version = 25");
      appliedVersions.delete(25);
    }
  }

  // Repair: if migration 26 is marked applied but deleted_imap_uids table is missing,
  // force re-run v26 (can happen when HMR deploys code before app restart runs migrations).
  if (appliedVersions.has(26)) {
    const tables = await db.select<{ name: string }[]>(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='deleted_imap_uids'",
    );
    if (tables.length === 0) {
      console.warn("Migration v26 marked applied but deleted_imap_uids table missing — re-running v26");
      await db.execute("DELETE FROM _migrations WHERE version = 26");
      appliedVersions.delete(26);
    }
  }

  // Repair: if migration 38 is marked applied but message_embeddings.embedding still has
  // NOT NULL (meaning the DROP+CREATE in v38 did not fully persist), force re-run v38.
  if (appliedVersions.has(38)) {
    const cols = await db.select<{ notnull: number }[]>(
      `SELECT "notnull" FROM pragma_table_info('message_embeddings') WHERE name = 'embedding'`,
    );
    if (cols.length === 0 || cols[0]?.notnull === 1) {
      console.warn("Migration v38 marked applied but message_embeddings.embedding is NOT NULL — re-running v38");
      await db.execute("DELETE FROM _migrations WHERE version = 38");
      appliedVersions.delete(38);
    }
  }

  // Repair: if migration 41 is marked applied but color column is missing from accounts
  // (can happen when the multi-statement ALTER TABLE block only partially persisted)
  if (appliedVersions.has(41)) {
    const cols = await db.select<{ name: string }[]>(
      "SELECT name FROM pragma_table_info('accounts') WHERE name = 'color'",
    );
    if (cols.length === 0) {
      console.warn("Migration v41 marked applied but accounts.color column missing — re-running v41");
      await db.execute("DELETE FROM _migrations WHERE version = 41");
      appliedVersions.delete(41);
    }
  }

  // Pre-apply v42 without DDL if the color column already exists.
  // v42 re-runs the same ALTER TABLE ADD COLUMN statements as v41. Running them
  // inside BEGIN acquires a write lock even when they fail with "duplicate column",
  // blocking other connections for the full busy-timeout. Detecting up-front avoids
  // the lock entirely for users who already have the columns.
  if (!appliedVersions.has(42)) {
    const colorCols = await db.select<{ name: string }[]>(
      "SELECT name FROM pragma_table_info('accounts') WHERE name = 'color'",
    );
    if (colorCols.length > 0) {
      await db.execute(
        "INSERT OR IGNORE INTO _migrations (version, description) VALUES ($1, $2)",
        [42, "Ensure accounts.color/include_in_global/sort_order columns exist (repair for v41 partial failures)"],
      );
      appliedVersions.add(42);
    }
  }

  // Run pending migrations
  for (const migration of MIGRATIONS) {
    if (appliedVersions.has(migration.version)) continue;

    console.log(
      `Running migration v${migration.version}: ${migration.description}`,
    );

    // Split SQL into individual statements, respecting BEGIN...END blocks
    const statements = splitStatements(migration.sql);

    // Use a transaction so migrations are all-or-nothing
    await db.execute("BEGIN");
    try {
      for (const statement of statements) {
        try {
          await db.execute(statement);
        } catch (err) {
          // Tolerate "duplicate column" errors from ALTER TABLE ADD COLUMN
          // in case a migration was partially applied previously
          const msg = err instanceof Error ? err.message : String(err);
          if (msg.includes("duplicate column")) {
            console.warn(`Skipping duplicate column in v${migration.version}: ${msg}`);
          } else {
            throw err;
          }
        }
      }

      await db.execute(
        "INSERT OR IGNORE INTO _migrations (version, description) VALUES ($1, $2)",
        [migration.version, migration.description],
      );
      await db.execute("COMMIT");
    } catch (err) {
      await db.execute("ROLLBACK").catch(() => {});
      throw err;
    }
  }

  console.log("All migrations applied.");

  // One-time repair: fix IMAP messages stored with date=0 (Unix epoch / January 1970).
  // Root cause: mail-parser's to_timestamp() returned 0 for malformed Date headers and
  // the internal_date fallback was not applied because Some(0) is not None.
  // Fix: delete affected messages, roll back last_uid in folder_sync_state so the next
  // delta sync re-fetches only the broken UIDs with the corrected parsing logic.
  const dateRepairFlag = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'imap_date_repair_v1'",
  );
  if (dateRepairFlag.length === 0) {
    const broken = await db.select<{ id: string; account_id: string }[]>(
      "SELECT id, account_id FROM messages WHERE date = 0 AND id LIKE 'imap-%'",
    );
    if (broken.length > 0) {
      console.log(`[repair] Found ${broken.length} IMAP messages with date=0 — fixing...`);

      // Group by (account_id, folder), track minimum UID per folder so we can
      // roll back last_uid just enough to re-fetch only the affected messages.
      const folderMinUid = new Map<string, { accountId: string; folder: string; minUid: number }>();
      for (const msg of broken) {
        // id format: "imap-{account_id}-{folder}-{uid}"
        // account_id is known from the row — strip prefix + account_id to isolate "{folder}-{uid}"
        const prefix = `imap-${msg.account_id}-`;
        const rest = msg.id.slice(prefix.length);
        const lastDash = rest.lastIndexOf("-");
        if (lastDash < 0) continue;
        const folder = rest.slice(0, lastDash);
        const uid = parseInt(rest.slice(lastDash + 1), 10);
        if (isNaN(uid)) continue;

        const key = `${msg.account_id}::${folder}`;
        const existing = folderMinUid.get(key);
        if (!existing || uid < existing.minUid) {
          folderMinUid.set(key, { accountId: msg.account_id, folder, minUid: uid });
        }
      }

      // Roll back last_uid so delta sync re-fetches from just before the first broken UID.
      for (const { accountId, folder, minUid } of folderMinUid.values()) {
        await db.execute(
          "UPDATE folder_sync_state SET last_uid = $1 WHERE account_id = $2 AND folder_path = $3",
          [Math.max(0, minUid - 1), accountId, folder],
        );
      }

      // Delete broken messages and orphaned threads.
      await db.execute("DELETE FROM messages WHERE date = 0 AND id LIKE 'imap-%'");
      await db.execute(`
        DELETE FROM threads
        WHERE (account_id, id) NOT IN (SELECT account_id, thread_id FROM messages)
        AND account_id IN (SELECT id FROM accounts WHERE provider = 'imap')
      `);

      // Record the affected account IDs so App.tsx can trigger an explicit sync
      // immediately after startup (before the 60s background timer fires).
      const affectedAccountIds = [...new Set(broken.map((m) => m.account_id))];
      await db.execute(
        "INSERT OR REPLACE INTO settings (key, value) VALUES ('imap_date_repair_v1_pending_sync', $1)",
        [JSON.stringify(affectedAccountIds)],
      );

      console.log("[repair] IMAP date repair complete — affected folders will be re-synced.");
    }
    await db.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('imap_date_repair_v1', '1')",
    );
  }

  // One-time repair: force IMAP attachment resync with corrected Rust binary.
  // Migrations 20/21 may have run before the Rust fix was compiled in.
  // This uses a settings flag so it only runs once.
  const repairFlag = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'imap_attachment_repair_v1'",
  );
  if (repairFlag.length === 0) {
    const imapAccounts = await db.select<{ id: string }[]>(
      "SELECT id FROM accounts WHERE provider = 'imap'",
    );
    if (imapAccounts.length > 0) {
      console.log("[repair] Forcing IMAP attachment resync with corrected part IDs...");
      await db.execute(
        "DELETE FROM attachments WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap')",
      );
      await db.execute(
        "DELETE FROM folder_sync_state WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap')",
      );
      await db.execute(
        "UPDATE accounts SET history_id = NULL WHERE provider = 'imap'",
      );
    }
    await db.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('imap_attachment_repair_v1', '1')",
    );
  }

  // One-time repair: fix snippets that contain raw MIME boundary markers.
  // These were stored by saveSentMessageLocally before the nested-multipart fix.
  // Re-generate snippet from body_html when available; fall back to clearing it.
  const mimeSnippetRepairFlag = await db.select<{ value: string }[]>(
    "SELECT value FROM settings WHERE key = 'mime_snippet_repair_v1'",
  );
  if (mimeSnippetRepairFlag.length === 0) {
    const badRows = await db.select<{ id: string; account_id: string; body_html: string | null }[]>(
      "SELECT id, account_id, body_html FROM messages WHERE snippet LIKE '------=_%'",
    );
    if (badRows.length > 0) {
      console.log(`[repair] Fixing ${badRows.length} message(s) with MIME-boundary snippets...`);
      for (const row of badRows) {
        let newSnippet = "";
        if (row.body_html) {
          newSnippet = row.body_html
            .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
            .replace(/<[^>]+>/g, "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 200);
        }
        await db.execute(
          "UPDATE messages SET snippet = $1, body_text = $1 WHERE account_id = $2 AND id = $3",
          [newSnippet, row.account_id, row.id],
        );
      }
    }
    await db.execute(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('mime_snippet_repair_v1', '1')",
    );
  }
}
