import type { HubSpotTicket } from "../adapters/hubspot";

export type WorkflowCreateStatus = "PENDING" | "CREATING" | "STARTED" | "MANUAL_REVIEW";

export type TicketRow = {
  hubspot_ticket_id: string;
  workflow_instance_id: string;
  created_at: string;
  updated_at: string;
  hubspot_created_at: string;
  subject: string;
  state: string;
  admission_utc_day: string;
  workflow_create_status: WorkflowCreateStatus;
  workflow_create_attempts: number;
};

export type ClaimResult = "claimed" | "duplicate" | "daily_limit";

export class TicketRepository {
  constructor(private readonly db: D1Database) {}

  async claimEligible(ticket: HubSpotTicket, now = new Date()): Promise<ClaimResult> {
    const utcDay = now.toISOString().slice(0, 10);
    const current = now.toISOString();
    const workflowId = workflowInstanceId(ticket.id);
    const inserted = await this.db
      .prepare(
        `INSERT INTO tickets (
          hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
          subject, state, admission_utc_day, workflow_create_status
        )
        SELECT ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, 'PENDING'
        WHERE COALESCE((
          SELECT accepted_ticket_count FROM daily_usage WHERE utc_day = ?
        ), 0) < 20
        ON CONFLICT (hubspot_ticket_id) DO NOTHING`,
      )
      .bind(
        ticket.id,
        workflowId,
        current,
        current,
        ticket.createdAt,
        ticket.subject,
        utcDay,
        utcDay,
      )
      .run();
    if ((inserted.meta.changes ?? 0) > 0) return "claimed";

    const existing = await this.db
      .prepare("SELECT 1 AS found FROM tickets WHERE hubspot_ticket_id = ?")
      .bind(ticket.id)
      .first<{ found: number }>();
    if (existing !== null) return "duplicate";
    return "daily_limit";
  }

  async listRecoverable(limit: number): Promise<TicketRow[]> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 5));
    if (boundedLimit === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT hubspot_ticket_id, workflow_instance_id, created_at, updated_at,
          hubspot_created_at, subject, state, admission_utc_day,
          workflow_create_status, workflow_create_attempts
        FROM tickets
        WHERE workflow_create_status IN ('PENDING', 'CREATING')
        ORDER BY created_at ASC, hubspot_ticket_id ASC
        LIMIT ?`,
      )
      .bind(boundedLimit)
      .all<TicketRow>();
    return result.results;
  }

  async listManualReview(limit: number): Promise<TicketRow[]> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 1));
    if (boundedLimit === 0) return [];
    const result = await this.db
      .prepare(
        `SELECT hubspot_ticket_id, workflow_instance_id, created_at, updated_at,
          hubspot_created_at, subject, state, admission_utc_day,
          workflow_create_status, workflow_create_attempts
        FROM tickets WHERE workflow_create_status = 'MANUAL_REVIEW'
        ORDER BY updated_at ASC, hubspot_ticket_id ASC LIMIT ?`,
      )
      .bind(boundedLimit)
      .all<TicketRow>();
    return result.results;
  }

  async markCreating(ticketId: string, now = new Date()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE tickets SET workflow_create_status = 'CREATING',
          workflow_create_attempts = workflow_create_attempts + 1, updated_at = ?
        WHERE hubspot_ticket_id = ? AND workflow_create_status IN ('PENDING', 'CREATING')
          AND workflow_create_attempts < 3`,
      )
      .bind(now.toISOString(), ticketId)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async markStarted(ticketId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tickets SET workflow_create_status = 'STARTED',
          state = CASE WHEN state = 'DISCOVERED' THEN 'PROCESSING' ELSE state END,
          updated_at = ?
        WHERE hubspot_ticket_id = ? AND workflow_create_status <> 'STARTED'`,
      )
      .bind(now.toISOString(), ticketId)
      .run();
  }

  async markPending(ticketId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(
        `UPDATE tickets SET workflow_create_status = 'PENDING', updated_at = ?
        WHERE hubspot_ticket_id = ? AND workflow_create_status = 'CREATING'`,
      )
      .bind(now.toISOString(), ticketId)
      .run();
  }

  async markManualReview(ticketId: string, now = new Date()): Promise<void> {
    const at = now.toISOString();
    const updated = await this.db
      .prepare(
        `UPDATE tickets SET workflow_create_status = 'MANUAL_REVIEW',
          state = CASE WHEN state IN ('DISCOVERED', 'PROCESSING')
            THEN 'NEEDS_MANUAL_REVIEW' ELSE state END,
          error_code = 'WORKFLOW_CREATE_RETRIES_EXHAUSTED',
          updated_at = ?
        WHERE hubspot_ticket_id = ? AND workflow_create_status IN ('PENDING', 'CREATING')
          AND workflow_create_attempts >= 3`,
      )
      .bind(at, ticketId)
      .run();
    if ((updated.meta.changes ?? 0) !== 1) return;
    await this.db
      .prepare(
        `INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
        VALUES (?, ?, 'WORKFLOW_CREATE_RETRIES_EXHAUSTED', ?, '{"attempts":3}')
        ON CONFLICT (id) DO NOTHING`,
      )
      .bind(`workflow-create-exhausted-${ticketId}`, ticketId, at)
      .run();
  }

  async listKnownTicketIds(ticketIds: readonly string[]): Promise<Set<string>> {
    if (ticketIds.length === 0) return new Set();
    const known = new Set<string>();
    for (let offset = 0; offset < ticketIds.length; offset += 100) {
      const chunk = ticketIds.slice(offset, offset + 100);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = await this.db
        .prepare(
          `SELECT hubspot_ticket_id FROM tickets WHERE hubspot_ticket_id IN (${placeholders})`,
        )
        .bind(...chunk)
        .all<{ hubspot_ticket_id: string }>();
      for (const row of rows.results) known.add(row.hubspot_ticket_id);
    }
    return known;
  }
}

export function workflowInstanceId(ticketId: string): string {
  if (!/^\d+$/.test(ticketId)) throw new Error("invalid_hubspot_ticket_id");
  return `ticketpilot-${ticketId}`;
}
