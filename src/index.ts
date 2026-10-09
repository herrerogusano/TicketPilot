import { type RuntimeConfigInput, validateRuntimeConfig } from "./platform/config";
import { logEvent } from "./platform/logging";

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
    }
  },
} satisfies ExportedHandler<Env>;
