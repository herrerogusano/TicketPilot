const eventNames = [
  "cron.skipped_not_configured",
  "cron.discovery_completed",
  "cron.discovery_failed",
  "route.rejected",
] as const;

export type LogEvent = (typeof eventNames)[number];

export function logEvent(event: LogEvent, fields: Record<string, number> = {}): void {
  console.log(JSON.stringify({ level: "info", event, ...fields }));
}
