import { HubSpotClient } from "./adapters/hubspot";
import {
  parseSlackAction,
  parseSlackEditSubmission,
  readSlackRawBody,
  SLACK_ACTION_IDS,
  SlackClient,
  verifySlackSignature,
} from "./adapters/slack";
import { runDiscovery } from "./discovery";
import { type RuntimeConfigInput, validateRuntimeConfig } from "./platform/config";
import { logEvent } from "./platform/logging";
import {
  type DecisionWorkflowSender,
  dispatchDecisionEvent,
  reconcilePendingDecisionEvents,
} from "./state/decision-events";
import { isEventMaintenanceDue, pruneExpiredEvents } from "./state/event-retention";
import { TicketRepository } from "./state/ticket-repository";
import { reconcilePendingCrmAudits } from "./workflows/email-delivery";
import { hashProposal } from "./workflows/ticket-workflow";

export { TicketWorkflow } from "./workflows/ticket-workflow";

export function createHealthResponse(config: RuntimeConfigInput): Response {
  return Response.json({
    ok: true,
    version: config.TICKETPILOT_VERSION,
    configured: validateRuntimeConfig(config),
  });
}

export type SlackRouteServices = { DB: D1Database; TICKET_WORKFLOW: DecisionWorkflowSender };
export type HubSpotDiscoverySource = Pick<HubSpotClient, "searchDemoTickets">;

export async function routeRequest(
  request: Request,
  config: RuntimeConfigInput,
  services?: SlackRouteServices,
  ctx?: Pick<ExecutionContext, "waitUntil">,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return createHealthResponse(config);
  }

  if (request.method === "POST" && url.pathname === "/slack/actions") {
    if (!validateRuntimeConfig(config) || services === undefined || ctx === undefined) {
      return Response.json({ error: "not_configured" }, { status: 503 });
    }
    let rawBody: string;
    try {
      rawBody = await readSlackRawBody(request);
    } catch {
      return Response.json({ error: "invalid_request" }, { status: 413 });
    }
    let validSignature: boolean;
    try {
      validSignature = await verifySlackSignature({
        rawBody,
        timestamp: request.headers.get("x-slack-request-timestamp"),
        signature: request.headers.get("x-slack-signature"),
        signingSecret: config.SLACK_SIGNING_SECRET,
      });
    } catch {
      return Response.json({ error: "verification_unavailable" }, { status: 503 });
    }
    if (!validSignature) return Response.json({ error: "invalid_signature" }, { status: 401 });
    if (
      !request.headers
        .get("content-type")
        ?.toLowerCase()
        .startsWith("application/x-www-form-urlencoded")
    ) {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }
    const action = parseSlackAction(rawBody);
    if (action === null) {
      const edit = parseSlackEditSubmission(rawBody);
      if (edit === null) return Response.json({ error: "invalid_action" }, { status: 400 });
      if (
        edit.teamId !== config.SLACK_TEAM_ID ||
        edit.channelId !== config.SLACK_CHANNEL_ID ||
        edit.actorId !== config.SLACK_APPROVER_USER_ID
      )
        return Response.json({ error: "unauthorized_action" }, { status: 403 });
      const repository = new TicketRepository(services.DB);
      try {
        const state = await repository.getSlackReviewState(edit.ticketId);
        const proposal = await repository.getProposal(edit.ticketId);
        if (
          state === null ||
          proposal === null ||
          state.state !== "AWAITING_APPROVAL" ||
          state.decision !== null ||
          state.evidence_status !== "SUPPORTED" ||
          state.slack_post_status !== "POSTED" ||
          !reviewIsOpen(state.slack_review_deadline) ||
          state.slack_team_id !== config.SLACK_TEAM_ID ||
          state.slack_channel !== config.SLACK_CHANNEL_ID ||
          state.slack_message_ts !== edit.messageTs ||
          state.slack_refresh_revision !== null ||
          state.proposal_hash !== edit.proposalHash ||
          state.proposal_revision !== edit.proposalRevision ||
          proposal.proposalHash !== edit.proposalHash ||
          proposal.revision !== edit.proposalRevision
        )
          return Response.json({
            response_action: "errors",
            errors: { draft_reply_block: "This review is stale or no longer editable." },
          });
        const draftReply = edit.draftReply.trim();
        const summaryText = edit.summary.trim() || proposal.summary;
        const reason = edit.reason.trim();
        if (draftReply.length === 0 || draftReply.length > 1_500) {
          return Response.json({
            response_action: "errors",
            errors: { draft_reply_block: "Enter a response of 1–1,500 characters." },
          });
        }
        if (summaryText.length > 240) {
          return Response.json({
            response_action: "errors",
            errors: { summary_block: "Summary must be 240 characters or fewer." },
          });
        }
        if (reason.length === 0 || reason.length > 200) {
          return Response.json({
            response_action: "errors",
            errors: { reason_block: "Enter an internal reason of 1–200 characters." },
          });
        }
        const revised = {
          category: proposal.category,
          priority: proposal.priority,
          evidence_status: proposal.evidence_status,
          summary: summaryText,
          draft_reply: draftReply,
          cited_policy_keys: proposal.cited_policy_keys,
          rationale: proposal.rationale,
        };
        const proposalHash = await hashProposal({
          ticketId: edit.ticketId,
          revision: edit.proposalRevision + 1,
          proposal: revised,
          evidence: proposal.policyEvidence,
          promptVersion: proposal.promptVersion,
        });
        const saved = await repository.editProposal({
          ticketId: edit.ticketId,
          expectedHash: edit.proposalHash,
          expectedRevision: edit.proposalRevision,
          proposal: revised,
          proposalHash,
          reason,
          editorId: edit.actorId,
          teamId: edit.teamId,
          channelId: edit.channelId,
          messageTs: edit.messageTs,
        });
        if (!saved) {
          return Response.json({
            response_action: "errors",
            errors: {
              draft_reply_block:
                "Another action changed this review. Reopen the current Slack message.",
            },
          });
        }
        const revision = edit.proposalRevision + 1;
        const token = crypto.randomUUID();
        if (await repository.reserveSlackRefresh(edit.ticketId, revision, token)) {
          ctx.waitUntil(
            (async () => {
              const current = await repository.getProposal(edit.ticketId);
              const freshState = await repository.getSlackReviewState(edit.ticketId);
              if (
                current === null ||
                freshState?.slack_refresh_revision !== revision ||
                current.revision !== revision ||
                current.proposalHash !== freshState.proposal_hash
              )
                return;
              const refreshed = await new SlackClient(config.SLACK_BOT_TOKEN).refreshReviewMessage(
                edit.channelId,
                edit.messageTs,
                { ticketId: edit.ticketId, proposal: current, evidence: current.policyEvidence },
              );
              if (refreshed) await repository.completeSlackRefresh(edit.ticketId, revision, token);
            })().catch(() => logEvent("slack.refresh_failed")),
          );
        }
        return Response.json({ response_action: "clear" });
      } catch {
        return Response.json({
          response_action: "errors",
          errors: {
            draft_reply_block:
              "Could not confirm this save. Reopen the current review; approval remains blocked while a card refresh is pending.",
          },
        });
      }
    }
    if (
      action.teamId !== config.SLACK_TEAM_ID ||
      action.channelId !== config.SLACK_CHANNEL_ID ||
      action.actorId !== config.SLACK_APPROVER_USER_ID
    ) {
      return Response.json({ error: "unauthorized_action" }, { status: 403 });
    }
    if (action.actionId === SLACK_ACTION_IDS.edit) {
      const repository = new TicketRepository(services.DB);
      try {
        const state = await repository.getSlackReviewState(action.ticketId);
        const proposal = await repository.getProposal(action.ticketId);
        if (
          action.triggerId === undefined ||
          action.triggerId.length === 0 ||
          state === null ||
          proposal === null ||
          state.state !== "AWAITING_APPROVAL" ||
          state.decision !== null ||
          state.evidence_status !== "SUPPORTED" ||
          state.slack_post_status !== "POSTED" ||
          state.slack_refresh_revision !== null ||
          !reviewIsOpen(state.slack_review_deadline) ||
          state.proposal_hash !== action.proposalHash ||
          state.proposal_revision !== action.proposalRevision ||
          state.slack_team_id !== action.teamId ||
          state.slack_channel !== action.channelId ||
          state.slack_message_ts !== action.messageTs ||
          proposal.proposalHash !== action.proposalHash ||
          proposal.revision !== action.proposalRevision
        )
          return new Response(null, { status: 200 });
        await new SlackClient(config.SLACK_BOT_TOKEN).openEditModal(action.triggerId, {
          ticketId: action.ticketId,
          proposal,
          teamId: action.teamId,
          channelId: action.channelId,
          messageTs: action.messageTs,
        });
        return new Response(null, { status: 200 });
      } catch {
        return new Response(null, { status: 200 });
      }
    }
    const repository = new TicketRepository(services.DB);
    let recorded: boolean;
    try {
      recorded = await repository.recordSlackDecision({
        ticketId: action.ticketId,
        proposalHash: action.proposalHash,
        proposalRevision: action.proposalRevision,
        teamId: action.teamId,
        channelId: action.channelId,
        messageTs: action.messageTs,
        decision: action.actionId === SLACK_ACTION_IDS.approve ? "APPROVE" : "REJECT",
        actorId: action.actorId,
      });
    } catch {
      return Response.json({ error: "decision_unavailable" }, { status: 503 });
    }
    if (recorded) {
      const decision = action.actionId === SLACK_ACTION_IDS.approve ? "APPROVE" : "REJECT";
      const background = Promise.all([
        dispatchDecisionEvent(action.ticketId, repository, services.TICKET_WORKFLOW),
        new SlackClient(config.SLACK_BOT_TOKEN).updateReviewMessage(
          action.channelId,
          action.messageTs,
          decision,
          action.actorId,
        ),
      ])
        .then(() => undefined)
        .catch(() => logEvent("slack.background_failed"));
      ctx.waitUntil(background);
    }
    return new Response(null, { status: 200 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env, ctx): Promise<Response> {
    return routeRequest(request, env, env, ctx);
  },
  async scheduled(controller, env): Promise<void> {
    await runScheduledTasks(env, undefined, new Date(controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

export async function runScheduledTasks(
  env: Env,
  source: HubSpotDiscoverySource = new HubSpotClient(env.HUBSPOT_SERVICE_KEY),
  now = new Date(),
): Promise<void> {
  if (!validateRuntimeConfig(env)) {
    logEvent("cron.skipped_not_configured");
    return;
  }
  if (isEventMaintenanceDue(now)) {
    try {
      const removed = await pruneExpiredEvents(env.DB, now);
      logEvent("cron.events_pruned", { removed });
    } catch {
      logEvent("cron.event_retention_failed");
    }
  }
  try {
    await reconcilePendingSlackRefresh(env);
  } catch {
    logEvent("cron.slack_refresh_failed");
  }
  try {
    const delivery = await reconcilePendingDecisionEvents(
      new TicketRepository(env.DB),
      env.TICKET_WORKFLOW,
      1,
    );
    logEvent("cron.decision_events_reconciled", delivery);
  } catch {
    logEvent("cron.decision_events_failed");
  }
  try {
    const audit = await reconcilePendingCrmAudits(env);
    logEvent("cron.crm_audits_reconciled", audit);
  } catch {
    logEvent("cron.crm_audits_failed");
  }
  try {
    const report = await runDiscovery({
      cutoff: env.DEMO_START_AT,
      source,
      store: new TicketRepository(env.DB),
      workflows: env.TICKET_WORKFLOW,
    });
    logEvent("cron.discovery_completed", {
      found: report.found,
      claimed: report.claimed,
      duplicates: report.duplicates,
      dailyLimit: report.dailyLimit,
      workflowsStarted: report.workflowsStarted,
      reconciled: report.reconciled,
      deferred: report.deferred,
    });
  } catch {
    logEvent("cron.discovery_failed");
  }
}

export async function reconcilePendingSlackRefresh(env: Env): Promise<number> {
  const repository = new TicketRepository(env.DB);
  const pending = await repository.listPendingSlackRefresh();
  let completed = 0;
  for (const state of pending) {
    if (
      state.slack_team_id === null ||
      state.slack_channel === null ||
      state.slack_message_ts === null ||
      state.slack_refresh_revision === null
    )
      continue;
    const token = crypto.randomUUID();
    if (
      !(await repository.reserveSlackRefresh(
        state.hubspot_ticket_id,
        state.slack_refresh_revision,
        token,
      ))
    )
      continue;
    const proposal = await repository.getProposal(state.hubspot_ticket_id);
    if (
      proposal === null ||
      proposal.revision !== state.slack_refresh_revision ||
      proposal.proposalHash !== state.proposal_hash
    )
      continue;
    const refreshed = await new SlackClient(env.SLACK_BOT_TOKEN).refreshReviewMessage(
      state.slack_channel,
      state.slack_message_ts,
      { ticketId: state.hubspot_ticket_id, proposal, evidence: proposal.policyEvidence },
    );
    if (
      refreshed &&
      (await repository.completeSlackRefresh(state.hubspot_ticket_id, proposal.revision, token))
    )
      completed += 1;
  }
  return completed;
}

function reviewIsOpen(deadline: string | null): boolean {
  if (deadline === null) return false;
  const deadlineMs = Date.parse(deadline);
  return Number.isFinite(deadlineMs) && deadlineMs > Date.now();
}
