import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { runScheduledTasks } from "../src/index";
import { isEventMaintenanceDue, pruneExpiredEvents } from "../src/state/event-retention";

const now = new Date("2100-01-31T09:00:32.000Z");
const id = "95000";
const scheduledEnv = {
  ...env,
  HUBSPOT_SERVICE_KEY: "pat-test1234567890",
  NOTION_TOKEN: "ntn_test123456789012345678901234567890",
  SLACK_BOT_TOKEN: "xoxb-test-12345678901234567890",
  SLACK_SIGNING_SECRET: "0123456789abcdef0123456789abcdef",
  RESEND_API_KEY: "re_test123456789012345678901234",
  TEST_RECIPIENT_EMAIL: "demo@example.test",
} as Env;

describe("bounded redacted event retention", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id = ?").bind(id).run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id = ?").bind(id).run();
    await env.DB.prepare(`INSERT INTO tickets (hubspot_ticket_id, created_at, updated_at,
        hubspot_created_at, subject, state, workflow_instance_id, workflow_create_status)
        VALUES (?, ?, ?, ?, '[TP-DEMO] retention', 'SEND_UNKNOWN', 'retention-fixture', 'STARTED')`)
      .bind(id, now.toISOString(), now.toISOString(), now.toISOString())
      .run();
  });

  it("caps a batch at100, preserves recent events and durable uncertain-send identity", async () => {
    const statements = Array.from({ length: 105 }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO events (id,ticket_id,event_type,at,details_redacted_json) VALUES (?,?,'TEST',?,'{}')",
      ).bind(`retention-old-${index}`, id, "2099-12-01T00:00:00.000Z"),
    );
    statements.push(
      env.DB.prepare(
        "INSERT INTO events (id,ticket_id,event_type,at,details_redacted_json) VALUES (?,?,'TEST',?,'{}')",
      ).bind("retention-recent", id, now.toISOString()),
    );
    await env.DB.batch(statements);
    expect(await pruneExpiredEvents(env.DB, now)).toBe(100);
    const count = await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE ticket_id = ?")
      .bind(id)
      .first<{ count: number }>();
    expect(count?.count).toBe(6);
    expect(
      await env.DB.prepare("SELECT state FROM tickets WHERE hubspot_ticket_id = ?")
        .bind(id)
        .first<{ state: string }>(),
    ).toEqual({ state: "SEND_UNKNOWN" });
    expect(await pruneExpiredEvents(env.DB, now)).toBe(5);
    expect(await pruneExpiredEvents(env.DB, now)).toBe(0);
  });

  it("runs only on the hourly cron slot, and rejects invalid time", async () => {
    expect(isEventMaintenanceDue(now)).toBe(true);
    expect(isEventMaintenanceDue(new Date("2100-01-31T09:05:32.000Z"))).toBe(false);
    expect(isEventMaintenanceDue(new Date(Number.NaN))).toBe(false);
    await expect(pruneExpiredEvents(env.DB, new Date(Number.NaN))).rejects.toThrow(
      "invalid_retention_time",
    );
  });

  it("runs hourly maintenance even when the independently bounded source pass fails", async () => {
    await env.DB.prepare(
      "INSERT INTO events (id,ticket_id,event_type,at,details_redacted_json) VALUES (?,?,'TEST',?,'{}')",
    )
      .bind("retention-scheduled", id, "2099-12-01T00:00:00.000Z")
      .run();
    await runScheduledTasks(
      scheduledEnv,
      {
        async searchDemoTickets() {
          throw new Error("synthetic outage");
        },
      },
      now,
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE ticket_id = ?")
        .bind(id)
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await env.DB.prepare("SELECT state FROM tickets WHERE hubspot_ticket_id = ?")
        .bind(id)
        .first<{ state: string }>(),
    ).toEqual({ state: "SEND_UNKNOWN" });
  });

  it("does not prune on the intervening five-minute cron slots", async () => {
    await env.DB.prepare(
      "INSERT INTO events (id,ticket_id,event_type,at,details_redacted_json) VALUES (?,?,'TEST',?,'{}')",
    )
      .bind("retention-off-slot", id, "2099-12-01T00:00:00.000Z")
      .run();
    await runScheduledTasks(
      scheduledEnv,
      {
        async searchDemoTickets() {
          return [];
        },
      },
      new Date("2100-01-31T09:05:32.000Z"),
    );
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS count FROM events WHERE ticket_id = ?")
        .bind(id)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });
});
