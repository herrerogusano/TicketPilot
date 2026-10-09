import type { HubSpotTicket } from "./adapters/hubspot";
import { type ClaimResult, type TicketRow, workflowInstanceId } from "./state/ticket-repository";

export interface DiscoverySource {
  searchDemoTickets(cutoff: string): Promise<HubSpotTicket[]>;
}

export interface DiscoveryStore {
  claimEligible(ticket: HubSpotTicket, now?: Date): Promise<ClaimResult>;
  listRecoverable(limit: number): Promise<TicketRow[]>;
  listManualReview(limit: number): Promise<TicketRow[]>;
  listKnownTicketIds(ticketIds: readonly string[]): Promise<Set<string>>;
  markCreating(ticketId: string, now?: Date): Promise<boolean>;
  markStarted(ticketId: string, now?: Date): Promise<void>;
  markPending(ticketId: string, now?: Date): Promise<void>;
  markManualReview(ticketId: string, now?: Date): Promise<void>;
}

export interface WorkflowStarter {
  get(id: string): Promise<unknown>;
  create(options: { id: string; params: { ticketId: string } }): Promise<unknown>;
}

export type DiscoveryReport = {
  found: number;
  claimed: number;
  duplicates: number;
  dailyLimit: number;
  workflowsStarted: number;
  reconciled: number;
  deferred: number;
};

// Below the contract's maximum of five: leave CPU headroom on Workers Free.
const maxWorkflowStartsPerPoll = 1;

export async function runDiscovery(input: {
  cutoff: string;
  now?: Date;
  source: DiscoverySource;
  store: DiscoveryStore;
  workflows: WorkflowStarter;
}): Promise<DiscoveryReport> {
  const now = input.now ?? new Date();
  const report: DiscoveryReport = {
    found: 0,
    claimed: 0,
    duplicates: 0,
    dailyLimit: 0,
    workflowsStarted: 0,
    reconciled: 0,
    deferred: 0,
  };

  const recoverable = await input.store.listRecoverable(maxWorkflowStartsPerPoll);
  for (const row of recoverable) {
    if (report.workflowsStarted + report.reconciled >= maxWorkflowStartsPerPoll) break;
    const result = await ensureWorkflow(input.store, input.workflows, row, now);
    if (result === "started") report.workflowsStarted += 1;
    else if (result === "reconciled") report.reconciled += 1;
    else report.deferred += 1;
  }

  const remainingStartBudget = Math.max(0, maxWorkflowStartsPerPoll - recoverable.length);
  if (remainingStartBudget > 0) {
    const candidates = (await input.source.searchDemoTickets(input.cutoff)).filter((ticket) =>
      ticketIsEligible(ticket, input.cutoff),
    );
    report.found = candidates.length;
    const known = await input.store.listKnownTicketIds(candidates.map((ticket) => ticket.id));
    let claimedForPoll = 0;
    for (const ticket of candidates) {
      if (report.workflowsStarted + report.reconciled >= maxWorkflowStartsPerPoll) break;
      if (known.has(ticket.id)) continue;
      if (claimedForPoll >= remainingStartBudget) break;
      const claim = await input.store.claimEligible(ticket, now);
      if (claim === "duplicate") {
        report.duplicates += 1;
        continue;
      }
      if (claim === "daily_limit") {
        report.dailyLimit += 1;
        break;
      }
      report.claimed += 1;
      claimedForPoll += 1;
      const row: TicketRow = {
        hubspot_ticket_id: ticket.id,
        workflow_instance_id: workflowInstanceId(ticket.id),
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
        hubspot_created_at: ticket.createdAt,
        subject: ticket.subject,
        state: "DISCOVERED",
        admission_utc_day: now.toISOString().slice(0, 10),
        workflow_create_status: "PENDING",
        workflow_create_attempts: 0,
      };
      const result = await ensureWorkflow(input.store, input.workflows, row, now);
      if (result === "started") report.workflowsStarted += 1;
      else if (result === "reconciled") report.reconciled += 1;
      else report.deferred += 1;
    }
  }
  report.reconciled += await reconcileManualReview(input.store, input.workflows, now);
  return report;
}

async function reconcileManualReview(
  store: DiscoveryStore,
  workflows: WorkflowStarter,
  now: Date,
): Promise<number> {
  const rows = await store.listManualReview(1);
  let reconciled = 0;
  for (const row of rows) {
    if (!(await exists(workflows, row.workflow_instance_id))) continue;
    await store.markStarted(row.hubspot_ticket_id, now);
    reconciled += 1;
  }
  return reconciled;
}

async function ensureWorkflow(
  store: DiscoveryStore,
  workflows: WorkflowStarter,
  row: TicketRow,
  now: Date,
): Promise<"started" | "reconciled" | "deferred"> {
  const id = row.workflow_instance_id || workflowInstanceId(row.hubspot_ticket_id);
  if (await exists(workflows, id)) {
    await store.markStarted(row.hubspot_ticket_id, now);
    return "reconciled";
  }
  if (row.workflow_create_status === "MANUAL_REVIEW") return "deferred";
  if (!(await store.markCreating(row.hubspot_ticket_id, now))) {
    await store.markManualReview(row.hubspot_ticket_id, now);
    return "deferred";
  }

  try {
    await workflows.create({ id, params: { ticketId: row.hubspot_ticket_id } });
    await store.markStarted(row.hubspot_ticket_id, now);
    return "started";
  } catch {
    if (await exists(workflows, id)) {
      await store.markStarted(row.hubspot_ticket_id, now);
      return "reconciled";
    }
    await store.markPending(row.hubspot_ticket_id, now);
    return "deferred";
  }
}

async function exists(workflows: WorkflowStarter, id: string): Promise<boolean> {
  try {
    await workflows.get(id);
    return true;
  } catch {
    return false;
  }
}

export function ticketIsEligible(ticket: HubSpotTicket, cutoff: string): boolean {
  const cutoffMs = Date.parse(cutoff);
  const createdAtMs = Date.parse(ticket.createdAt);
  return (
    /^\d+$/.test(ticket.id) &&
    Number.isFinite(cutoffMs) &&
    Number.isFinite(createdAtMs) &&
    createdAtMs >= cutoffMs &&
    ticket.subject.startsWith("[TP-DEMO]")
  );
}
