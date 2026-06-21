// DB migrations — AI / threading (v8–v21).
// Sliced verbatim from migrations.ts; the runner lives in ../migrations.ts.
// Each entry is a one-time, ordered, independent { version, description, sql }.
export const MIGRATIONS_AI = [
  {
    version: 8,
    description: "Smart folders",
    sql: `
      CREATE TABLE IF NOT EXISTS smart_folders (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        name TEXT NOT NULL,
        query TEXT NOT NULL,
        icon TEXT DEFAULT 'Search',
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        is_default INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );
      CREATE INDEX idx_smart_folders_account ON smart_folders(account_id);

      INSERT INTO smart_folders (id, account_id, name, query, icon, sort_order, is_default) VALUES
        ('sf-unread', NULL, 'Unread', 'is:unread', 'MailOpen', 0, 1),
        ('sf-attachments', NULL, 'Has Attachments', 'has:attachment', 'Paperclip', 1, 1),
        ('sf-starred-recent', NULL, 'Starred This Week', 'is:starred after:__LAST_7_DAYS__', 'Star', 2, 1);
    `,
  },
  {
    version: 9,
    description: "Email authentication results",
    sql: `ALTER TABLE messages ADD COLUMN auth_results TEXT;`,
  },
  {
    version: 10,
    description: "Mute thread support",
    sql: `
      ALTER TABLE threads ADD COLUMN is_muted INTEGER DEFAULT 0;
      CREATE INDEX idx_threads_muted ON threads(account_id, is_muted);
    `,
  },
  {
    version: 11,
    description: "Phishing detection cache and allowlist",
    sql: `
      CREATE TABLE IF NOT EXISTS link_scan_results (
        message_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        result_json TEXT NOT NULL,
        scanned_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (account_id, message_id)
      );

      CREATE TABLE IF NOT EXISTS phishing_allowlist (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        sender_address TEXT NOT NULL,
        created_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, sender_address)
      );

      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('phishing_detection_enabled', 'true'),
        ('phishing_sensitivity', 'default');
    `,
  },
  {
    version: 12,
    description: "Quick steps",
    sql: `
      CREATE TABLE IF NOT EXISTS quick_steps (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        shortcut TEXT,
        actions_json TEXT NOT NULL,
        icon TEXT,
        is_enabled INTEGER DEFAULT 1,
        continue_on_error INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch())
      );
      CREATE INDEX idx_quick_steps_account ON quick_steps(account_id);
    `,
  },
  {
    version: 13,
    description: "Contact notes",
    sql: `ALTER TABLE contacts ADD COLUMN notes TEXT;`,
  },
  {
    version: 14,
    description: "IMAP/SMTP provider support",
    sql: `
      -- Accounts: provider and connection settings
      ALTER TABLE accounts ADD COLUMN provider TEXT DEFAULT 'gmail_api';
      ALTER TABLE accounts ADD COLUMN imap_host TEXT;
      ALTER TABLE accounts ADD COLUMN imap_port INTEGER;
      ALTER TABLE accounts ADD COLUMN imap_security TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_host TEXT;
      ALTER TABLE accounts ADD COLUMN smtp_port INTEGER;
      ALTER TABLE accounts ADD COLUMN smtp_security TEXT;
      ALTER TABLE accounts ADD COLUMN auth_method TEXT DEFAULT 'oauth';
      ALTER TABLE accounts ADD COLUMN imap_password TEXT;

      -- Messages: RFC 2822 threading headers and IMAP identifiers
      ALTER TABLE messages ADD COLUMN message_id_header TEXT;
      ALTER TABLE messages ADD COLUMN references_header TEXT;
      ALTER TABLE messages ADD COLUMN in_reply_to_header TEXT;
      ALTER TABLE messages ADD COLUMN imap_uid INTEGER;
      ALTER TABLE messages ADD COLUMN imap_folder TEXT;

      -- Labels: IMAP folder mapping
      ALTER TABLE labels ADD COLUMN imap_folder_path TEXT;
      ALTER TABLE labels ADD COLUMN imap_special_use TEXT;

      -- Attachments: IMAP MIME part identifier
      ALTER TABLE attachments ADD COLUMN imap_part_id TEXT;

      -- Folder sync state for IMAP accounts
      CREATE TABLE IF NOT EXISTS folder_sync_state (
        account_id TEXT NOT NULL,
        folder_path TEXT NOT NULL,
        uidvalidity INTEGER,
        last_uid INTEGER DEFAULT 0,
        modseq INTEGER,
        last_sync_at INTEGER,
        PRIMARY KEY (account_id, folder_path),
        FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE CASCADE
      );

      -- Indexes for IMAP message lookups
      CREATE INDEX IF NOT EXISTS idx_messages_imap_uid ON messages(account_id, imap_folder, imap_uid);
      CREATE INDEX IF NOT EXISTS idx_messages_message_id ON messages(message_id_header);
    `,
  },
  {
    version: 15,
    description: "OAuth2 provider support for IMAP/SMTP",
    sql: `
      ALTER TABLE accounts ADD COLUMN oauth_provider TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_id TEXT;
      ALTER TABLE accounts ADD COLUMN oauth_client_secret TEXT;
    `,
  },
  {
    version: 16,
    description: "Optional IMAP/SMTP username override",
    sql: `ALTER TABLE accounts ADD COLUMN imap_username TEXT;`,
  },
  {
    version: 17,
    description: "Offline mode: pending operations queue and local drafts",
    sql: `
      CREATE TABLE IF NOT EXISTS pending_operations (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        operation_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        params TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT 10,
        next_retry_at INTEGER,
        created_at INTEGER DEFAULT (unixepoch()),
        error_message TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_pending_ops_status ON pending_operations(status, next_retry_at);
      CREATE INDEX IF NOT EXISTS idx_pending_ops_resource ON pending_operations(account_id, resource_id);

      CREATE TABLE IF NOT EXISTS local_drafts (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        to_addresses TEXT,
        cc_addresses TEXT,
        bcc_addresses TEXT,
        subject TEXT,
        body_html TEXT,
        reply_to_message_id TEXT,
        thread_id TEXT,
        from_email TEXT,
        signature_id TEXT,
        remote_draft_id TEXT,
        attachments TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        sync_status TEXT DEFAULT 'pending'
      );
    `,
  },
  {
    version: 18,
    description: "AI auto-drafts writing style profiles and task manager",
    sql: `
      -- Writing style profiles for AI auto-drafts
      CREATE TABLE IF NOT EXISTS writing_style_profiles (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        profile_text TEXT NOT NULL,
        sample_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id)
      );

      -- Tasks
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        title TEXT NOT NULL,
        description TEXT,
        priority TEXT DEFAULT 'none',
        is_completed INTEGER DEFAULT 0,
        completed_at INTEGER,
        due_date INTEGER,
        parent_id TEXT,
        thread_id TEXT,
        thread_account_id TEXT,
        sort_order INTEGER DEFAULT 0,
        recurrence_rule TEXT,
        next_recurrence_at INTEGER,
        tags_json TEXT DEFAULT '[]',
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        FOREIGN KEY (parent_id) REFERENCES tasks(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_tasks_account ON tasks(account_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_completed_due ON tasks(is_completed, due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(thread_account_id, thread_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_due ON tasks(due_date);
      CREATE INDEX IF NOT EXISTS idx_tasks_sort ON tasks(sort_order);

      -- Task tags
      CREATE TABLE IF NOT EXISTS task_tags (
        tag TEXT NOT NULL,
        account_id TEXT,
        color TEXT,
        sort_order INTEGER DEFAULT 0,
        created_at INTEGER DEFAULT (unixepoch()),
        PRIMARY KEY (tag, account_id)
      );

      -- Default settings for auto-drafts
      INSERT OR IGNORE INTO settings (key, value) VALUES
        ('ai_auto_draft_enabled', 'true'),
        ('ai_writing_style_enabled', 'true');
    `,
  },
  {
    version: 19,
    description: "CalDAV calendar integration",
    sql: `
      -- Multi-calendar support
      CREATE TABLE IF NOT EXISTS calendars (
        id TEXT PRIMARY KEY,
        account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'google',
        remote_id TEXT NOT NULL,
        display_name TEXT,
        color TEXT,
        is_primary INTEGER DEFAULT 0,
        is_visible INTEGER DEFAULT 1,
        sync_token TEXT,
        ctag TEXT,
        created_at INTEGER DEFAULT (unixepoch()),
        updated_at INTEGER DEFAULT (unixepoch()),
        UNIQUE(account_id, remote_id)
      );
      CREATE INDEX IF NOT EXISTS idx_calendars_account ON calendars(account_id);

      -- Extend calendar_events with multi-calendar and CalDAV fields
      ALTER TABLE calendar_events ADD COLUMN calendar_id TEXT REFERENCES calendars(id) ON DELETE CASCADE;
      ALTER TABLE calendar_events ADD COLUMN remote_event_id TEXT;
      ALTER TABLE calendar_events ADD COLUMN etag TEXT;
      ALTER TABLE calendar_events ADD COLUMN ical_data TEXT;
      ALTER TABLE calendar_events ADD COLUMN uid TEXT;

      CREATE INDEX IF NOT EXISTS idx_cal_events_calendar ON calendar_events(calendar_id);

      -- CalDAV fields on accounts
      ALTER TABLE accounts ADD COLUMN caldav_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_username TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_password TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_principal_url TEXT;
      ALTER TABLE accounts ADD COLUMN caldav_home_url TEXT;
      ALTER TABLE accounts ADD COLUMN calendar_provider TEXT;
    `,
  },
  {
    version: 20,
    description: "Fix IMAP attachment part IDs and trigger resync",
    sql: `
      -- Delete IMAP attachment records that have wrong sequential part IDs.
      -- They will be re-created with correct MIME section paths on next sync.
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');

      -- Reset IMAP folder sync state so delta sync re-fetches all messages,
      -- which will re-store attachments with correct part IDs.
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
  {
    version: 21,
    description: "Force IMAP full resync for corrected attachment part IDs",
    sql: `
      -- Clear history_id so syncManager routes IMAP accounts through
      -- imapInitialSync (which stores attachments per-message) instead of
      -- the delta path that may skip already-known UIDs.
      UPDATE accounts SET history_id = NULL
        WHERE provider = 'imap';

      -- Ensure folder sync state is clear (may have been partially
      -- repopulated if v20 migration's sync failed due to DB lock).
      DELETE FROM folder_sync_state
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');

      -- Ensure stale attachment records are gone.
      DELETE FROM attachments
        WHERE account_id IN (SELECT id FROM accounts WHERE provider = 'imap');
    `,
  },
];
