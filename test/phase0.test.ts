import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { createHealthResponse, routeRequest } from "../src/index";
import { type RuntimeConfigInput, validateRuntimeConfig } from "../src/platform/config";

const configuredInput = {
  TICKETPILOT_ENV: "demo",
  TICKETPILOT_VERSION: "0.1.0",
  NOTION_PARENT_PAGE_ID: "3f3d34323f1a80b48e71c5860aeccc45",
  SLACK_CHANNEL_ID: "C0C7X4Y182E",
  SLACK_TEAM_ID: "T0C7S09984V",
  SLACK_APPROVER_USER_ID: "U123ABC",
  DEMO_START_AT: "2026-10-09T00:00:00Z",
  HUBSPOT_SERVICE_KEY: "configured",
  NOTION_TOKEN: "configured",
  SLACK_BOT_TOKEN: "configured",
  SLACK_SIGNING_SECRET: "configured",
  RESEND_API_KEY: "configured",
  TEST_RECIPIENT_EMAIL: "demo@example.test",
} satisfies RuntimeConfigInput;

describe("phase 0 safeguards", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
  });

  it("accepts complete demo configuration and rejects unsafe or missing configuration", () => {
    expect(validateRuntimeConfig(configuredInput)).toBe(true);
    expect(validateRuntimeConfig({ ...configuredInput, TICKETPILOT_ENV: "production" })).toBe(
      false,
    );
    expect(validateRuntimeConfig({ ...configuredInput, DEMO_START_AT: "not-a-date" })).toBe(false);
    expect(
      validateRuntimeConfig({ ...configuredInput, SLACK_APPROVER_USER_ID: "PENDING_LOOKUP" }),
    ).toBe(false);
    expect(validateRuntimeConfig({ ...configuredInput, TEST_RECIPIENT_EMAIL: "" })).toBe(false);
  });

  it("reports only version and configured status from the health route", async () => {
    const response = createHealthResponse(configuredInput);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, version: "0.1.0", configured: true });

    const missingConfig = { ...configuredInput, SLACK_SIGNING_SECRET: "" };
    expect(await (await createHealthResponse(missingConfig)).json()).toEqual({
      ok: true,
      version: "0.1.0",
      configured: false,
    });
  });

  it("rejects Slack callbacks until signature verification exists", async () => {
    const response = await routeRequest(
      new Request("https://ticketpilot.example/slack/actions", {
        method: "POST",
        body: "payload=untrusted",
      }),
      configuredInput,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "not_configured" });
  });

  it("does not expose an operational route", async () => {
    const response = await routeRequest(
      new Request("https://ticketpilot.example/admin"),
      configuredInput,
    );
    expect(response.status).toBe(404);
  });

  it("applies the D1 schema and rejects approval without supported evidence", async () => {
    const insertApproval = (id: string, evidenceStatus: string | null) =>
      env.DB.prepare(
        `INSERT INTO tickets (
          hubspot_ticket_id, created_at, updated_at, hubspot_created_at, subject, state,
          decision, decision_by, decision_at, evidence_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        id,
        "2026-10-09T00:00:00Z",
        "2026-10-09T00:00:00Z",
        "2026-10-09T00:00:00Z",
        "[TP-DEMO] Synthetic case",
        "APPROVED",
        "APPROVE",
        "U0C7X45H86N",
        "2026-10-09T00:00:01Z",
        evidenceStatus,
      );

    await expect(
      insertApproval("test-supported-approval", "SUPPORTED").run(),
    ).resolves.toMatchObject({ success: true });
    await expect(
      insertApproval("test-unsupported-approval", "INSUFFICIENT_EVIDENCE").run(),
    ).rejects.toThrow(/CHECK constraint failed/);
    await expect(insertApproval("test-null-evidence-approval", null).run()).rejects.toThrow(
      /CHECK constraint failed/,
    );
  });

  it("keeps the approved email payload immutable while allowing append-only event retention", async () => {
    const now = "2026-10-09T00:00:00Z";
    await env.DB.prepare(
      `INSERT INTO tickets (
        hubspot_ticket_id, created_at, updated_at, hubspot_created_at, subject, state
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    )
      .bind("test-immutable-payload", now, now, now, "[TP-DEMO] Synthetic case", "DISCOVERED")
      .run();
    await env.DB.prepare(
      "UPDATE tickets SET immutable_email_payload_json = ? WHERE hubspot_ticket_id = ?",
    )
      .bind('{"subject":"fixed"}', "test-immutable-payload")
      .run();

    await expect(
      env.DB.prepare(
        "UPDATE tickets SET immutable_email_payload_json = ? WHERE hubspot_ticket_id = ?",
      )
        .bind('{"subject":"changed"}', "test-immutable-payload")
        .run(),
    ).rejects.toThrow();

    await env.DB.prepare(
      "INSERT INTO events (id, ticket_id, event_type, at, details_redacted_json) VALUES (?, ?, ?, ?, ?)",
    )
      .bind("test-event", "test-immutable-payload", "DISCOVERED", now, "{}")
      .run();
    await expect(
      env.DB.prepare("UPDATE events SET event_type = ? WHERE id = ?")
        .bind("COMPLETED", "test-event")
        .run(),
    ).rejects.toThrow();
    const deleted = await env.DB.prepare("DELETE FROM events WHERE id = ?")
      .bind("test-event")
      .run();
    expect(deleted.success).toBe(true);
  });
});
