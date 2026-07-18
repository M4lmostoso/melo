import { getDb } from "./connection";

export interface PendingOperation {
  id: string;
  account_id: string;
  operation_type: string;
  resource_id: string;
  params: string;
  status: string;
  retry_count: number;
  max_retries: number;
  next_retry_at: number | null;
  created_at: number;
  error_message: string | null;
}

export async function enqueuePendingOperation(
  accountId: string,
  operationType: string,
  resourceId: string,
  params: Record<string, unknown>,
): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  await db.execute(
    `INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params)
     VALUES ($1, $2, $3, $4, $5)`,
    [id, accountId, operationType, resourceId, JSON.stringify(params)],
  );
  return id;
}

/**
 * Persist an outgoing email BEFORE its undo window elapses, so a quit/crash during
 * the undo countdown can never lose the message. The row sits in status 'undo'
 * (invisible to the queue processor) until either:
 *  - the composer's timer fires and the main window claims it via claimUndoOperation, or
 *  - the user clicks Undo (deleteOperation), or
 *  - the deadline + grace passes and promoteExpiredUndoOperations flips it to 'pending'
 *    for the queue processor (app restarted / composer died mid-undo).
 */
export async function enqueueUndoSend(
  accountId: string,
  resourceId: string,
  params: Record<string, unknown>,
  undoDelaySeconds: number,
): Promise<string> {
  const db = await getDb();
  const id = crypto.randomUUID();
  // +15s grace so the live composer timer (which fires at undoDelaySeconds) always
  // wins the claim race against the periodic promotion in the queue processor.
  const promoteAt = Math.floor(Date.now() / 1000) + undoDelaySeconds + 15;
  await db.execute(
    `INSERT INTO pending_operations (id, account_id, operation_type, resource_id, params, status, next_retry_at)
     VALUES ($1, $2, $3, $4, $5, 'undo', $6)`,
    [id, accountId, "sendMessage", resourceId, JSON.stringify(params), promoteAt],
  );
  return id;
}

export async function updateOperationParams(
  id: string,
  params: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.execute(`UPDATE pending_operations SET params = $1 WHERE id = $2`, [
    JSON.stringify(params),
    id,
  ]);
}

/**
 * Merge additional keys into an operation's params without rewriting the whole
 * payload. For undo-send rows the params carry the full raw email (many MB for
 * attachment-heavy mail) — re-sending it over IPC just to add cleanup hints
 * froze the composer for seconds. json_patch touches only the given keys.
 */
export async function patchOperationParams(
  id: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE pending_operations SET params = json_patch(params, $1) WHERE id = $2`,
    [JSON.stringify(patch), id],
  );
}

/**
 * Cancel an undo-send: delete the row ONLY while it still sits in status 'undo'.
 * Returns false when the row was already claimed/promoted (the send is in
 * flight or done) — deleting it then would break the anti-loss invariant and
 * silently lie to the user about the send being cancelled.
 */
export async function cancelUndoOperation(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `DELETE FROM pending_operations WHERE id = $1 AND status = 'undo'`,
    [id],
  );
  return result.rowsAffected > 0;
}

/**
 * Compare-and-swap claim of an undo-send row. Returns true when this caller now
 * owns the send. Returns false when another owner (the queue processor, after
 * promotion) already took it — the caller must NOT send, or the mail goes out twice.
 */
export async function claimUndoOperation(id: string): Promise<boolean> {
  const db = await getDb();
  const result = await db.execute(
    `UPDATE pending_operations SET status = 'executing', next_retry_at = NULL
     WHERE id = $1 AND status = 'undo'`,
    [id],
  );
  return result.rowsAffected > 0;
}

/**
 * Promote undo-send rows whose deadline+grace has passed to 'pending' so the queue
 * processor sends them. Normally a no-op: the live composer claims its row first.
 * Only fires when the composer window died (or the app restarted) mid-undo.
 */
export async function promoteExpiredUndoOperations(): Promise<number> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  const result = await db.execute(
    `UPDATE pending_operations SET status = 'pending', next_retry_at = NULL
     WHERE status = 'undo' AND next_retry_at <= $1`,
    [now],
  );
  return result.rowsAffected;
}

export async function getPendingOperations(
  accountId?: string,
  limit = 50,
): Promise<PendingOperation[]> {
  const db = await getDb();
  const now = Math.floor(Date.now() / 1000);
  if (accountId) {
    return db.select<PendingOperation[]>(
      `SELECT * FROM pending_operations
       WHERE account_id = $1 AND status = 'pending'
         AND (next_retry_at IS NULL OR next_retry_at <= $2)
       ORDER BY created_at ASC LIMIT $3`,
      [accountId, now, limit],
    );
  }
  return db.select<PendingOperation[]>(
    `SELECT * FROM pending_operations
     WHERE status = 'pending'
       AND (next_retry_at IS NULL OR next_retry_at <= $1)
     ORDER BY created_at ASC LIMIT $2`,
    [now, limit],
  );
}

export async function updateOperationStatus(
  id: string,
  status: string,
  errorMessage?: string,
): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE pending_operations SET status = $1, error_message = $2 WHERE id = $3`,
    [status, errorMessage ?? null, id],
  );
}

export async function deleteOperation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(`DELETE FROM pending_operations WHERE id = $1`, [id]);
}

const BACKOFF_SCHEDULE = [60, 300, 900, 3600];

export async function incrementRetry(id: string): Promise<"failed" | "retrying"> {
  const db = await getDb();
  const rows = await db.select<{ retry_count: number; max_retries: number }[]>(
    `SELECT retry_count, max_retries FROM pending_operations WHERE id = $1`,
    [id],
  );
  const op = rows[0];
  if (!op) return "retrying";

  const newCount = op.retry_count + 1;
  if (newCount >= op.max_retries) {
    await db.execute(
      `UPDATE pending_operations SET status = 'failed', retry_count = $1 WHERE id = $2`,
      [newCount, id],
    );
    return "failed";
  }

  const backoffIdx = Math.min(newCount - 1, BACKOFF_SCHEDULE.length - 1);
  const delaySec = BACKOFF_SCHEDULE[backoffIdx]!;
  const nextRetryAt = Math.floor(Date.now() / 1000) + delaySec;

  await db.execute(
    `UPDATE pending_operations SET retry_count = $1, next_retry_at = $2 WHERE id = $3`,
    [newCount, nextRetryAt, id],
  );
  return "retrying";
}

export async function getPendingOpsCount(accountId?: string): Promise<number> {
  const db = await getDb();
  if (accountId) {
    const rows = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM pending_operations WHERE account_id = $1 AND status = 'pending'`,
      [accountId],
    );
    return rows[0]?.count ?? 0;
  }
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM pending_operations WHERE status = 'pending'`,
  );
  return rows[0]?.count ?? 0;
}

export async function getFailedOpsCount(accountId?: string): Promise<number> {
  const db = await getDb();
  if (accountId) {
    const rows = await db.select<{ count: number }[]>(
      `SELECT COUNT(*) as count FROM pending_operations WHERE account_id = $1 AND status = 'failed'`,
      [accountId],
    );
    return rows[0]?.count ?? 0;
  }
  const rows = await db.select<{ count: number }[]>(
    `SELECT COUNT(*) as count FROM pending_operations WHERE status = 'failed'`,
  );
  return rows[0]?.count ?? 0;
}

export async function getPendingOpsForResource(
  accountId: string,
  resourceId: string,
): Promise<PendingOperation[]> {
  const db = await getDb();
  return db.select<PendingOperation[]>(
    `SELECT * FROM pending_operations
     WHERE account_id = $1 AND resource_id = $2 AND status = 'pending'
     ORDER BY created_at ASC`,
    [accountId, resourceId],
  );
}

/**
 * Return the set of resource_ids that have at least one pending operation.
 * One DB query instead of N per-thread queries — used during threading to skip
 * threads with local changes that should not be overwritten by sync.
 */
export async function getPendingOpResourceIds(accountId: string): Promise<Set<string>> {
  const db = await getDb();
  const rows = await db.select<{ resource_id: string }[]>(
    `SELECT DISTINCT resource_id FROM pending_operations
     WHERE account_id = $1 AND status = 'pending'`,
    [accountId],
  );
  return new Set(rows.map((r) => r.resource_id));
}

export async function compactQueue(accountId?: string): Promise<number> {
  const db = await getDb();

  // Get all pending ops grouped by resource
  const filter = accountId ? `AND account_id = '${accountId}'` : "";
  const ops = await db.select<PendingOperation[]>(
    `SELECT * FROM pending_operations WHERE status = 'pending' ${filter} ORDER BY created_at ASC`,
  );

  // Group by resource_id
  const byResource = new Map<string, PendingOperation[]>();
  for (const op of ops) {
    const key = `${op.account_id}:${op.resource_id}`;
    const list = byResource.get(key) ?? [];
    list.push(op);
    byResource.set(key, list);
  }

  const toDelete: string[] = [];

  for (const [, resourceOps] of byResource) {
    // Cancel out toggle pairs: star(true)+star(false), markRead(true)+markRead(false)
    for (const toggleType of ["star", "markRead"]) {
      const toggleOps = resourceOps.filter(
        (o) => o.operation_type === toggleType,
      );
      // If two ops with opposite values exist, remove both
      while (toggleOps.length >= 2) {
        const a = toggleOps.shift()!;
        const b = toggleOps.shift()!;
        const paramsA = JSON.parse(a.params);
        const paramsB = JSON.parse(b.params);
        if (
          (toggleType === "star" && paramsA.starred !== paramsB.starred) ||
          (toggleType === "markRead" && paramsA.read !== paramsB.read)
        ) {
          toDelete.push(a.id, b.id);
        }
      }
    }

    // Cancel addLabel+removeLabel for same label on same resource
    const addLabelOps = resourceOps.filter(
      (o) => o.operation_type === "addLabel",
    );
    const removeLabelOps = resourceOps.filter(
      (o) => o.operation_type === "removeLabel",
    );
    for (const addOp of addLabelOps) {
      const addParams = JSON.parse(addOp.params);
      const matchIdx = removeLabelOps.findIndex((r) => {
        const rParams = JSON.parse(r.params);
        return rParams.labelId === addParams.labelId;
      });
      if (matchIdx !== -1) {
        toDelete.push(addOp.id, removeLabelOps[matchIdx]!.id);
        removeLabelOps.splice(matchIdx, 1);
      }
    }

    // Collapse sequential moves: keep only the latest moveToFolder
    const moveOps = resourceOps.filter(
      (o) => o.operation_type === "moveToFolder",
    );
    if (moveOps.length > 1) {
      // Delete all but the last
      for (let i = 0; i < moveOps.length - 1; i++) {
        toDelete.push(moveOps[i]!.id);
      }
    }
  }

  // Delete compacted ops
  if (toDelete.length > 0) {
    const placeholders = toDelete.map((_, i) => `$${i + 1}`).join(",");
    await db.execute(
      `DELETE FROM pending_operations WHERE id IN (${placeholders})`,
      toDelete,
    );
  }

  return toDelete.length;
}

export async function clearFailedOperations(accountId?: string): Promise<void> {
  const db = await getDb();
  if (accountId) {
    await db.execute(
      `DELETE FROM pending_operations WHERE account_id = $1 AND status = 'failed'`,
      [accountId],
    );
  } else {
    await db.execute(`DELETE FROM pending_operations WHERE status = 'failed'`);
  }
}

export async function retryOperation(id: string): Promise<void> {
  const db = await getDb();
  await db.execute(
    `UPDATE pending_operations SET status = 'pending', retry_count = 0, next_retry_at = NULL, error_message = NULL
     WHERE id = $1`,
    [id],
  );
}

export async function retryFailedOperations(accountId?: string): Promise<void> {
  const db = await getDb();
  if (accountId) {
    await db.execute(
      `UPDATE pending_operations SET status = 'pending', retry_count = 0, next_retry_at = NULL, error_message = NULL
       WHERE account_id = $1 AND status = 'failed'`,
      [accountId],
    );
  } else {
    await db.execute(
      `UPDATE pending_operations SET status = 'pending', retry_count = 0, next_retry_at = NULL, error_message = NULL
       WHERE status = 'failed'`,
    );
  }
}
