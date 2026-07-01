// DB migrations — IMAP / multi-account (v22–v44).
// Sliced verbatim from migrations.ts; the runner lives in ../migrations.ts.
// Each entry is a one-time, ordered, independent { version, description, sql }.
export const MIGRATIONS_IMAP = [
  {
    version: 22,
    description: "Add smart label rules table for AI-powered auto-labeling",
    sql: `
      CREATE TABLE smart_label_rules (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        label_id TEXT NOT NULL,
        ai_description TEXT NOT NULL,
        criteria_json TEXT,
        is_enabled INTEGER DEFAULT 1,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_smart_label_rules_account ON smart_label_rules(account_id);
    `,
  },
  {
    version: 23,
    description: "Accept self-signed certificates for IMAP/SMTP",
    sql: `ALTER TABLE accounts ADD COLUMN accept_invalid_certs INTEGER DEFAULT 0;`,
  },
   {
     version: 24,
     description: "Reset contact frequency inflated by Google Contacts sync bug",
     sql: `UPDATE contacts SET frequency = 0;`,
   },
   {
     version: 25,
     description: "Add group_id to signatures for cross-account signature sharing",
     sql: `
       -- Add group_id column.
       -- SQLite does not support "IF NOT EXISTS" for ADD COLUMN,
       -- but this migration runs only once (version check in runner).
       ALTER TABLE signatures ADD COLUMN group_id TEXT;

       -- For existing signatures, set group_id = id (each is its own group/master)
       UPDATE signatures SET group_id = id WHERE group_id IS NULL;

       -- Add index for group lookups
       CREATE INDEX IF NOT EXISTS idx_signatures_group ON signatures(group_id);
     `,
   },
   {
     version: 26,
     description: "Add tombstone table for deleted IMAP UIDs to prevent zombie re-import",
     sql: `
       CREATE TABLE IF NOT EXISTS deleted_imap_uids (
         account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
         folder_path TEXT NOT NULL,
         uid INTEGER NOT NULL,
         deleted_at INTEGER NOT NULL DEFAULT (unixepoch()),
         PRIMARY KEY (account_id, folder_path, uid)
       );
       CREATE INDEX IF NOT EXISTS idx_deleted_imap_uids_account ON deleted_imap_uids(account_id, folder_path);
     `,
   },
   {
     version: 27,
     description: "Remove spurious DRAFT labels from IMAP INBOX threads caused by incorrect \\Draft flag handling",
     sql: `
       DELETE FROM thread_labels
       WHERE label_id = 'DRAFT'
         AND EXISTS (
           SELECT 1 FROM thread_labels tl2
           WHERE tl2.account_id = thread_labels.account_id
             AND tl2.thread_id = thread_labels.thread_id
             AND tl2.label_id = 'INBOX'
         );
     `,
   },
   {
     version: 28,
     description: "Separate SMTP credentials (smtp_username, smtp_password) for accounts that require different outgoing auth",
     sql: `
       ALTER TABLE accounts ADD COLUMN smtp_username TEXT;
       ALTER TABLE accounts ADD COLUMN smtp_password TEXT;
     `,
   },
   {
     version: 29,
     description: "Add direction (incoming/outgoing) and soft-delete (deleted_at) to tasks",
     sql: `
       ALTER TABLE tasks ADD COLUMN direction TEXT NOT NULL DEFAULT 'outgoing';
       ALTER TABLE tasks ADD COLUMN deleted_at INTEGER;
       CREATE INDEX IF NOT EXISTS idx_tasks_deleted ON tasks(deleted_at);
       CREATE INDEX IF NOT EXISTS idx_tasks_direction ON tasks(direction);
     `,
   },
   {
     version: 30,
     description: "Add standalone index on tasks(thread_id) for efficient thread-based grouping queries",
     sql: `
       CREATE INDEX IF NOT EXISTS idx_tasks_thread_id ON tasks(thread_id);
     `,
   },
  {
    version: 31,
    description: "Add message_embeddings table for local semantic search (RAG) and initialize embedding settings",
    sql: `
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_account ON message_embeddings(account_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_account_created ON message_embeddings(account_id, created_at);

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('rag_enabled', 'false'),
        ('embedding_model', 'nomic-embed-text'),
        ('rag_chunk_size', '512'),
        ('rag_batch_size', '10');
    `,
  },
  {
    version: 32,
    description: "Migrate message_embeddings to Base64-encoded binary (3x smaller than JSON), triggering clean re-indexing",
    sql: `
      DROP TABLE IF EXISTS message_embeddings;
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        account_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (message_id)
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_account ON message_embeddings(account_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_account_created ON message_embeddings(account_id, created_at);
    `,
  },
  {
    version: 33,
    description: "Add urgency/sentiment/heat scores to threads and interaction_history table for sender reputation engine",
    sql: `
      ALTER TABLE threads ADD COLUMN urgency_score REAL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN sentiment_score REAL DEFAULT 0;
      ALTER TABLE threads ADD COLUMN manual_urgency_override INTEGER DEFAULT 0;
      ALTER TABLE threads ADD COLUMN is_heat_extinguished INTEGER DEFAULT 0;

      CREATE TABLE IF NOT EXISTS interaction_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT NOT NULL,
        from_address TEXT NOT NULL,
        action TEXT NOT NULL,
        thread_id TEXT,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_interaction_account_from ON interaction_history(account_id, from_address, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_interaction_created ON interaction_history(created_at);

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_urgency_mute_window_days', '30'),
        ('ai_urgency_mute_threshold', '3'),
        ('ai_urgency_auto_extinguish', 'true');
    `,
  },
  {
    version: 34,
    description: "Add temporal urgency decay settings and RAG priority domains for contextual boosting",
    sql: `
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_urgency_decay_start_days', '20'),
        ('ai_urgency_decay_floor_days', '30'),
        ('rag_priority_domains', '');
    `,
  },
  {
    version: 35,
    description: "Add per-account rag_enabled flag and global behavioral intelligence settings",
    sql: `
      ALTER TABLE accounts ADD COLUMN rag_enabled INTEGER DEFAULT 0;

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_behavior_enabled', 'true'),
        ('ai_urgency_enabled', 'true');
    `,
  },
  {
    version: 36,
    description: "Fix message_embeddings FK mismatch: reference composite PK (account_id, id) instead of standalone id",
    sql: `
      DROP TABLE IF EXISTS message_embeddings;
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        embedding TEXT NOT NULL,
        model TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id),
        FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_account ON message_embeddings(account_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_account_created ON message_embeddings(account_id, created_at);
    `,
  },
  {
    version: 37,
    description: "Add app_icon_style setting for dock/tray icon appearance preference",
    sql: `
      INSERT OR IGNORE INTO settings (key, value) VALUES ('app_icon_style', 'auto');
    `,
  },
  {
    version: 38,
    description: "Migrate message_embeddings from Base64 TEXT to binary BLOB for native Rust vector search; clears existing data to force re-indexing",
    sql: `
      DROP TABLE IF EXISTS message_embeddings;
      CREATE TABLE IF NOT EXISTS message_embeddings (
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        embedding BLOB,
        model TEXT NOT NULL DEFAULT 'nomic-embed-text',
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id),
        FOREIGN KEY (account_id, message_id) REFERENCES messages(account_id, id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_account ON message_embeddings(account_id);
      CREATE INDEX IF NOT EXISTS idx_embeddings_account_created ON message_embeddings(account_id, created_at);
    `,
  },
  {
    version: 39,
    description: "Fix IMAP attachment part IDs: move from gmail_attachment_id to imap_part_id for rows populated before the column separation was in place",
    sql: `
      UPDATE attachments
      SET imap_part_id = gmail_attachment_id, gmail_attachment_id = NULL
      WHERE imap_part_id IS NULL
        AND gmail_attachment_id IS NOT NULL
        AND message_id LIKE 'imap-%';
    `,
  },
  {
    version: 40,
    description: "Add composite indexes to eliminate full-table-scans in unread-count and label-filter queries",
    sql: `
      CREATE INDEX IF NOT EXISTS idx_threads_account_unread
        ON threads(account_id, is_read);

      CREATE INDEX IF NOT EXISTS idx_thread_labels_thread
        ON thread_labels(account_id, thread_id);

      CREATE INDEX IF NOT EXISTS idx_thread_categories_thread
        ON thread_categories(account_id, thread_id);
    `,
  },
  {
    version: 41,
    description: "Add per-account color, include_in_global flag, sort_order for Spark-style multi-account sidebar; index messages for unified inbox subquery",
    sql: `
      ALTER TABLE accounts ADD COLUMN color TEXT DEFAULT NULL;
      ALTER TABLE accounts ADD COLUMN include_in_global INTEGER DEFAULT 1;
      ALTER TABLE accounts ADD COLUMN sort_order INTEGER DEFAULT 0;

      CREATE INDEX IF NOT EXISTS idx_messages_thread_account_date
        ON messages (thread_id, account_id, date DESC);
    `,
  },
  {
    version: 42,
    description: "Ensure accounts.color/include_in_global/sort_order columns exist (repair for v41 partial failures)",
    sql: `
      ALTER TABLE accounts ADD COLUMN color TEXT DEFAULT NULL;
      ALTER TABLE accounts ADD COLUMN include_in_global INTEGER DEFAULT 1;
      ALTER TABLE accounts ADD COLUMN sort_order INTEGER DEFAULT 0;
    `,
  },
  {
    version: 43,
    description: "Add display label column to accounts for custom in-app identification (e.g. Work, Personal)",
    sql: `
      ALTER TABLE accounts ADD COLUMN label TEXT DEFAULT NULL;
    `,
  },
  {
    version: 44,
    description: "Add user_label and user_color columns to calendars for per-calendar customization (CalDAV)",
    sql: `
      ALTER TABLE calendars ADD COLUMN user_label TEXT DEFAULT NULL;
      ALTER TABLE calendars ADD COLUMN user_color TEXT DEFAULT NULL;
    `,
  },
  {
    version: 67,
    description: "Track UIDs the server lists but repeatedly refuses to serve (unfetchable skip-list), so the self-healing reconcile stops re-grinding them after a configurable number of attempts while keeping them visible to the user",
    sql: `
      CREATE TABLE IF NOT EXISTS imap_unfetchable_uids (
        account_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        uid INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 1,
        first_seen_at INTEGER NOT NULL DEFAULT (unixepoch()),
        last_attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, folder_path, uid)
      );
      CREATE INDEX IF NOT EXISTS idx_unfetchable_account ON imap_unfetchable_uids(account_id);
    `,
  },
];
