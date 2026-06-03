import { getDb } from "./connection";

export interface FolderLabelMapping {
  id: number;
  account_id: string;
  folder_path: string;
  label_id: string;
}

export async function getFolderLabelMapping(
  accountId: string,
  folderPath: string,
): Promise<FolderLabelMapping | null> {
  const db = await getDb();
  const rows = await db.select<FolderLabelMapping[]>(
    "SELECT * FROM imap_folder_label_mappings WHERE account_id = ?1 AND folder_path = ?2",
    [accountId, folderPath],
  );
  return rows[0] ?? null;
}

/** Returns the folder path mapped to a given label, or null if none. */
export async function getLabelFolderMapping(
  accountId: string,
  labelId: string,
): Promise<string | null> {
  const db = await getDb();
  const rows = await db.select<{ folder_path: string }[]>(
    "SELECT folder_path FROM imap_folder_label_mappings WHERE account_id = ?1 AND label_id = ?2",
    [accountId, labelId],
  );
  return rows[0]?.folder_path ?? null;
}

export async function getAllFolderLabelMappings(
  accountId: string,
): Promise<FolderLabelMapping[]> {
  const db = await getDb();
  return db.select<FolderLabelMapping[]>(
    "SELECT * FROM imap_folder_label_mappings WHERE account_id = ?1",
    [accountId],
  );
}

/** Upsert a folder→label mapping and immediately apply the label to all existing
 *  messages in that folder so already-synced threads get the tag retroactively. */
export async function setFolderLabelMapping(
  accountId: string,
  folderPath: string,
  labelId: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT INTO imap_folder_label_mappings (account_id, folder_path, label_id)
     VALUES (?1, ?2, ?3)
     ON CONFLICT(account_id, folder_path) DO UPDATE SET label_id = excluded.label_id`,
    [accountId, folderPath, labelId],
  );
  // Backfill: apply the label to every thread that already has messages in this folder
  await db.execute(
    `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id)
     SELECT DISTINCT m.account_id, m.thread_id, ?3
     FROM messages m
     WHERE m.account_id = ?1 AND m.imap_folder = ?2`,
    [accountId, folderPath, labelId],
  );
}

export async function removeFolderLabelMapping(
  accountId: string,
  folderPath: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    "DELETE FROM imap_folder_label_mappings WHERE account_id = ?1 AND folder_path = ?2",
    [accountId, folderPath],
  );
}

/** Called once per sync: inserts missing folder-mapped labels for all threads
 *  whose messages live in a mapped folder. Idempotent (INSERT OR IGNORE). */
export async function applyFolderLabelMappings(accountId: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `INSERT OR IGNORE INTO thread_labels (account_id, thread_id, label_id)
     SELECT DISTINCT m.account_id, m.thread_id, flm.label_id
     FROM messages m
     JOIN imap_folder_label_mappings flm
       ON flm.account_id = m.account_id AND flm.folder_path = m.imap_folder
     WHERE m.account_id = ?1`,
    [accountId],
  );
}
