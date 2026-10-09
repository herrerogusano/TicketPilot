import type { HubSpotTicket } from "../adapters/hubspot";
import {
  type PolicyEvidence,
  policyEvidenceSchema,
  proposalSchema,
  type StoredProposal,
  type TicketProposal,
} from "../domain/contracts";

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

export type Phase2Ticket = {
  hubspot_ticket_id: string;
  subject: string;
  hubspot_created_at: string;
  state: string;
  proposal_hash: string | null;
  ai_call_attempts: number;
};

export class TicketRepository {
  constructor(private readonly db: D1Database) {}

  async getPhase2Ticket(ticketId: string): Promise<Phase2Ticket | null> {
    return this.db
      .prepare(`SELECT hubspot_ticket_id, subject, hubspot_created_at, state,
          proposal_hash, ai_call_attempts FROM tickets WHERE hubspot_ticket_id = ?`)
      .bind(ticketId)
      .first<Phase2Ticket>();
  }

  async getProposal(ticketId: string): Promise<StoredProposal | null> {
    const row = await this.db
      .prepare(`SELECT category, priority, evidence_status, proposal_summary,
          draft_reply, policy_keys_json, proposal_rationale, policy_evidence_json,
          proposal_hash, proposal_revision, prompt_version
        FROM tickets WHERE hubspot_ticket_id = ? AND proposal_hash IS NOT NULL`)
      .bind(ticketId)
      .first<{
        category: string | null;
        priority: string | null;
        evidence_status: string | null;
        proposal_summary: string | null;
        draft_reply: string | null;
        policy_keys_json: string | null;
        proposal_rationale: string | null;
        policy_evidence_json: string | null;
        proposal_hash: string;
        proposal_revision: number;
        prompt_version: string | null;
      }>();
    if (
      row === null ||
      row.category === null ||
      row.priority === null ||
      row.evidence_status === null ||
      row.proposal_summary === null ||
      row.draft_reply === null ||
      row.policy_keys_json === null ||
      row.proposal_rationale === null ||
      row.policy_evidence_json === null ||
      row.prompt_version === null
    ) {
      return null;
    }
    try {
      const proposal = proposalSchema.parse({
        category: row.category,
        priority: row.priority,
        evidence_status: row.evidence_status,
        summary: row.proposal_summary,
        draft_reply: row.draft_reply,
        cited_policy_keys: JSON.parse(row.policy_keys_json) as unknown,
        rationale: row.proposal_rationale,
      });
      const evidence = policyEvidenceSchema.parse(JSON.parse(row.policy_evidence_json) as unknown);
      return {
        ...proposal,
        proposalHash: row.proposal_hash,
        revision: row.proposal_revision,
        promptVersion: row.prompt_version,
        policyEvidence: evidence,
      };
    } catch {
      return null;
    }
  }

  async beginProcessing(ticketId: string, now = new Date()): Promise<void> {
    await this.db
      .prepare(`UPDATE tickets SET state = 'PROCESSING', updated_at = ?
        WHERE hubspot_ticket_id = ? AND state = 'DISCOVERED'
          AND workflow_create_status IN ('CREATING', 'STARTED')`)
      .bind(now.toISOString(), ticketId)
      .run();
  }

  async reserveNotionRequestSlot(nowMs = Date.now()): Promise<number> {
    const row = await this.db
      .prepare(`UPDATE provider_rate_limits
        SET next_slot_ms = MAX(next_slot_ms, ?) + 350
        WHERE name = 'notion'
        RETURNING next_slot_ms - 350 AS reserved_at_ms`)
      .bind(nowMs)
      .first<{ reserved_at_ms: number }>();
    if (row === null) throw new Error("notion_rate_limit_unavailable");
    return row.reserved_at_ms;
  }

  async reserveAiCall(
    ticketId: string,
    expectedAttempt: 1 | 2,
    now = new Date(),
  ): Promise<{ id: string; attempt: number } | null> {
    const utcDay = now.toISOString().slice(0, 10);
    await this.db
      .prepare(
        `INSERT INTO daily_usage (utc_day, accepted_ticket_count, ai_call_count)
        VALUES (?, 0, 0) ON CONFLICT (utc_day) DO NOTHING`,
      )
      .bind(utcDay)
      .run();
    const ticket = await this.db
      .prepare(
        "SELECT ai_call_attempts FROM tickets WHERE hubspot_ticket_id = ? AND state = 'PROCESSING' AND proposal_hash IS NULL",
      )
      .bind(ticketId)
      .first<{ ai_call_attempts: number }>();
    if (ticket === null || ticket.ai_call_attempts !== expectedAttempt - 1) return null;
    const id = crypto.randomUUID();
    const attempt = expectedAttempt;
    const inserted = await this.db
      .prepare(
        `INSERT INTO ai_call_reservations (id, ticket_id, utc_day, attempt_no, reserved_at)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id, attempt_no`,
      )
      .bind(id, ticketId, utcDay, attempt, now.toISOString())
      .first<{ id: string; attempt_no: number }>();
    if (inserted === null) return null;
    return { id: inserted.id, attempt: inserted.attempt_no };
  }

  async saveProposal(
    ticketId: string,
    proposal: TicketProposal,
    proposalHash: string,
    promptVersion: string,
    evidence: readonly PolicyEvidence[],
    now = new Date(),
  ): Promise<boolean> {
    const state =
      proposal.evidence_status === "SUPPORTED" ? "AWAITING_APPROVAL" : "NEEDS_MANUAL_REVIEW";
    const updatedAt = now.toISOString();
    const eventId = `proposal-${ticketId}-${proposalHash}`;
    const statements = [
      this.db
        .prepare(`UPDATE tickets SET
          category = ?, priority = ?, evidence_status = ?, proposal_summary = ?, draft_reply = ?,
          policy_keys_json = ?, proposal_rationale = ?, policy_evidence_json = ?, proposal_hash = ?,
          prompt_version = ?, state = ?, updated_at = ?
        WHERE hubspot_ticket_id = ? AND state = 'PROCESSING' AND proposal_hash IS NULL`)
        .bind(
          proposal.category,
          proposal.priority,
          proposal.evidence_status,
          proposal.summary,
          proposal.draft_reply,
          JSON.stringify(proposal.cited_policy_keys),
          proposal.rationale,
          JSON.stringify(evidence),
          proposalHash,
          promptVersion,
          state,
          updatedAt,
          ticketId,
        ),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
        SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(
          eventId,
          ticketId,
          proposal.evidence_status === "SUPPORTED" ? "PROPOSAL_PERSISTED" : "PROPOSAL_NEEDS_REVIEW",
          updatedAt,
          JSON.stringify({
            proposal_hash: proposalHash,
            revision: 1,
            evidence_status: proposal.evidence_status,
            cited_policy_keys: proposal.cited_policy_keys,
            policy_keys: evidence.map((item) => item.key),
            prompt_version: promptVersion,
          }),
        ),
    ];
    const results = await this.db.batch(statements);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async markProposalManualReview(
    ticketId: string,
    errorCode: string,
    now = new Date(),
  ): Promise<void> {
    const updatedAt = now.toISOString();
    const eventId = `phase2-error-${ticketId}-${errorCode}`;
    await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'NEEDS_MANUAL_REVIEW', error_code = ?, updated_at = ?
        WHERE hubspot_ticket_id = ? AND state = 'PROCESSING' AND proposal_hash IS NULL`)
        .bind(errorCode, updatedAt, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
        SELECT ?, ?, 'PROPOSAL_PROCESSING_FAILED', ?, ? WHERE changes() = 1
        ON CONFLICT (id) DO NOTHING`)
        .bind(eventId, ticketId, updatedAt, JSON.stringify({ code: errorCode })),
    ]);
  }

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
