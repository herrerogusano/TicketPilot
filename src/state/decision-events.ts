import type { PendingDecisionEvent, TicketRepository } from "./ticket-repository";

export const TICKET_DECISION_EVENT_TYPE = "ticket-decision";

export type DecisionWorkflowSender = {
  get(
    instanceId: string,
  ): Promise<{ sendEvent(input: { type: string; payload: unknown }): Promise<void> }>;
};

export async function dispatchDecisionEvent(
  ticketId: string,
  repository: TicketRepository,
  workflows: DecisionWorkflowSender,
): Promise<"delivered" | "not_pending" | "retry_pending"> {
  const pending = await repository.reserveDecisionEventAttempt(ticketId);
  if (pending === null) return "not_pending";
  try {
    const instance = await workflows.get(pending.workflow_instance_id);
    await instance.sendEvent({
      type: TICKET_DECISION_EVENT_TYPE,
      payload: decisionPayload(pending),
    });
    await repository.markDecisionEventDelivered(pending);
    return "delivered";
  } catch {
    if (pending.decision_event_delivery_attempts >= 3) {
      await repository.markDecisionEventDeliveryExhausted(ticketId);
    }
    return "retry_pending";
  }
}

export async function reconcilePendingDecisionEvents(
  repository: TicketRepository,
  workflows: DecisionWorkflowSender,
  limit = 5,
): Promise<{ examined: number; delivered: number; deferred: number }> {
  const pending = await repository.listPendingDecisionEvents(limit);
  let delivered = 0;
  let deferred = 0;
  for (const item of pending) {
    const result = await dispatchDecisionEvent(item.hubspot_ticket_id, repository, workflows);
    if (result === "delivered") delivered += 1;
    else if (result === "retry_pending") deferred += 1;
  }
  return { examined: pending.length, delivered, deferred };
}

function decisionPayload(event: PendingDecisionEvent): {
  ticketId: string;
  decision: "APPROVE" | "REJECT";
  actorId: string;
  decidedAt: string;
  proposalHash: string;
  proposalRevision: number;
} {
  return {
    ticketId: event.hubspot_ticket_id,
    decision: event.decision,
    actorId: event.decision_by,
    decidedAt: event.decision_at,
    proposalHash: event.proposal_hash,
    proposalRevision: event.proposal_revision,
  };
}
