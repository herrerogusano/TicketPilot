import { HubSpotClient } from "./adapters/hubspot";
import {
  parseSlackAction,
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
import { TicketRepository } from "./state/ticket-repository";
import { reconcilePendingCrmAudits } from "./workflows/email-delivery";

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
    if (action === null) return Response.json({ error: "invalid_action" }, { status: 400 });
    if (
      action.teamId !== config.SLACK_TEAM_ID ||
      action.channelId !== config.SLACK_CHANNEL_ID ||
      action.actorId !== config.SLACK_APPROVER_USER_ID
    ) {
      return Response.json({ error: "unauthorized_action" }, { status: 403 });
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
  async scheduled(_controller, env): Promise<void> {
    await runScheduledTasks(env);
  },
} satisfies ExportedHandler<Env>;

export async function runScheduledTasks(
  env: Env,
  source: HubSpotDiscoverySource = new HubSpotClient(env.HUBSPOT_SERVICE_KEY),
): Promise<void> {
  if (!validateRuntimeConfig(env)) {
    logEvent("cron.skipped_not_configured");
    return;
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
