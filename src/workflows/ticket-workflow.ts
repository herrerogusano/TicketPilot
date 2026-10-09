import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { type ProposalInference, WorkersAiAdapter } from "../adapters/ai";
import { HubSpotClient } from "../adapters/hubspot";
import { NotionClient } from "../adapters/notion";
import { ticketIsEligible } from "../discovery";
import {
  detectTicketLanguage,
  type PolicyDocument,
  type PolicyEvidence,
  policyKeys,
  type TicketProposal,
  unsupportedProposal,
} from "../domain/contracts";
import { selectPolicies } from "../domain/policy-selection";
import { NO_MODEL_PROMPT_VERSION, PROMPT_VERSION } from "../domain/prompt";
import { TicketRepository } from "../state/ticket-repository";

export type TicketWorkflowParams = { ticketId: string };
export type Phase2Result = {
  status: "proposal_saved" | "proposal_reused" | "manual_review" | "skipped";
  evidence_status?: "SUPPORTED" | "INSUFFICIENT_EVIDENCE";
  cited_policy_keys?: string[];
};

const nonRetryableStep = {
  retries: { limit: 0, delay: 1_000, backoff: "constant" as const },
  timeout: 30_000,
};

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
      return {
        status: "proposal_reused",
        evidence_status: existing.evidence_status,
        cited_policy_keys: existing.cited_policy_keys,
      };
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
        return {
          status: "proposal_reused",
          evidence_status: existing.evidence_status,
          cited_policy_keys: existing.cited_policy_keys,
        };
      }
      return { status: "skipped" };
    }
    return {
      status: proposal.evidence_status === "SUPPORTED" ? "proposal_saved" : "manual_review",
      evidence_status: proposal.evidence_status,
      cited_policy_keys: proposal.cited_policy_keys,
    };
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
