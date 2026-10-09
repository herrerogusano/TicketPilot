export const eventRetentionDays = 30;
export const maxEventPruneBatch = 100;

export function isEventMaintenanceDue(now: Date): boolean {
  return Number.isFinite(now.getTime()) && now.getUTCMinutes() === 0;
}

export async function pruneExpiredEvents(db: D1Database, now = new Date()): Promise<number> {
  if (!Number.isFinite(now.getTime())) throw new Error("invalid_retention_time");
  const cutoff = new Date(now.getTime() - eventRetentionDays * 86_400_000).toISOString();
  // Receipt, approval, payload and operation identities remain in tickets permanently.
  // Only old redacted event history is bounded; no tickets/usage reservations are removed.
  const result = await db
    .prepare(`DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE at < ? ORDER BY at, id LIMIT ?
    )`)
    .bind(cutoff, maxEventPruneBatch)
    .run();
  return result.meta.changes;
}
