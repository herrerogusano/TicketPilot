import { HubSpotClient } from "./adapters/hubspot";
import { runDiscovery } from "./discovery";
import { type RuntimeConfigInput, validateRuntimeConfig } from "./platform/config";
import { logEvent } from "./platform/logging";
import { TicketRepository } from "./state/ticket-repository";

export { TicketWorkflow } from "./workflows/ticket-workflow";

export function createHealthResponse(config: RuntimeConfigInput): Response {
  return Response.json({
    ok: true,
    version: config.TICKETPILOT_VERSION,
    configured: validateRuntimeConfig(config),
  });
}

export async function routeRequest(
  request: Request,
  config: RuntimeConfigInput,
): Promise<Response> {
  const url = new URL(request.url);

  if (request.method === "GET" && url.pathname === "/health") {
    return createHealthResponse(config);
  }

  if (request.method === "POST" && url.pathname === "/slack/actions") {
    logEvent("route.rejected");
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  return Response.json({ error: "not_found" }, { status: 404 });
}

export default {
  async fetch(request, env): Promise<Response> {
    return routeRequest(request, env);
  },
  async scheduled(_controller, env): Promise<void> {
    if (!validateRuntimeConfig(env)) {
      logEvent("cron.skipped_not_configured");
      return;
    }
    try {
      const report = await runDiscovery({
        cutoff: env.DEMO_START_AT,
        source: new HubSpotClient(env.HUBSPOT_SERVICE_KEY),
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
  },
} satisfies ExportedHandler<Env>;
