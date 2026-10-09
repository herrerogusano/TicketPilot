import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { findUniqueSeedTicket, seedCases } from "../scripts/seed-hubspot";
import { HubSpotClient, type HubSpotTicket } from "../src/adapters/hubspot";
import { runDiscovery, ticketIsEligible } from "../src/discovery";
import { TicketRepository } from "../src/state/ticket-repository";

const cutoff = "2026-10-09T00:09:06.000Z";
const now = new Date("2026-10-09T01:00:00.000Z");

function ticket(id: string, subject = `[TP-DEMO] Synthetic ${id}`): HubSpotTicket {
  return {
    id,
    createdAt: "2026-10-09T00:30:00.000Z",
    createdAtMs: Date.parse("2026-10-09T00:30:00.000Z"),
    subject,
    content: "Fictional issue body.",
  };
}

function searchResponse(results: unknown[], after?: string): Response {
  return Response.json({
    results,
    ...(after === undefined ? {} : { paging: { next: { after } } }),
  });
}

function rawTicket(
  id: string,
  values: { subject?: unknown; content?: unknown; createdate?: unknown },
): unknown {
  return {
    id,
    createdAt: "2026-10-09T00:30:00.000Z",
    properties: {
      subject: values.subject === undefined ? `[TP-DEMO] Synthetic ${id}` : values.subject,
      content: values.content === undefined ? "Synthetic body" : values.content,
      createdate: values.createdate === undefined ? "2026-10-09T00:30:00.000Z" : values.createdate,
    },
  };
}

describe("Phase 1 HubSpot discovery", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind("3000", "6999")
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind("3000", "6999")
      .run();
    await env.DB.prepare("DELETE FROM daily_usage WHERE utc_day = ?").bind("2026-10-09").run();
    const stale = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?",
    )
      .bind("3000", "6999")
      .first<{ count: number }>();
    expect(stale?.count).toBe(0);
  });

  it("requires literal demo prefix and both HubSpot timestamps to be at or after cutoff", async () => {
    const client = new HubSpotClient("test-token", async () =>
      searchResponse([
        rawTicket("1001", {}),
        rawTicket("1002", { subject: "Customer [TP-DEMO] mentioned" }),
        rawTicket("1003", { createdate: "2026-10-09T00:09:05.999Z" }),
        rawTicket("1004", { createdate: null }),
        {
          ...(rawTicket("1005", {}) as Record<string, unknown>),
          createdAt: "2026-10-09T00:09:05.999Z",
        },
      ]),
    );

    const eligible = await client.searchDemoTickets(cutoff);
    expect(eligible.map((item) => item.id)).toEqual(["1001"]);
    expect(eligible[0]?.subject.length).toBeLessThanOrEqual(160);
    expect(eligible[0]?.content.length).toBeLessThanOrEqual(3_000);
  });

  it("preserves the literal subject prefix and uses the older of both timestamps on readback", async () => {
    let raw = rawTicket("1010", { subject: " [TP-DEMO] leading whitespace" });
    const client = new HubSpotClient("test-token", async () => Response.json(raw));
    const prefixed = await client.getTicket("1010");
    expect(prefixed?.subject).toBe(" [TP-DEMO] leading whitespace");
    expect(prefixed === null ? false : ticketIsEligible(prefixed, cutoff)).toBe(false);

    raw = {
      ...(rawTicket("1011", { subject: "[TP-DEMO] synthetic" }) as Record<string, unknown>),
      createdAt: "2026-10-09T00:09:05.999Z",
    };
    const olderOuterTimestamp = await client.getTicket("1011");
    expect(olderOuterTimestamp?.createdAt).toBe("2026-10-09T00:09:05.999Z");
    expect(
      olderOuterTimestamp === null ? false : ticketIsEligible(olderOuterTimestamp, cutoff),
    ).toBe(false);
  });

  it("uses at most three pages and retries bounded 429/503 search responses", async () => {
    let calls = 0;
    const client = new HubSpotClient("test-token", async (_input, init) => {
      calls += 1;
      if (calls === 1) return new Response("{}", { status: 429, headers: { "Retry-After": "0" } });
      if (calls === 2) return new Response("{}", { status: 503 });
      const body = JSON.parse(String(init?.body)) as { after?: string };
      return body.after === undefined
        ? searchResponse([rawTicket("2001", {})], "cursor-1")
        : body.after === "cursor-1"
          ? searchResponse([rawTicket("2002", {})], "cursor-2")
          : searchResponse([rawTicket("2003", {})], "cursor-3");
    });

    const found = await client.searchDemoTickets(cutoff);
    expect(found.map((item) => item.id)).toEqual(["2001", "2002", "2003"]);
    expect(calls).toBe(5);
  });

  it("rejects malformed provider records and never retries a ticket-creation POST", async () => {
    const reads = new HubSpotClient("test-token", async () => searchResponse([{ id: "bad" }]));
    await expect(reads.searchDemoTickets(cutoff)).rejects.toThrow("invalid_search_response");

    let creates = 0;
    const writer = new HubSpotClient("test-token", async () => {
      creates += 1;
      return new Response("{}", { status: 503 });
    });
    await expect(
      writer.createTicket({
        subject: "[TP-DEMO] Fake",
        content: "Fake",
        pipelineId: "0",
        stageId: "1",
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(creates).toBe(1);
  });

  it("discovers active pipeline and stage by display order without treating ID zero as missing", async () => {
    const client = new HubSpotClient("test-token", async () =>
      Response.json({
        results: [
          {
            id: "1",
            displayOrder: 1,
            stages: [{ id: "4", displayOrder: 0 }],
          },
          {
            id: "0",
            displayOrder: 0,
            stages: [
              { id: "8", displayOrder: 1 },
              { id: "1", displayOrder: 0 },
            ],
          },
        ],
      }),
    );
    await expect(client.getFirstActivePipeline()).resolves.toEqual({ id: "0", stageId: "1" });
    await expect(client.getFirstActivePipeline("1", "4")).resolves.toEqual({
      id: "1",
      stageId: "4",
    });
  });

  it("defines exactly five distinct synthetic seed cases", () => {
    expect(seedCases).toHaveLength(5);
    expect(new Set(seedCases.map((item) => item.subject)).size).toBe(5);
    expect(new Set(seedCases.map((item) => item.content.split("\n")[0])).size).toBe(5);
    expect(seedCases.every((item) => item.subject.startsWith("[TP-DEMO]"))).toBe(true);
    expect(
      findUniqueSeedTicket(
        [
          { id: "1", content: "TP_UNIQUE_MARKER content" },
          { id: "2", content: "unrelated" },
        ],
        "TP_UNIQUE_MARKER",
      ),
    ).toBe("1");
    expect(() =>
      findUniqueSeedTicket(
        [
          { id: "1", content: "TP_DUPLICATE_MARKER one" },
          { id: "2", content: "TP_DUPLICATE_MARKER two" },
        ],
        "TP_DUPLICATE_MARKER",
      ),
    ).toThrow("ambiguous_seed_marker_manual_reconciliation_required");
  });

  it("discovers the association type and verifies note marker plus ticket association", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new HubSpotClient("test-token", async (input, init) => {
      const url = String(input);
      requests.push({ url, init });
      if (url.endsWith("/crm/associations/2026-09/notes/tickets/labels")) {
        return Response.json({
          results: [
            { category: "USER_DEFINED", label: "Unrelated", typeId: 999 },
            { category: "HUBSPOT_DEFINED", label: null, typeId: 123 },
          ],
        });
      }
      if (url.endsWith("/crm/v3/objects/notes")) return Response.json({ id: "9101" });
      if (url.includes("/crm/v3/objects/tickets/9001?associations=notes")) {
        return Response.json({ associations: { notes: { results: [{ id: "9101" }] } } });
      }
      if (url.includes("/crm/v3/objects/notes/9101?")) {
        return Response.json({
          id: "9101",
          properties: { hs_note_body: "TP_MARKER synthetic audit" },
          associations: { tickets: { results: [{ id: "9001" }] } },
        });
      }
      return new Response("not found", { status: 404 });
    });

    await expect(client.createNote("9001", "TP_MARKER synthetic audit")).resolves.toBe("9101");
    const noteRequest = requests.find((request) => request.url.endsWith("/crm/v3/objects/notes"));
    const noteBody = JSON.parse(String(noteRequest?.init?.body)) as {
      associations: Array<{ types: Array<{ associationTypeId: number }> }>;
    };
    expect(noteBody.associations[0]?.types[0]?.associationTypeId).toBe(123);
    await expect(client.findAssociatedNote("9001", "TP_MARKER")).resolves.toBe("9101");
  });

  it("fails closed rather than inspecting an unbounded note association list", async () => {
    let requests = 0;
    const client = new HubSpotClient("test-token", async () => {
      requests += 1;
      return Response.json({
        associations: {
          notes: {
            results: Array.from({ length: 51 }, (_, index) => ({ id: String(9100 + index) })),
          },
        },
      });
    });
    await expect(client.findAssociatedNote("9001", "TP_MARKER")).rejects.toThrow(
      "too_many_associated_notes",
    );
    expect(requests).toBe(1);
  });
});

describe("Phase 1 D1 admission and workflow recovery", () => {
  beforeEach(async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind("3000", "6999")
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind("3000", "6999")
      .run();
    await env.DB.prepare("DELETE FROM daily_usage WHERE utc_day = ?").bind("2026-10-09").run();
  });

  it("atomically enforces one claim per ticket and the 20-per-UTC-day cap", async () => {
    const repository = new TicketRepository(env.DB);
    const duplicateClaims = await Promise.all([
      repository.claimEligible(ticket("3001"), now),
      repository.claimEligible(ticket("3001"), now),
    ]);
    expect(duplicateClaims.sort()).toEqual(["claimed", "duplicate"]);

    for (let index = 0; index < 19; index += 1) {
      expect(await repository.claimEligible(ticket(String(3002 + index)), now)).toBe("claimed");
    }
    expect(await repository.claimEligible(ticket("3999"), now)).toBe("daily_limit");
    expect(await repository.claimEligible(ticket("3001"), now)).toBe("duplicate");

    const counter = await env.DB.prepare(
      "SELECT accepted_ticket_count FROM daily_usage WHERE utc_day = ?",
    )
      .bind("2026-10-09")
      .first<{ accepted_ticket_count: number }>();
    expect(counter?.accepted_ticket_count).toBe(20);
  });

  it("checks known IDs in bounded chunks for more than 100 HubSpot candidates", async () => {
    const repository = new TicketRepository(env.DB);
    for (const id of ["6400", "6500", "6649"]) {
      expect(await repository.claimEligible(ticket(id), now)).toBe("claimed");
    }
    const candidates = Array.from({ length: 250 }, (_, index) => String(6400 + index));
    expect(await repository.listKnownTicketIds(candidates)).toEqual(
      new Set(["6400", "6500", "6649"]),
    );
  });

  it("recovers overlapping polls and starts only one deterministic Workflow", async () => {
    const repository = new TicketRepository(env.DB);
    const known = new Map<string, { id: string }>();
    let createCalls = 0;
    const workflows = {
      async get(id: string): Promise<{ id: string }> {
        const existing = known.get(id);
        if (existing === undefined) throw new Error("not found");
        return existing;
      },
      async create(options: { id: string; params: { ticketId: string } }): Promise<{ id: string }> {
        createCalls += 1;
        if (known.has(options.id)) throw new Error("duplicate workflow id");
        const created = { id: options.id };
        known.set(options.id, created);
        await env.DB.prepare(
          "UPDATE tickets SET state = 'AWAITING_APPROVAL' WHERE hubspot_ticket_id = ?",
        )
          .bind(options.params.ticketId)
          .run();
        return created;
      },
    };
    const source = {
      async searchDemoTickets(): Promise<HubSpotTicket[]> {
        return [ticket("4001")];
      },
    };
    const args = { cutoff, now, source, store: repository, workflows };

    await Promise.all([runDiscovery(args), runDiscovery(args)]);
    const row = await env.DB.prepare(
      "SELECT workflow_instance_id, workflow_create_status, state FROM tickets WHERE hubspot_ticket_id = ?",
    )
      .bind("4001")
      .first<{ workflow_instance_id: string; workflow_create_status: string; state: string }>();
    expect(row).toEqual({
      workflow_instance_id: "ticketpilot-4001",
      workflow_create_status: "STARTED",
      state: "AWAITING_APPROVAL",
    });
    expect(createCalls).toBe(1);
  });

  it("reconciles a create that committed before its response failed, then retries cleanly after a definite failure", async () => {
    const repository = new TicketRepository(env.DB);
    const first = ticket("5001");
    expect(await repository.claimEligible(first, now)).toBe("claimed");
    const committed = new Map<string, { id: string }>();
    const workflows = {
      async get(id: string): Promise<{ id: string }> {
        const value = committed.get(id);
        if (value === undefined) throw new Error("not found");
        return value;
      },
      async create(options: { id: string }): Promise<{ id: string }> {
        committed.set(options.id, { id: options.id });
        throw new Error("response was lost");
      },
    };

    const recovered = await runDiscovery({
      cutoff,
      now,
      source: {
        async searchDemoTickets() {
          return [];
        },
      },
      store: repository,
      workflows,
    });
    expect(recovered.reconciled).toBe(1);

    const second = ticket("5002");
    expect(await repository.claimEligible(second, now)).toBe("claimed");
    let calls = 0;
    const retrying = {
      async get(): Promise<never> {
        throw new Error("not found");
      },
      async create(options: { id: string }): Promise<{ id: string }> {
        calls += 1;
        if (calls === 1) throw new Error("definite creation failure");
        return { id: options.id };
      },
    };
    const failed = await runDiscovery({
      cutoff,
      now,
      source: {
        async searchDemoTickets() {
          return [];
        },
      },
      store: repository,
      workflows: retrying,
    });
    expect(failed.deferred).toBe(1);
    const pending = await repository.listRecoverable(5);
    expect(
      pending.some(
        (row) => row.hubspot_ticket_id === "5002" && row.workflow_create_status === "PENDING",
      ),
    ).toBe(true);

    const retried = await runDiscovery({
      cutoff,
      now,
      source: {
        async searchDemoTickets() {
          return [];
        },
      },
      store: repository,
      workflows: retrying,
    });
    expect(retried.workflowsStarted).toBe(1);
    expect(calls).toBe(2);
  });

  it("stops after three failed Workflow create attempts and permits only later metadata reconciliation", async () => {
    const repository = new TicketRepository(env.DB);
    expect(await repository.claimEligible(ticket("5501"), now)).toBe("claimed");
    let creates = 0;
    const workflows = {
      async get(): Promise<never> {
        throw new Error("not found");
      },
      async create(): Promise<never> {
        creates += 1;
        throw new Error("creation failed");
      },
    };
    const emptySource = {
      async searchDemoTickets() {
        return [];
      },
    };

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await runDiscovery({ cutoff, now, source: emptySource, store: repository, workflows });
    }
    expect(creates).toBe(3);
    const row = await env.DB.prepare(
      "SELECT workflow_create_status, workflow_create_attempts, state, error_code FROM tickets WHERE hubspot_ticket_id = ?",
    )
      .bind("5501")
      .first<{
        workflow_create_status: string;
        workflow_create_attempts: number;
        state: string;
        error_code: string;
      }>();
    expect(row).toEqual({
      workflow_create_status: "MANUAL_REVIEW",
      workflow_create_attempts: 3,
      state: "NEEDS_MANUAL_REVIEW",
      error_code: "WORKFLOW_CREATE_RETRIES_EXHAUSTED",
    });
    const event = await env.DB.prepare(
      "SELECT event_type, details_redacted_json FROM events WHERE ticket_id = ?",
    )
      .bind("5501")
      .first<{ event_type: string; details_redacted_json: string }>();
    expect(event).toEqual({
      event_type: "WORKFLOW_CREATE_RETRIES_EXHAUSTED",
      details_redacted_json: '{"attempts":3}',
    });

    const existing = new Map([["ticketpilot-5501", { id: "ticketpilot-5501" }]]);
    const recovered = await runDiscovery({
      cutoff,
      now,
      source: {
        async searchDemoTickets() {
          return [ticket("5502")];
        },
      },
      store: repository,
      workflows: {
        async get(id: string) {
          const found = existing.get(id);
          if (found === undefined) throw new Error("not found");
          return found;
        },
        async create(options: { id: string }): Promise<{ id: string }> {
          if (options.id === "ticketpilot-5501") {
            throw new Error("manual-review rows must not recreate Workflows");
          }
          return { id: options.id };
        },
      },
    });
    expect(recovered.reconciled).toBe(1);
    expect(recovered.workflowsStarted).toBe(1);
    const afterReconcile = await env.DB.prepare(
      "SELECT workflow_create_status, state FROM tickets WHERE hubspot_ticket_id = ?",
    )
      .bind("5501")
      .first<{ workflow_create_status: string; state: string }>();
    expect(afterReconcile).toEqual({
      workflow_create_status: "STARTED",
      state: "NEEDS_MANUAL_REVIEW",
    });
  });

  it("bounds admissions and starts to one per poll for Free CPU headroom", async () => {
    const repository = new TicketRepository(env.DB);
    const source = {
      async searchDemoTickets(): Promise<HubSpotTicket[]> {
        return Array.from({ length: 8 }, (_, index) => ticket(String(6000 + index)));
      },
    };
    const created: string[] = [];
    const workflows = {
      async get(): Promise<never> {
        throw new Error("not found");
      },
      async create(options: { id: string }): Promise<{ id: string }> {
        created.push(options.id);
        return { id: options.id };
      },
    };

    const report = await runDiscovery({ cutoff, now, source, store: repository, workflows });
    expect(report.claimed).toBe(1);
    expect(report.workflowsStarted).toBe(1);
    expect(created).toHaveLength(1);
    expect(await repository.listKnownTicketIds(["6005", "6006", "6007"])).toEqual(new Set());
  });
});
