import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
  type WorkflowStepEvent,
} from "cloudflare:workers";
import { type ProposalInference, WorkersAiAdapter } from "../adapters/ai";
import { HubSpotClient } from "../adapters/hubspot";
import { NotionClient } from "../adapters/notion";
import { SLACK_POST_TIMEOUT_MS, SlackApiError, SlackClient } from "../adapters/slack";
import { ticketIsEligible } from "../discovery";
import {
  detectTicketLanguage,
  type PolicyDocument,
  type PolicyEvidence,
  policyKeys,
  type StoredProposal,
  type TicketProposal,
  unsupportedProposal,
} from "../domain/contracts";
import { selectPolicies } from "../domain/policy-selection";
import { NO_MODEL_PROMPT_VERSION, PROMPT_VERSION } from "../domain/prompt";
import { TICKET_DECISION_EVENT_TYPE } from "../state/decision-events";
import { type SlackReviewState, TicketRepository } from "../state/ticket-repository";
import { handleDurableDecision } from "./email-delivery";

export type TicketWorkflowParams = { ticketId: string };
export type Phase2Result = {
  status:
    | "proposal_saved"
    | "proposal_reused"
    | "awaiting_decision"
    | "decision_received"
    | "expired"
    | "manual_review"
    | "skipped"
    | "email_accepted"
    | "completed"
    | "send_failed"
    | "send_unknown"
    | "crm_audit_pending";
  evidence_status?: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  cited_policy_keys?: string[];
  decision?: "APPROVE" | "REJECT";
};

type TicketDecisionEvent = {
  ticketId: string;
  decision: "APPROVE" | "REJECT";
  actorId: string;
  decidedAt: string;
  proposalHash: string;
  proposalRevision: number;
};

const nonRetryableStep = {
  retries: { limit: 0, delay: 1_000, backoff: "constant" as const },
  timeout: 30_000,
};
const SLACK_POST_LEASE_MS = SLACK_POST_TIMEOUT_MS + 22_000;

export class TicketWorkflow extends WorkflowEntrypoint<Env, TicketWorkflowParams> {
  override async run(
    event: WorkflowEvent<TicketWorkflowParams>,
    step: WorkflowStep,
  ): Promise<Phase2Result> {
    const ticketId = event.payload.ticketId;
    if (!/^\d+$/.test(ticketId)) return { status: "skipped" };

    const repository = new TicketRepository(this.env.DB);
    await step.do<void>("phase2-begin-processing", nonRetryableStep, () =>
      repository.beginProcessing(ticketId),
    );
    const row = await step.do<Awaited<ReturnType<TicketRepository["getPhase2Ticket"]>>>(
      "phase2-load-ticket",
      nonRetryableStep,
      () => repository.getPhase2Ticket(ticketId),
    );
    if (row === null) return { status: "skipped" };

    const existing = await step.do<Awaited<ReturnType<TicketRepository["getProposal"]>>>(
      "phase2-load-proposal",
      nonRetryableStep,
      () => repository.getProposal(ticketId),
    );
    if (existing !== null) {
      return this.runSlackReview(step, repository, ticketId, existing);
    }
    if (row.state !== "PROCESSING" || row.proposal_hash !== null) return { status: "skipped" };
    if (row.ai_call_attempts > 0) {
      await step.do("phase2-mark-unknown-ai-outcome", nonRetryableStep, () =>
        repository.markProposalManualReview(ticketId, "AI_OUTCOME_UNKNOWN_RECONCILE"),
      );
      return { status: "manual_review" };
    }

    const hubspot = new HubSpotClient(this.env.HUBSPOT_SERVICE_KEY);
    const ticket = await step.do<Awaited<ReturnType<HubSpotClient["getTicket"]>>>(
      "phase2-revalidate-ticket",
      nonRetryableStep,
      () => hubspot.getTicket(ticketId),
    );
    if (ticket === null || !ticketIsEligible(ticket, this.env.DEMO_START_AT)) {
      await step.do("phase2-mark-ineligible", nonRetryableStep, () =>
        repository.markProposalManualReview(ticketId, "TICKET_REVALIDATION_FAILED"),
      );
      return { status: "manual_review" };
    }

    let policies: PolicyDocument[];
    try {
      const notion = new NotionClient(
        this.env.NOTION_TOKEN,
        undefined,
        Date.now,
        undefined,
        async () => {
          const reservedAt = await repository.reserveNotionRequestSlot();
          const waitMs = Math.max(0, reservedAt - Date.now());
          if (waitMs > 0) await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
        },
      );
      const refs = await step.do<Awaited<ReturnType<NotionClient["listChildPages"]>>>(
        "phase2-list-policy-pages",
        nonRetryableStep,
        () => notion.listChildPages(this.env.NOTION_PARENT_PAGE_ID),
      );
      const byKey = new Map(refs.map((ref) => [ref.key, ref]));
      if (refs.length !== new Set(refs.map((ref) => ref.key)).size) {
        await step.do("phase2-mark-duplicate-policy", nonRetryableStep, () =>
          repository.markProposalManualReview(ticketId, "NOTION_DUPLICATE_POLICY_KEY"),
        );
        return { status: "manual_review" };
      }
      policies = [];
      for (const key of policyKeys) {
        const ref = byKey.get(key);
        if (ref === undefined) continue;
        const policy = await step.do<PolicyDocument>(
          `phase2-read-policy-${key}`,
          nonRetryableStep,
          () => notion.retrievePolicy(ref, this.env.NOTION_PARENT_PAGE_ID),
        );
        policies.push(policy);
      }
    } catch {
      await step.do("phase2-mark-notion-failure", nonRetryableStep, () =>
        repository.markProposalManualReview(ticketId, "NOTION_UNAVAILABLE_OR_INVALID"),
      );
      return { status: "manual_review" };
    }

    const selected = await step.do<PolicyDocument[]>(
      "phase2-select-policies",
      nonRetryableStep,
      async () => selectPolicies(ticket.subject, ticket.content, policies),
    );
    if (selected.length === 0) {
      return this.persistProposal(
        step,
        repository,
        ticketId,
        unsupportedProposal(detectTicketLanguage(ticket.subject, ticket.content)),
        [],
        NO_MODEL_PROMPT_VERSION,
      );
    }

    const ai = new WorkersAiAdapter(this.env.AI);
    const prompt = await step.do("phase2-build-prompt", nonRetryableStep, async () =>
      ai.prepare({ subject: ticket.subject, body: ticket.content, policies: selected }),
    );
    if (prompt === null) {
      return this.markFailure(step, repository, ticketId, "AI_PROMPT_BUDGET_OR_EVIDENCE_EXCEEDED");
    }
    type InferenceWithReservation = ProposalInference | { kind: "reservation_denied" };
    let outcome = await step.do<InferenceWithReservation>(
      "phase2-ai-call-1",
      nonRetryableStep,
      async () => {
        const reservation = await repository.reserveAiCall(ticketId, 1);
        if (reservation === null) return { kind: "reservation_denied" };
        return ai.propose(prompt, selected);
      },
    );
    if (outcome.kind === "reservation_denied") {
      return this.markFailure(
        step,
        repository,
        ticketId,
        "AI_CALL_BUDGET_OR_RECONCILIATION_REQUIRED",
      );
    }
    if (outcome.kind === "provider_error") {
      return this.markFailure(step, repository, ticketId, "AI_PROVIDER_ERROR");
    }
    if (outcome.kind === "prompt_budget_exceeded") {
      return this.markFailure(step, repository, ticketId, "AI_PROMPT_BUDGET_EXCEEDED");
    }
    if (outcome.kind === "unsupported_citation") {
      return this.markFailure(step, repository, ticketId, "AI_UNSUPPORTED_CITATION");
    }
    if (outcome.kind === "invalid_format") {
      outcome = await step.do<InferenceWithReservation>(
        "phase2-ai-call-2-format-repair",
        nonRetryableStep,
        async () => {
          const reservation = await repository.reserveAiCall(ticketId, 2);
          if (reservation === null) return { kind: "reservation_denied" };
          return ai.propose(prompt, selected);
        },
      );
      if (outcome.kind === "reservation_denied") {
        return this.markFailure(
          step,
          repository,
          ticketId,
          "AI_REPAIR_BUDGET_OR_RECONCILIATION_REQUIRED",
        );
      }
      if (outcome.kind === "provider_error") {
        return this.markFailure(step, repository, ticketId, "AI_PROVIDER_ERROR");
      }
      if (outcome.kind === "prompt_budget_exceeded") {
        return this.markFailure(step, repository, ticketId, "AI_PROMPT_BUDGET_EXCEEDED");
      }
      if (outcome.kind === "unsupported_citation") {
        return this.markFailure(step, repository, ticketId, "AI_UNSUPPORTED_CITATION");
      }
      if (outcome.kind === "invalid_format") {
        return this.markFailure(step, repository, ticketId, "AI_INVALID_FORMAT");
      }
    }

    if (outcome.kind !== "valid")
      return this.markFailure(step, repository, ticketId, "AI_INVALID_RESULT");
    const proposal = outcome.proposal;
    const evidence = evidenceFor(proposal, selected);
    if (proposal.evidence_status === "INSUFFICIENT_EVIDENCE") {
      return this.persistProposal(step, repository, ticketId, proposal, evidence, PROMPT_VERSION);
    }
    return this.persistProposal(step, repository, ticketId, proposal, evidence, PROMPT_VERSION);
  }

  private async persistProposal(
    step: WorkflowStep,
    repository: TicketRepository,
    ticketId: string,
    proposal: TicketProposal,
    evidence: readonly PolicyEvidence[],
    promptVersion: string,
  ): Promise<Phase2Result> {
    const proposalHash = await hashProposal({
      ticketId,
      revision: 1,
      proposal,
      evidence,
      promptVersion,
    });
    const saved = await step.do<boolean>("phase2-persist-proposal", nonRetryableStep, () =>
      repository.saveProposal(ticketId, proposal, proposalHash, promptVersion, evidence),
    );
    if (!saved) {
      const existing = await step.do<Awaited<ReturnType<TicketRepository["getProposal"]>>>(
        "phase2-reconcile-proposal",
        nonRetryableStep,
        () => repository.getProposal(ticketId),
      );
      if (existing !== null) {
        return this.runSlackReview(step, repository, ticketId, existing);
      }
      return { status: "skipped" };
    }
    const stored: StoredProposal = {
      ...proposal,
      proposalHash,
      revision: 1,
      promptVersion,
      policyEvidence: [...evidence],
    };
    return this.runSlackReview(step, repository, ticketId, stored);
  }

  private async runSlackReview(
    step: WorkflowStep,
    repository: TicketRepository,
    ticketId: string,
    proposal: StoredProposal,
  ): Promise<Phase2Result> {
    let state = await step.do<Awaited<ReturnType<TicketRepository["getSlackReviewState"]>>>(
      "phase3-load-slack-review",
      nonRetryableStep,
      () => repository.getSlackReviewState(ticketId),
    );
    if (state === null || state.proposal_hash !== proposal.proposalHash) {
      return { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    if (state.decision !== null) {
      return durableDecisionAllowed(state, this.env.SLACK_APPROVER_USER_ID)
        ? handleDurableDecision(step, this.env, ticketId, proposal, state)
        : { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    if (state.state === "EXPIRED" || state.state === "REJECTED") {
      return { status: state.state === "EXPIRED" ? "expired" : "decision_received" };
    }

    if (state.slack_post_status === "IN_PROGRESS") {
      await step.do("phase3-reconcile-unknown-slack-post", nonRetryableStep, () =>
        markSlackPostUnknownIfStale(repository, ticketId, state?.slack_post_started_at),
      );
      return { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    if (state.slack_post_status === "NOT_STARTED") {
      const postResult = await step.do<"posted" | "manual_review" | "already_posted">(
        "phase3-post-review-message-once",
        nonRetryableStep,
        async () => {
          if (!(await repository.reserveSlackPost(ticketId))) {
            const current = await repository.getSlackReviewState(ticketId);
            if (current?.slack_post_status === "POSTED") return "already_posted";
            if (current?.slack_post_status === "IN_PROGRESS") {
              await markSlackPostUnknownIfStale(
                repository,
                ticketId,
                current.slack_post_started_at,
              );
            }
            return "manual_review";
          }
          try {
            const receipt = await new SlackClient(this.env.SLACK_BOT_TOKEN).postReviewMessage(
              this.env.SLACK_CHANNEL_ID,
              { ticketId, proposal, evidence: proposal.policyEvidence },
            );
            const persisted = await repository.completeSlackPost(
              ticketId,
              this.env.SLACK_TEAM_ID,
              receipt.channelId,
              receipt.messageTs,
            );
            return persisted ? "posted" : "manual_review";
          } catch (error) {
            const unknown = !(error instanceof SlackApiError) || error.outcome === "unknown";
            await repository.failSlackPost(
              ticketId,
              unknown ? "UNKNOWN" : "FAILED",
              unknown ? "SLACK_POST_OUTCOME_UNKNOWN" : "SLACK_POST_REJECTED",
            );
            return "manual_review";
          }
        },
      );
      if (postResult === "manual_review") {
        return { status: "manual_review", evidence_status: proposal.evidence_status };
      }
      state = await step.do("phase3-confirm-slack-review-state", nonRetryableStep, () =>
        repository.getSlackReviewState(ticketId),
      );
    }
    if (
      state === null ||
      state.slack_post_status !== "POSTED" ||
      state.slack_team_id !== this.env.SLACK_TEAM_ID ||
      state.slack_channel !== this.env.SLACK_CHANNEL_ID ||
      state.slack_message_ts === null ||
      state.slack_review_deadline === null
    ) {
      return { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    if (state.decision !== null) {
      return durableDecisionAllowed(state, this.env.SLACK_APPROVER_USER_ID)
        ? handleDurableDecision(step, this.env, ticketId, proposal, state)
        : { status: "manual_review", evidence_status: proposal.evidence_status };
    }

    const remainingMs = Date.parse(state.slack_review_deadline) - Date.now();
    if (remainingMs <= 0) {
      await step.do("phase3-expire-slack-review", nonRetryableStep, () =>
        repository.expireSlackReview(ticketId),
      );
      const afterExpiry = await step.do("phase3-read-after-expiry", nonRetryableStep, () =>
        repository.getSlackReviewState(ticketId),
      );
      return afterExpiry?.decision !== null && afterExpiry?.decision !== undefined
        ? durableDecisionAllowed(afterExpiry, this.env.SLACK_APPROVER_USER_ID)
          ? handleDurableDecision(step, this.env, ticketId, proposal, afterExpiry)
          : { status: "manual_review", evidence_status: proposal.evidence_status }
        : { status: afterExpiry?.state === "EXPIRED" ? "expired" : "manual_review" };
    }

    let event: WorkflowStepEvent<TicketDecisionEvent> | null = null;
    try {
      event = await step.waitForEvent<TicketDecisionEvent>("phase3-wait-for-human-decision", {
        type: TICKET_DECISION_EVENT_TYPE,
        timeout: `${Math.max(1, Math.ceil(remainingMs / 1_000))} seconds`,
      });
    } catch {
      const current = await step.do("phase3-reconcile-timeout-winner", nonRetryableStep, () =>
        repository.getSlackReviewState(ticketId),
      );
      if (current?.decision !== null && current?.decision !== undefined) {
        return durableDecisionAllowed(current, this.env.SLACK_APPROVER_USER_ID)
          ? handleDurableDecision(step, this.env, ticketId, proposal, current)
          : { status: "manual_review", evidence_status: proposal.evidence_status };
      }
      await step.do("phase3-expire-after-timeout", nonRetryableStep, () =>
        repository.expireSlackReview(ticketId),
      );
      const afterExpiry = await step.do("phase3-read-after-timeout", nonRetryableStep, () =>
        repository.getSlackReviewState(ticketId),
      );
      if (afterExpiry?.decision !== null && afterExpiry?.decision !== undefined) {
        return durableDecisionAllowed(afterExpiry, this.env.SLACK_APPROVER_USER_ID)
          ? handleDurableDecision(step, this.env, ticketId, proposal, afterExpiry)
          : { status: "manual_review", evidence_status: proposal.evidence_status };
      }
      if (afterExpiry?.state === "EXPIRED") return { status: "expired" };
      throw new Error("decision_wait_interrupted");
    }

    const received: unknown = event.payload;
    if (!isTicketDecisionEvent(received)) {
      return { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    const current = await step.do("phase3-verify-persisted-decision", nonRetryableStep, () =>
      repository.getSlackReviewState(ticketId),
    );
    if (
      current === null ||
      received.ticketId !== ticketId ||
      current.decision !== received.decision ||
      current.decision_by !== received.actorId ||
      received.actorId !== this.env.SLACK_APPROVER_USER_ID ||
      current.decision_at !== received.decidedAt ||
      current.proposal_hash !== received.proposalHash ||
      current.proposal_revision !== received.proposalRevision
    ) {
      return { status: "manual_review", evidence_status: proposal.evidence_status };
    }
    return handleDurableDecision(step, this.env, ticketId, proposal, current);
  }

  private async markFailure(
    step: WorkflowStep,
    repository: TicketRepository,
    ticketId: string,
    code: string,
  ): Promise<Phase2Result> {
    await step.do(`phase2-mark-${code.toLowerCase()}`, nonRetryableStep, () =>
      repository.markProposalManualReview(ticketId, code),
    );
    return { status: "manual_review" };
  }
}

async function markSlackPostUnknownIfStale(
  repository: TicketRepository,
  ticketId: string,
  startedAt: string | null | undefined,
  now = Date.now(),
): Promise<boolean> {
  if (startedAt === null || startedAt === undefined) return false;
  const startedAtMs = Date.parse(startedAt);
  if (!Number.isFinite(startedAtMs) || now - startedAtMs < SLACK_POST_LEASE_MS) return false;
  return repository.failStaleSlackPost(
    ticketId,
    new Date(startedAtMs + SLACK_POST_LEASE_MS),
    new Date(now),
  );
}

function isTicketDecisionEvent(value: unknown): value is TicketDecisionEvent {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const event = value as Record<string, unknown>;
  return (
    typeof event.ticketId === "string" &&
    /^\d+$/.test(event.ticketId) &&
    (event.decision === "APPROVE" || event.decision === "REJECT") &&
    typeof event.actorId === "string" &&
    typeof event.decidedAt === "string" &&
    Number.isFinite(Date.parse(event.decidedAt)) &&
    typeof event.proposalHash === "string" &&
    /^[a-f0-9]{64}$/.test(event.proposalHash) &&
    Number.isSafeInteger(event.proposalRevision) &&
    Number(event.proposalRevision) > 0
  );
}

function durableDecisionAllowed(
  state: Pick<SlackReviewState, "decision" | "decision_by" | "decision_at">,
  approverId: string,
): boolean {
  return (
    state.decision !== null &&
    state.decision_by === approverId &&
    state.decision_at !== null &&
    Number.isFinite(Date.parse(state.decision_at))
  );
}

function evidenceFor(
  proposal: TicketProposal,
  selected: readonly PolicyDocument[],
): PolicyEvidence[] {
  const cited = new Set(proposal.cited_policy_keys);
  return selected
    .filter((policy) => cited.has(policy.key))
    .map(({ key, title, url, contentHash }) => ({ key, title, url, contentHash }));
}

export async function hashProposal(input: {
  ticketId: string;
  revision: number;
  proposal: TicketProposal;
  evidence: readonly PolicyEvidence[];
  promptVersion: string;
}): Promise<string> {
  const canonical = JSON.stringify({
    ticket_id: input.ticketId,
    revision: input.revision,
    prompt_version: input.promptVersion,
    proposal: input.proposal,
    evidence: [...input.evidence].sort((left, right) => left.key.localeCompare(right.key)),
  });
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}
