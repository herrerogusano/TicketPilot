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

export type SlackDecision = "APPROVE" | "REJECT";
export type ProposalRevisionAudit = {
  ticket_id: string;
  revision: number;
  proposal_hash: string;
  proposal_json: string;
  edit_reason: string | null;
  edited_by: string | null;
  created_at: string;
};

export type PendingDecisionEvent = {
  hubspot_ticket_id: string;
  workflow_instance_id: string;
  decision: SlackDecision;
  decision_by: string;
  decision_at: string;
  proposal_hash: string;
  proposal_revision: number;
  decision_event_delivery_attempts: number;
};

export type SlackReviewState = {
  hubspot_ticket_id: string;
  workflow_instance_id: string;
  state: string;
  evidence_status: string | null;
  proposal_hash: string | null;
  proposal_revision: number;
  slack_team_id: string | null;
  slack_channel: string | null;
  slack_message_ts: string | null;
  slack_review_started_at: string | null;
  slack_review_deadline: string | null;
  slack_post_status: "NOT_STARTED" | "IN_PROGRESS" | "POSTED" | "FAILED" | "UNKNOWN";
  slack_post_started_at: string | null;
  decision: SlackDecision | null;
  decision_by: string | null;
  decision_at: string | null;
  decision_event_pending: number;
  decision_event_delivery_attempts: number;
  slack_refresh_revision: number | null;
  slack_refresh_token: string | null;
  slack_refresh_locked_until: string | null;
};

export class TicketRepository {
  constructor(private readonly db: D1Database) {}

  async getSlackReviewState(ticketId: string): Promise<SlackReviewState | null> {
    return this.db
      .prepare(`SELECT hubspot_ticket_id, workflow_instance_id, state, evidence_status,
          proposal_hash, proposal_revision, slack_team_id, slack_channel, slack_message_ts,
          slack_review_started_at, slack_review_deadline, slack_post_status,
          slack_post_started_at, decision,
          decision_by, decision_at, decision_event_pending,
          decision_event_delivery_attempts, slack_refresh_revision,
          slack_refresh_token, slack_refresh_locked_until
        FROM tickets WHERE hubspot_ticket_id = ?`)
      .bind(ticketId)
      .first<SlackReviewState>();
  }

  async reserveSlackPost(ticketId: string, now = new Date()): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tickets SET slack_post_status = 'IN_PROGRESS', slack_post_started_at = ?,
          slack_post_attempts = 1, updated_at = ?
        WHERE hubspot_ticket_id = ? AND proposal_hash IS NOT NULL AND decision IS NULL
          AND slack_post_status = 'NOT_STARTED'
          AND state IN ('AWAITING_APPROVAL', 'NEEDS_MANUAL_REVIEW')`)
      .bind(now.toISOString(), now.toISOString(), ticketId)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async completeSlackPost(
    ticketId: string,
    teamId: string,
    channelId: string,
    messageTs: string,
    now = new Date(),
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET slack_post_status = 'POSTED', slack_team_id = ?,
            slack_channel = ?, slack_message_ts = ?, slack_review_started_at = ?,
            slack_review_deadline = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND slack_post_status = 'IN_PROGRESS'
            AND proposal_hash IS NOT NULL`)
        .bind(
          teamId,
          channelId,
          messageTs,
          at,
          new Date(now.getTime() + 48 * 60 * 60 * 1_000).toISOString(),
          at,
          ticketId,
        ),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'SLACK_REVIEW_POSTED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `slack-review-posted-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ channel_id: channelId, message_ts: messageTs }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async failSlackPost(
    ticketId: string,
    outcome: "FAILED" | "UNKNOWN",
    errorCode: "SLACK_POST_REJECTED" | "SLACK_POST_OUTCOME_UNKNOWN",
    now = new Date(),
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET slack_post_status = ?, state = CASE
            WHEN state IN ('AWAITING_APPROVAL', 'NEEDS_MANUAL_REVIEW')
              THEN 'NEEDS_MANUAL_REVIEW' ELSE state END,
            error_code = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND slack_post_status = 'IN_PROGRESS'`)
        .bind(outcome, errorCode, at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'SLACK_REVIEW_POST_FAILED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `slack-review-post-failed-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ outcome, code: errorCode }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async failStaleSlackPost(
    ticketId: string,
    staleBefore: Date,
    now = new Date(),
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET slack_post_status = 'UNKNOWN', state = CASE
            WHEN state IN ('AWAITING_APPROVAL', 'NEEDS_MANUAL_REVIEW')
              THEN 'NEEDS_MANUAL_REVIEW' ELSE state END,
            error_code = 'SLACK_POST_OUTCOME_UNKNOWN', updated_at = ?
          WHERE hubspot_ticket_id = ? AND slack_post_status = 'IN_PROGRESS'
            AND slack_post_started_at IS NOT NULL AND slack_post_started_at <= ?`)
        .bind(at, ticketId, staleBefore.toISOString()),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'SLACK_REVIEW_POST_FAILED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `slack-review-post-failed-${ticketId}`,
          ticketId,
          at,
          JSON.stringify({ outcome: "UNKNOWN", code: "SLACK_POST_OUTCOME_UNKNOWN" }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async recordSlackDecision(input: {
    ticketId: string;
    proposalHash: string;
    proposalRevision: number;
    teamId: string;
    channelId: string;
    messageTs: string;
    decision: SlackDecision;
    actorId: string;
    now?: Date;
  }): Promise<boolean> {
    const at = (input.now ?? new Date()).toISOString();
    const statements = [
      this.db
        .prepare(`UPDATE tickets SET decision = ?, decision_by = ?, decision_at = ?,
            state = CASE WHEN ? = 'APPROVE' THEN 'APPROVED' ELSE 'REJECTED' END,
            decision_event_pending = 1, decision_event_delivery_attempts = 0,
            decision_event_delivered_at = NULL, error_code = NULL, updated_at = ?
          WHERE hubspot_ticket_id = ? AND proposal_hash = ? AND proposal_revision = ?
            AND slack_team_id = ? AND slack_channel = ? AND slack_message_ts = ?
            AND slack_post_status = 'POSTED' AND decision IS NULL
            AND slack_refresh_revision IS NULL
            AND slack_review_deadline IS NOT NULL AND slack_review_deadline > ?
            AND ((? = 'APPROVE' AND state = 'AWAITING_APPROVAL'
                  AND evidence_status = 'SUPPORTED' AND length(trim(draft_reply)) > 0
                  AND json_valid(policy_keys_json) AND json_array_length(policy_keys_json) > 0
                  AND json_valid(policy_evidence_json)
                  AND json_array_length(policy_evidence_json) > 0)
              OR (? = 'REJECT' AND state IN ('AWAITING_APPROVAL', 'NEEDS_MANUAL_REVIEW')))`)
        .bind(
          input.decision,
          input.actorId,
          at,
          input.decision,
          at,
          input.ticketId,
          input.proposalHash,
          input.proposalRevision,
          input.teamId,
          input.channelId,
          input.messageTs,
          at,
          input.decision,
          input.decision,
        ),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, ?, ?, ? WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(
          `slack-decision-${input.ticketId}-${input.proposalRevision}`,
          input.ticketId,
          input.decision === "APPROVE" ? "SLACK_APPROVED" : "SLACK_REJECTED",
          at,
          JSON.stringify({
            decision: input.decision,
            actor_id: input.actorId,
            proposal_hash: input.proposalHash,
            proposal_revision: input.proposalRevision,
          }),
        ),
    ];
    const results = await this.db.batch(statements);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async editProposal(input: {
    ticketId: string;
    expectedHash: string;
    expectedRevision: number;
    proposal: TicketProposal;
    proposalHash: string;
    reason: string;
    editorId: string;
    teamId: string;
    channelId: string;
    messageTs: string;
    now?: Date;
  }): Promise<boolean> {
    if (
      input.proposal.evidence_status !== "SUPPORTED" ||
      input.proposal.draft_reply.trim().length === 0 ||
      input.reason.trim().length === 0 ||
      input.reason.length > 200 ||
      !/^[a-f0-9]{64}$/.test(input.proposalHash) ||
      input.expectedRevision >= 4
    ) {
      return false;
    }
    const at = (input.now ?? new Date()).toISOString();
    const nextRevision = input.expectedRevision + 1;
    const current = await this.getProposal(input.ticketId);
    if (
      current === null ||
      current.proposalHash !== input.expectedHash ||
      current.revision !== input.expectedRevision ||
      current.evidence_status !== "SUPPORTED" ||
      input.proposal.category !== current.category ||
      input.proposal.priority !== current.priority ||
      input.proposal.evidence_status !== current.evidence_status ||
      JSON.stringify(input.proposal.cited_policy_keys) !==
        JSON.stringify(current.cited_policy_keys) ||
      input.proposal.rationale !== current.rationale
    ) {
      return false;
    }
    const snapshot: StoredProposal = {
      ...input.proposal,
      proposalHash: input.proposalHash,
      revision: nextRevision,
      promptVersion: current.promptVersion,
      policyEvidence: current.policyEvidence,
    };
    const history = await this.getProposalRevisionHistory(input.ticketId);
    const projectedHistory: ProposalRevisionAudit[] = [
      ...history,
      {
        ticket_id: input.ticketId,
        revision: nextRevision,
        proposal_hash: input.proposalHash,
        proposal_json: JSON.stringify(snapshot),
        edit_reason: input.reason.trim(),
        edited_by: input.editorId,
        created_at: at,
      },
    ];
    if (!revisionAuditFitsHubSpot(projectedHistory, input.proposal.draft_reply)) return false;
    try {
      const results = await this.db.batch([
        this.db
          .prepare(`INSERT INTO proposal_revisions (
          ticket_id, revision, proposal_hash, proposal_json, edit_reason, edited_by, created_at
        ) SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM tickets WHERE hubspot_ticket_id = ?
          AND proposal_hash = ? AND proposal_revision = ? AND state = 'AWAITING_APPROVAL'
          AND decision IS NULL AND approved_payload_hash IS NULL
          AND slack_team_id = ? AND slack_channel = ? AND slack_message_ts = ?
          AND slack_post_status = 'POSTED' AND slack_refresh_revision IS NULL
          AND evidence_status = 'SUPPORTED' AND slack_review_deadline > ?)`)
          .bind(
            input.ticketId,
            nextRevision,
            input.proposalHash,
            JSON.stringify(snapshot),
            input.reason.trim(),
            input.editorId,
            at,
            input.ticketId,
            input.expectedHash,
            input.expectedRevision,
            input.teamId,
            input.channelId,
            input.messageTs,
            at,
          ),
        this.db
          .prepare(`UPDATE tickets SET proposal_hash = ?, proposal_revision = ?,
          proposal_summary = ?, draft_reply = ?, slack_refresh_revision = ?, updated_at = ?
        WHERE hubspot_ticket_id = ? AND proposal_hash = ? AND proposal_revision = ?
          AND state = 'AWAITING_APPROVAL' AND decision IS NULL
          AND approved_payload_hash IS NULL AND slack_team_id = ? AND slack_channel = ?
          AND slack_message_ts = ? AND slack_post_status = 'POSTED'
          AND slack_refresh_revision IS NULL AND evidence_status = 'SUPPORTED'
          AND slack_review_deadline > ?
          AND EXISTS (SELECT 1 FROM proposal_revisions r WHERE r.ticket_id = ?
            AND r.revision = ? AND r.proposal_hash = ? AND r.edited_by = ?)`)
          .bind(
            input.proposalHash,
            nextRevision,
            input.proposal.summary,
            input.proposal.draft_reply,
            nextRevision,
            at,
            input.ticketId,
            input.expectedHash,
            input.expectedRevision,
            input.teamId,
            input.channelId,
            input.messageTs,
            at,
            input.ticketId,
            nextRevision,
            input.proposalHash,
            input.editorId,
          ),
        this.db
          .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
        SELECT ?, ?, 'PROPOSAL_HUMAN_EDITED', ?, ? WHERE changes() = 1
        ON CONFLICT (id) DO NOTHING`)
          .bind(
            `proposal-human-edited-${input.ticketId}-${nextRevision}`,
            input.ticketId,
            at,
            JSON.stringify({
              revision: nextRevision,
              proposal_hash: input.proposalHash,
              editor_id: input.editorId,
            }),
          ),
      ]);
      return (results[1]?.meta.changes ?? 0) === 1;
    } catch {
      return false;
    }
  }

  async reserveSlackRefresh(
    ticketId: string,
    revision: number,
    token: string,
    now = new Date(),
  ): Promise<boolean> {
    const lockUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
    const result = await this.db
      .prepare(`UPDATE tickets SET slack_refresh_token = ?,
        slack_refresh_locked_until = ?, updated_at = ?
      WHERE hubspot_ticket_id = ? AND slack_refresh_revision = ? AND proposal_revision = ?
        AND proposal_hash IS NOT NULL AND decision IS NULL AND state = 'AWAITING_APPROVAL'
        AND (slack_refresh_token IS NULL OR slack_refresh_locked_until <= ?)`)
      .bind(token, lockUntil, now.toISOString(), ticketId, revision, revision, now.toISOString())
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async completeSlackRefresh(ticketId: string, revision: number, token: string): Promise<boolean> {
    const result = await this.db
      .prepare(`UPDATE tickets SET slack_refresh_revision = NULL,
        slack_refresh_token = NULL, slack_refresh_locked_until = NULL, updated_at = ?
      WHERE hubspot_ticket_id = ? AND slack_refresh_revision = ? AND proposal_revision = ?
        AND slack_refresh_token = ? AND decision IS NULL AND state = 'AWAITING_APPROVAL'`)
      .bind(new Date().toISOString(), ticketId, revision, revision, token)
      .run();
    return (result.meta.changes ?? 0) === 1;
  }

  async listPendingSlackRefresh(): Promise<SlackReviewState[]> {
    const result = await this.db
      .prepare(`SELECT hubspot_ticket_id, workflow_instance_id, state,
        evidence_status, proposal_hash, proposal_revision, slack_team_id, slack_channel,
        slack_message_ts, slack_review_started_at, slack_review_deadline, slack_post_status,
        slack_post_started_at, decision, decision_by, decision_at, decision_event_pending,
        decision_event_delivery_attempts, slack_refresh_revision, slack_refresh_token,
        slack_refresh_locked_until FROM tickets
      WHERE slack_refresh_revision IS NOT NULL AND decision IS NULL
        AND state = 'AWAITING_APPROVAL' AND slack_review_deadline > ?
        AND (slack_refresh_token IS NULL OR slack_refresh_locked_until <= ?)
        ORDER BY updated_at ASC, hubspot_ticket_id ASC LIMIT 1`)
      .bind(new Date().toISOString(), new Date().toISOString())
      .all<SlackReviewState>();
    return result.results;
  }

  async listPendingDecisionEvents(limit = 5): Promise<PendingDecisionEvent[]> {
    const boundedLimit = Math.max(0, Math.min(Math.trunc(limit), 5));
    if (boundedLimit === 0) return [];
    const result = await this.db
      .prepare(`SELECT hubspot_ticket_id, workflow_instance_id, decision, decision_by,
          decision_at, proposal_hash, proposal_revision, decision_event_delivery_attempts
        FROM tickets WHERE decision_event_pending = 1
          AND decision_event_delivery_attempts < 3
          AND decision IS NOT NULL AND proposal_hash IS NOT NULL
        ORDER BY decision_at ASC, hubspot_ticket_id ASC LIMIT ?`)
      .bind(boundedLimit)
      .all<PendingDecisionEvent>();
    return result.results;
  }

  async reserveDecisionEventAttempt(ticketId: string): Promise<PendingDecisionEvent | null> {
    return this.db
      .prepare(`UPDATE tickets SET decision_event_delivery_attempts = decision_event_delivery_attempts + 1
        WHERE hubspot_ticket_id = ? AND decision_event_pending = 1
          AND decision_event_delivery_attempts < 3
        RETURNING hubspot_ticket_id, workflow_instance_id, decision, decision_by,
          decision_at, proposal_hash, proposal_revision, decision_event_delivery_attempts`)
      .bind(ticketId)
      .first<PendingDecisionEvent>();
  }

  async markDecisionEventDelivered(
    event: PendingDecisionEvent,
    now = new Date(),
  ): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET decision_event_pending = 0,
            decision_event_delivered_at = ?, updated_at = ?
          WHERE hubspot_ticket_id = ? AND decision_event_pending = 1
            AND decision = ? AND proposal_hash = ? AND proposal_revision = ?`)
        .bind(
          at,
          at,
          event.hubspot_ticket_id,
          event.decision,
          event.proposal_hash,
          event.proposal_revision,
        ),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'DECISION_EVENT_DELIVERED', ?, ? WHERE changes() = 1
          ON CONFLICT (id) DO NOTHING`)
        .bind(
          `decision-event-delivered-${event.hubspot_ticket_id}-${event.proposal_revision}`,
          event.hubspot_ticket_id,
          at,
          JSON.stringify({ decision: event.decision, proposal_revision: event.proposal_revision }),
        ),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

  async markDecisionEventDeliveryExhausted(ticketId: string, now = new Date()): Promise<void> {
    const at = now.toISOString();
    await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET error_code = 'DECISION_EVENT_DELIVERY_EXHAUSTED', updated_at = ?
          WHERE hubspot_ticket_id = ? AND decision_event_pending = 1
            AND decision_event_delivery_attempts >= 3`)
        .bind(at, ticketId),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'DECISION_EVENT_DELIVERY_EXHAUSTED', ?, '{}'
          WHERE EXISTS (SELECT 1 FROM tickets WHERE hubspot_ticket_id = ?
            AND decision_event_pending = 1 AND decision_event_delivery_attempts >= 3)
          ON CONFLICT (id) DO NOTHING`)
        .bind(`decision-event-exhausted-${ticketId}`, ticketId, at, ticketId),
    ]);
  }

  async expireSlackReview(ticketId: string, now = new Date()): Promise<boolean> {
    const at = now.toISOString();
    const results = await this.db.batch([
      this.db
        .prepare(`UPDATE tickets SET state = 'EXPIRED', updated_at = ?
          WHERE hubspot_ticket_id = ? AND state IN ('AWAITING_APPROVAL', 'NEEDS_MANUAL_REVIEW')
            AND decision IS NULL AND slack_post_status = 'POSTED'
            AND slack_review_deadline IS NOT NULL AND slack_review_deadline <= ?`)
        .bind(at, ticketId, at),
      this.db
        .prepare(`INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json)
          SELECT ?, ?, 'SLACK_REVIEW_EXPIRED', ?, '{}'
          WHERE changes() = 1 ON CONFLICT (id) DO NOTHING`)
        .bind(`slack-review-expired-${ticketId}`, ticketId, at),
    ]);
    return (results[0]?.meta.changes ?? 0) === 1;
  }

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

  async getProposalRevisionHistory(ticketId: string): Promise<ProposalRevisionAudit[]> {
    const result = await this.db
      .prepare(`SELECT ticket_id, revision, proposal_hash, proposal_json, edit_reason,
          edited_by, created_at FROM proposal_revisions
        WHERE ticket_id = ? ORDER BY revision ASC LIMIT 5`)
      .bind(ticketId)
      .all<ProposalRevisionAudit>();
    return result.results;
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
    return (results[0]?.meta.changes ?? 0) >= 1;
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

function revisionAuditFitsHubSpot(
  history: readonly ProposalRevisionAudit[],
  finalDraft: string,
): boolean {
  if (history.length < 1 || history.length > 4) return false;
  let characters = 5_000 + escapeHtmlLength(finalDraft) + 1_440;
  for (const row of history) {
    let proposal: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(row.proposal_json);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
      proposal = parsed as Record<string, unknown>;
    } catch {
      return false;
    }
    const parts = [
      `Revision ${row.revision} SHA-256: ${row.proposal_hash}`,
      `Created at: ${row.created_at}`,
      `Editor: ${row.edited_by ?? "Workers AI"}`,
      ...(row.edit_reason === null
        ? []
        : [`Internal reason / solution change: ${row.edit_reason}`]),
      `Internal summary: ${String(proposal.summary ?? "")}`,
      `Response text: ${String(proposal.draft_reply ?? "")}`,
    ];
    characters +=
      parts.reduce((total, part) => total + escapeHtmlLength(part), 0) + parts.length * 2;
  }
  return characters <= 60_000;
}

function escapeHtmlLength(value: string): number {
  let length = 0;
  for (const character of value) {
    if (character === "&") length += 5;
    else if (character === "<" || character === ">") length += 4;
    else if (character === '"') length += 6;
    else if (character === "'") length += 5;
    else length += 1;
  }
  return length;
}

export function workflowInstanceId(ticketId: string): string {
  if (!/^\d+$/.test(ticketId)) throw new Error("invalid_hubspot_ticket_id");
  return `ticketpilot-${ticketId}`;
}
