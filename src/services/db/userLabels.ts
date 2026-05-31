import { getDb, withTransaction } from "./connection";

export interface UserLabel {
  id: string;
  name: string;
  color: string | null;
  account_id: string | null;
  system_label_id: string | null;
  sort_order: number;
  created_at: number;
}

export async function getUserLabelsForAccount(
  accountId: string,
): Promise<UserLabel[]> {
  const db = await getDb();
  return db.select<UserLabel[]>(
    "SELECT * FROM user_labels WHERE account_id = $1 ORDER BY sort_order ASC, name ASC",
    [accountId],
  );
}

export async function upsertUserLabel(label: {
  id: string;
  name: string;
  color?: string | null;
  accountId: string | null;
  systemLabelId?: string | null;
  sortOrder?: number;
}): Promise<void> {
  await withTransaction(async (db) => {
    await db.execute(
      `INSERT INTO user_labels (id, name, color, account_id, system_label_id, sort_order)
       VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0))
       ON CONFLICT(id) DO UPDATE SET
         name = $2,
         color = COALESCE($3, color),
         system_label_id = COALESCE($5, system_label_id)`,
      [
        label.id,
        label.name,
        label.color ?? null,
        label.accountId,
        label.systemLabelId ?? null,
        label.sortOrder ?? null,
      ],
    );
  });
}

export async function deleteUserLabel(id: string): Promise<void> {
  const db = await getDb();
  await db.execute("DELETE FROM user_labels WHERE id = $1", [id]);
}

export async function updateUserLabelSortOrder(
  accountId: string,
  labelOrders: { id: string; sortOrder: number }[],
): Promise<void> {
  const db = await getDb();
  await Promise.all(
    labelOrders.map(({ id, sortOrder }) =>
      db.execute(
        "UPDATE user_labels SET sort_order = $1 WHERE account_id = $2 AND id = $3",
        [sortOrder, accountId, id],
      ),
    ),
  );
}
