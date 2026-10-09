const eventNames = ["cron.skipped_not_configured", "route.rejected"] as const;

export type LogEvent = (typeof eventNames)[number];

export function logEvent(event: LogEvent): void {
  console.log(JSON.stringify({ level: "info", event }));
}
