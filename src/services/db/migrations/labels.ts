// DB migrations — labels / drafts (v45–v65).
// Sliced verbatim from migrations.ts; the runner lives in ../migrations.ts.
// Each entry is a one-time, ordered, independent { version, description, sql }.
export const MIGRATIONS_LABELS = [
  {
    version: 45,
    description: "Add source_message_id, rsvp_status and last_notified_at to calendar_events for email invite tracking",
    sql: `
      ALTER TABLE calendar_events ADD COLUMN source_message_id TEXT DEFAULT NULL;
      ALTER TABLE calendar_events ADD COLUMN rsvp_status TEXT DEFAULT NULL;
      ALTER TABLE calendar_events ADD COLUMN last_notified_at INTEGER DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_calendar_events_message ON calendar_events(source_message_id);
    `,
  },
  {
    version: 46,
    description: "Add is_draft flag to messages table for stable local draft tracking",
    sql: `ALTER TABLE messages ADD COLUMN is_draft INTEGER DEFAULT 0;`,
  },
  {
    version: 47,
    description: "Normalize messages.date to milliseconds (IMAP stored seconds, Gmail stored ms)",
    sql: `UPDATE messages SET date = date * 1000 WHERE date > 0 AND date < 10000000000;`,
  },
  {
    version: 48,
    description: "Add covering index for IMAP duplicate detection query (message_id_header + imap_folder + imap_uid)",
    sql: `CREATE INDEX IF NOT EXISTS idx_messages_dedup
          ON messages(account_id, message_id_header, imap_folder, imap_uid)
          WHERE message_id_header IS NOT NULL AND imap_folder IS NOT NULL AND imap_uid IS NOT NULL;`,
  },
  {
    version: 49,
    description: "Add Calendar Invites default smart folder and pruning setting",
    sql: `INSERT OR IGNORE INTO smart_folders (id, account_id, name, query, icon, sort_order, is_default)
          VALUES ('sf-calendar', NULL, 'Calendar Invites', 'has:calendar after:__LAST_6_MONTHS__', 'CalendarDays', 3, 1);
          INSERT OR IGNORE INTO settings (key, value) VALUES ('calendar_invite_pruning_months', '6');`,
  },
  {
    version: 50,
    description: "Reset keyword-based urgency scores so AI backfill can re-score all threads",
    sql: `UPDATE threads SET urgency_score = 0
          WHERE (manual_urgency_override IS NULL OR manual_urgency_override = 0)
            AND is_muted = 0;
          DELETE FROM ai_cache WHERE type = 'urgency';`,
  },
  {
    version: 51,
    description: "Remove orphaned local draft messages (is_draft=1, imap_uid IS NULL) that were never sent or appended to server",
    sql: `DELETE FROM messages WHERE is_draft = 1 AND imap_uid IS NULL;`,
  },
  {
    version: 52,
    description: "Remove all orphaned local draft messages (is_draft=1) regardless of imap_uid — drafts with a server UID but empty server Drafts folder are also stale",
    sql: `DELETE FROM messages WHERE is_draft = 1;`,
  },
  {
    version: 53,
    description: "Recalculate message_count for all threads excluding drafts to fix stale counts",
    sql: `UPDATE threads
          SET message_count = (
            SELECT COUNT(*) FROM messages
            WHERE account_id = threads.account_id
              AND thread_id = threads.id
              AND is_draft = 0
          );`,
  },
  {
    version: 54,
    description: "Add per-message Gmail label storage (gmail_label_ids) and fast trash flag (is_trashed)",
    sql: `ALTER TABLE messages ADD COLUMN gmail_label_ids TEXT;
          ALTER TABLE messages ADD COLUMN is_trashed INTEGER DEFAULT 0;
          CREATE INDEX IF NOT EXISTS idx_messages_trashed ON messages(account_id, thread_id, is_trashed);
          UPDATE messages SET is_trashed = 1
          WHERE imap_folder IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM labels l
              WHERE l.account_id = messages.account_id
                AND l.imap_folder_path = messages.imap_folder
                AND l.id = 'TRASH'
            );`,
  },
  {
    version: 55,
    description: "Add index to speed up attachment inline/CID filtering",
    sql: `CREATE INDEX IF NOT EXISTS idx_attachments_inline_cid ON attachments(message_id, is_inline, content_id);`,
  },
  {
    version: 56,
    description: "Add labels.visible column; hide IMAP user-folder labels from UI while keeping system labels for critical lookups",
    sql: `ALTER TABLE labels ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;
          UPDATE labels SET visible = 0
          WHERE imap_folder_path IS NOT NULL
            AND imap_special_use IS NULL
            AND id NOT IN ('INBOX', 'TRASH', 'SENT', 'DRAFT', 'SPAM', 'STARRED', 'UNREAD', 'all-mail', 'IMPORTANT')
            AND account_id IN (SELECT id FROM accounts WHERE provider IN ('imap', 'icloud'));`,
  },
  {
    version: 57,
    description: "Hide IMAP archive label from UI (v56 mistakenly kept it visible)",
    sql: `UPDATE labels SET visible = 0
          WHERE id = 'archive'
            AND imap_folder_path IS NOT NULL
            AND account_id IN (SELECT id FROM accounts WHERE provider IN ('imap', 'icloud'));`,
  },
  {
    version: 58,
    description: "Introduce user_labels as UI source of truth; create thread_user_labels and contact_user_labels; seed Gmail user labels",
    sql: `
      CREATE TABLE IF NOT EXISTS user_labels (
        id          TEXT    PRIMARY KEY,
        name        TEXT    NOT NULL,
        color       TEXT,
        account_id  TEXT,
        system_label_id TEXT,
        sort_order  INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT (unixepoch())
      );

      CREATE TABLE IF NOT EXISTS thread_user_labels (
        thread_id   TEXT NOT NULL,
        label_id    TEXT NOT NULL,
        status      TEXT NOT NULL DEFAULT 'applied',
        PRIMARY KEY (thread_id, label_id)
      );

      CREATE TABLE IF NOT EXISTS contact_user_labels (
        contact_id  TEXT NOT NULL,
        label_id    TEXT NOT NULL,
        PRIMARY KEY (contact_id, label_id)
      );

      INSERT OR IGNORE INTO user_labels (id, name, color, account_id, system_label_id, sort_order, created_at)
      SELECT l.id, l.name, l.color_bg, l.account_id, l.id, l.sort_order, unixepoch()
      FROM   labels l
      JOIN   accounts a ON l.account_id = a.id
      WHERE  a.provider = 'gmail_api'
        AND  l.type = 'user';
    `,
  },
  {
    version: 59,
    description: "Add pending_label_assignments for deferred cross-account user-label carry-over on IMAP targets (applied once the moved message is synced)",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_label_assignments (
        account_id        TEXT    NOT NULL,
        message_id_header TEXT    NOT NULL,
        label_id          TEXT    NOT NULL,
        created_at        INTEGER NOT NULL DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id_header, label_id)
      );
      CREATE INDEX IF NOT EXISTS idx_pending_label_assignments_account
        ON pending_label_assignments(account_id);
    `,
  },
  {
    version: 60,
    description: "Add AI auto-label per-account flag and global settings",
    sql: `
      ALTER TABLE accounts ADD COLUMN ai_auto_label_enabled INTEGER DEFAULT 0;
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_auto_label_enabled', 'false'),
        ('ai_auto_label_threshold', '75');
    `,
  },
  {
    version: 61,
    description: "Add IMAP folder ↔ user label bidirectional mapping table",
    sql: `
      CREATE TABLE IF NOT EXISTS imap_folder_label_mappings (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        account_id TEXT    NOT NULL,
        folder_path TEXT   NOT NULL,
        label_id   TEXT    NOT NULL,
        UNIQUE(account_id, folder_path),
        FOREIGN KEY(label_id) REFERENCES user_labels(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_imap_flm_account
        ON imap_folder_label_mappings(account_id);
      CREATE INDEX IF NOT EXISTS idx_imap_flm_label
        ON imap_folder_label_mappings(account_id, label_id);
    `,
  },
  {
    version: 62,
    description:
      "Backfill is_trashed=1 on messages of fully-trashed threads (unifies trash model on is_trashed). Threads carry the TRASH label only when all their messages are trashed, so this is safe.",
    sql: `
      UPDATE messages SET is_trashed = 1
      WHERE is_draft = 0 AND is_trashed = 0 AND EXISTS (
        SELECT 1 FROM thread_labels tl
        WHERE tl.account_id = messages.account_id
          AND tl.thread_id = messages.thread_id
          AND tl.label_id = 'TRASH'
      );
    `,
  },
  {
    version: 63,
    description:
      "Add urgency_reason (AI rationale for the urgency score) and urgency_reply_decayed (score lowered by a partial, non-closing reply) to threads.",
    sql: `
      ALTER TABLE threads ADD COLUMN urgency_reason TEXT;
      ALTER TABLE threads ADD COLUMN urgency_reply_decayed INTEGER DEFAULT 0;
    `,
  },
  {
    version: 64,
    description:
      "Repair over-trashing from v62: that migration set is_trashed=1 on EVERY non-draft message of any thread carrying the TRASH label, but for Gmail a thread's labels are the UNION of its messages' labels, so a single trashed message (e.g. a discarded draft) made the whole thread carry TRASH — wrongly trashing its still-live INBOX/SENT messages and leaving the thread to render empty. Un-trash any Gmail message whose own labels do NOT include TRASH (gmail_label_ids is the source of truth). IMAP messages (gmail_label_ids IS NULL) are governed by their folder mapping and left untouched. Idempotent.",
    sql: `
      UPDATE messages SET is_trashed = 0
      WHERE is_trashed = 1
        AND is_draft = 0
        AND gmail_label_ids IS NOT NULL
        AND gmail_label_ids NOT LIKE '%"TRASH"%';
    `,
  },
  {
    version: 65,
    description:
      "Second-pass repair for v62 over-trashing: v64 only fixed Gmail messages that already had gmail_label_ids populated (column added in v60). Messages synced before v60 — or never re-synced after v62 ran — kept gmail_label_ids=NULL and therefore is_trashed=1 even though they belong to threads still carrying the INBOX label. Fix: for Gmail accounts, un-trash any message whose thread has INBOX in thread_labels but whose own gmail_label_ids is NULL (IMAP governs by folder, not thread_labels, so only touch Gmail accounts). Idempotent.",
    sql: `
      UPDATE messages SET is_trashed = 0
      WHERE is_trashed = 1
        AND is_draft = 0
        AND account_id IN (SELECT id FROM accounts WHERE provider = 'gmail_api')
        AND gmail_label_ids IS NULL
        AND EXISTS (
          SELECT 1 FROM thread_labels tl
          WHERE tl.account_id = messages.account_id
            AND tl.thread_id = messages.thread_id
            AND tl.label_id = 'INBOX'
        );
    `,
  },
  {
    version: 66,
    description:
      "PEC (Posta Elettronica Certificata) support: pec_enabled flag on accounts (toggles PEC mode + the 'Ricevute' smart folder) and is_pec_receipt flag on messages (marks accettazione/consegna receipts so they are kept out of Inbox, always read, and surfaced only in the Ricevute folder / All Mail).",
    sql: `
      ALTER TABLE accounts ADD COLUMN pec_enabled INTEGER DEFAULT 0;
      ALTER TABLE messages ADD COLUMN is_pec_receipt INTEGER DEFAULT 0;
    `,
  },
];
