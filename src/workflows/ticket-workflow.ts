import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";

export type TicketWorkflowParams = {
  ticketId: string;
};

export class TicketWorkflow extends WorkflowEntrypoint<Env, TicketWorkflowParams> {
  override async run(
    _event: WorkflowEvent<TicketWorkflowParams>,
    step: WorkflowStep,
  ): Promise<{ status: "phase1_started" }> {
    return step.do("phase-1-safe-placeholder", async () => ({ status: "phase1_started" }));
  }
}
