import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { type TicketProposal, unsupportedProposal } from "../src/domain/contracts";
import { NO_MODEL_PROMPT_VERSION } from "../src/domain/prompt";
import { TicketRepository } from "../src/state/ticket-repository";
import { hashProposal } from "../src/workflows/ticket-workflow";

const day = "2099-01-03";
const date = new Date(`${day}T12:00:00.000Z`);
let firstId = 8_200_000_000_000 + (Date.now() % 100_000_000);
let lastId = firstId + 99;

async function insertTicket(id: number, state = "PROCESSING"): Promise<void> {
  await env.DB.prepare(`INSERT INTO tickets (
      hubspot_ticket_id, workflow_instance_id, created_at, updated_at, hubspot_created_at,
      subject, state
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(
      String(id),
      `ticketpilot-test-${id}`,
      date.toISOString(),
      date.toISOString(),
      date.toISOString(),
      `[TP-DEMO] Synthetic test ${id}`,
      state,
    )
    .run();
}

const proposal: TicketProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "Se revisará el posible cargo duplicado.",
  draft_reply: "Podemos derivar el caso al equipo de facturación.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "La política permite revisar importes sin pedir datos de tarjeta.",
};

describe("Phase 2 D1 proposal persistence and atomic AI budgets", () => {
  beforeEach(async () => {
    firstId += 1_000;
    lastId = firstId + 99;
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
    await env.DB.prepare("DELETE FROM events WHERE ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare(
      "DELETE FROM ai_call_reservations WHERE ticket_id BETWEEN ? AND ? OR utc_day = ?",
    )
      .bind(String(firstId), String(lastId), day)
      .run();
    await env.DB.prepare("DELETE FROM tickets WHERE hubspot_ticket_id BETWEEN ? AND ?")
      .bind(String(firstId), String(lastId))
      .run();
    await env.DB.prepare("DELETE FROM daily_usage WHERE utc_day = ?").bind(day).run();
  });

  it("atomically allows two calls per ticket, denies a third, and races without exceeding two", async () => {
    await insertTicket(firstId);
    const repository = new TicketRepository(env.DB);
    const first = await repository.reserveAiCall(String(firstId), 1, date);
    const second = await repository.reserveAiCall(String(firstId), 2, date);
    expect(first?.attempt).toBe(1);
    expect(second?.attempt).toBe(2);
    expect(await repository.reserveAiCall(String(firstId), 2, date)).toBeNull();
    const racedId = firstId + 1;
    await insertTicket(racedId);
    const raced = await Promise.all(
      Array.from({ length: 8 }, () => repository.reserveAiCall(String(racedId), 1, date)),
    );
    expect(raced.filter((entry) => entry !== null).length).toBeGreaterThanOrEqual(1);
    expect(raced.filter((entry) => entry !== null).length).toBeLessThanOrEqual(2);
    const attempts = await env.DB.prepare(
      "SELECT ai_call_attempts FROM tickets WHERE hubspot_ticket_id = ?",
    )
      .bind(String(racedId))
      .first<{ ai_call_attempts: number }>();
    expect(attempts?.ai_call_attempts).toBe(raced.filter((entry) => entry !== null).length);
    const daily = await env.DB.prepare("SELECT ai_call_count FROM daily_usage WHERE utc_day = ?")
      .bind(day)
      .first<{ ai_call_count: number }>();
    expect(daily?.ai_call_count).toBe(2 + (attempts?.ai_call_attempts ?? 0));
  });

  it("enforces the 20-call UTC-day ceiling under concurrent reservations", async () => {
    const ids = Array.from({ length: 21 }, (_, index) => firstId + index);
    for (const id of ids) await insertTicket(id);
    const repository = new TicketRepository(env.DB);
    const reserved = await Promise.all(
      ids.map((id) => repository.reserveAiCall(String(id), 1, date)),
    );
    expect(reserved.filter((entry) => entry !== null)).toHaveLength(20);
    const daily = await env.DB.prepare("SELECT ai_call_count FROM daily_usage WHERE utc_day = ?")
      .bind(day)
      .first<{ ai_call_count: number }>();
    expect(daily?.ai_call_count).toBe(20);
  });

  it("globally spaces concurrent Notion request slots by at least 350ms", async () => {
    const repository = new TicketRepository(env.DB);
    const slots = await Promise.all(
      Array.from({ length: 5 }, () => repository.reserveNotionRequestSlot(Date.now())),
    );
    const ordered = [...slots].sort((left, right) => left - right);
    for (let index = 1; index < ordered.length; index += 1) {
      expect((ordered[index] ?? 0) - (ordered[index - 1] ?? 0)).toBeGreaterThanOrEqual(350);
    }
  });

  it("persists one immutable proposal with hashes, prompt revision metadata, evidence links, and redacted events", async () => {
    await insertTicket(firstId);
    const repository = new TicketRepository(env.DB);
    const evidence = [
      {
        key: "billing-double-charge" as const,
        title: "[TP-KB:billing-double-charge] Duplicate billing",
        url: "https://www.notion.so/policy",
        contentHash: "a".repeat(64),
      },
    ];
    expect(
      await repository.saveProposal(
        String(firstId),
        proposal,
        "b".repeat(64),
        "ticketpilot-v1",
        evidence,
        date,
      ),
    ).toBe(true);
    expect(
      await repository.saveProposal(
        String(firstId),
        proposal,
        "c".repeat(64),
        "ticketpilot-v1",
        evidence,
        date,
      ),
    ).toBe(false);
    const stored = await repository.getProposal(String(firstId));
    expect(stored).toMatchObject({
      proposalHash: "b".repeat(64),
      revision: 1,
      promptVersion: "ticketpilot-v1",
      evidence_status: "SUPPORTED",
      cited_policy_keys: ["billing-double-charge"],
      policyEvidence: evidence,
    });
    const row = await repository.getPhase2Ticket(String(firstId));
    expect(row?.state).toBe("AWAITING_APPROVAL");
    await expect(
      env.DB.prepare("UPDATE tickets SET draft_reply = 'tampered' WHERE hubspot_ticket_id = ?")
        .bind(String(firstId))
        .run(),
    ).rejects.toThrow("proposal is immutable");
    const event = await env.DB.prepare(
      "SELECT event_type, details_redacted_json FROM events WHERE ticket_id = ?",
    )
      .bind(String(firstId))
      .first<{ event_type: string; details_redacted_json: string }>();
    expect(event?.event_type).toBe("PROPOSAL_PERSISTED");
    expect(event?.details_redacted_json).not.toContain(proposal.draft_reply);
    const eventCount = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM events WHERE ticket_id = ? AND event_type = 'PROPOSAL_PERSISTED'",
    )
      .bind(String(firstId))
      .first<{ count: number }>();
    expect(eventCount?.count).toBe(1);
  });

  it("captures an old-worker proposal write into immutable revision 1 after migration", async () => {
    await insertTicket(firstId);
    const evidence = [
      {
        key: "billing-double-charge" as const,
        title: "Duplicate billing",
        url: "https://www.notion.so/policy",
        contentHash: "a".repeat(64),
      },
    ];
    const hash = await hashProposal({
      ticketId: String(firstId),
      revision: 1,
      proposal,
      evidence,
      promptVersion: "ticketpilot-v1",
    });
    // Simulate an already-running Worker version that does not know about proposal_revisions.
    await env.DB.prepare(`UPDATE tickets SET category = ?, priority = ?, evidence_status = ?,
        proposal_summary = ?, draft_reply = ?, policy_keys_json = ?, proposal_rationale = ?,
        policy_evidence_json = ?, proposal_hash = ?, prompt_version = ?, state = 'AWAITING_APPROVAL'
      WHERE hubspot_ticket_id = ? AND state = 'PROCESSING' AND proposal_hash IS NULL`)
      .bind(
        proposal.category,
        proposal.priority,
        proposal.evidence_status,
        proposal.summary,
        proposal.draft_reply,
        JSON.stringify(proposal.cited_policy_keys),
        proposal.rationale,
        JSON.stringify(evidence),
        hash,
        "ticketpilot-v1",
        String(firstId),
      )
      .run();
    const history = await new TicketRepository(env.DB).getProposalRevisionHistory(String(firstId));
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      revision: 1,
      proposal_hash: hash,
      edit_reason: null,
      edited_by: null,
    });
    expect(JSON.parse(history[0]?.proposal_json ?? "{}")).toMatchObject({
      draft_reply: proposal.draft_reply,
      summary: proposal.summary,
      proposalHash: hash,
      revision: 1,
    });
  });

  it("persists identical proposals for distinct tickets without event or hash collisions", async () => {
    const secondId = firstId + 3;
    await insertTicket(firstId);
    await insertTicket(secondId);
    const repository = new TicketRepository(env.DB);
    const evidence = [
      {
        key: "billing-double-charge" as const,
        title: "Duplicate billing",
        url: "https://www.notion.so/policy",
        contentHash: "a".repeat(64),
      },
    ];
    const firstHash = await hashProposal({
      ticketId: String(firstId),
      revision: 1,
      proposal,
      evidence,
      promptVersion: "ticketpilot-v1",
    });
    const secondHash = await hashProposal({
      ticketId: String(secondId),
      revision: 1,
      proposal,
      evidence,
      promptVersion: "ticketpilot-v1",
    });
    expect(firstHash).not.toBe(secondHash);
    for (const [ticketId, proposalHash] of [
      [String(firstId), firstHash],
      [String(secondId), secondHash],
    ] as const) {
      expect(
        await repository.saveProposal(
          ticketId,
          proposal,
          proposalHash,
          "ticketpilot-v1",
          evidence,
          date,
        ),
      ).toBe(true);
    }
    const events = await env.DB.prepare(
      "SELECT ticket_id, id FROM events WHERE ticket_id IN (?, ?) AND event_type = 'PROPOSAL_PERSISTED'",
    )
      .bind(String(firstId), String(secondId))
      .all<{ ticket_id: string; id: string }>();
    expect(events.results).toHaveLength(2);
    expect(new Set(events.results.map((event) => event.id)).size).toBe(2);
  });

  it("does not regress or overwrite a ticket that has already advanced", async () => {
    await insertTicket(firstId, "AWAITING_APPROVAL");
    const repository = new TicketRepository(env.DB);
    expect(await repository.reserveAiCall(String(firstId), 1, date)).toBeNull();
    expect(
      await repository.saveProposal(
        String(firstId),
        proposal,
        "d".repeat(64),
        "ticketpilot-v1",
        [],
        date,
      ),
    ).toBe(false);
    const row = await repository.getPhase2Ticket(String(firstId));
    expect(row?.state).toBe("AWAITING_APPROVAL");
    expect(row?.proposal_hash).toBeNull();
  });

  it("reconciles the workflow-create/start race without moving advanced states backwards", async () => {
    const discoveredId = firstId + 2;
    await insertTicket(discoveredId, "DISCOVERED");
    await env.DB.prepare(
      "UPDATE tickets SET workflow_create_status = 'CREATING' WHERE hubspot_ticket_id = ?",
    )
      .bind(String(discoveredId))
      .run();
    const repository = new TicketRepository(env.DB);
    await repository.beginProcessing(String(discoveredId), date);
    expect((await repository.getPhase2Ticket(String(discoveredId)))?.state).toBe("PROCESSING");
    await env.DB.prepare(
      "UPDATE tickets SET state = 'AWAITING_APPROVAL' WHERE hubspot_ticket_id = ?",
    )
      .bind(String(discoveredId))
      .run();
    await repository.beginProcessing(String(discoveredId), date);
    expect((await repository.getPhase2Ticket(String(discoveredId)))?.state).toBe(
      "AWAITING_APPROVAL",
    );
  });

  it("persists an insufficient-evidence result to manual review without a model reservation", async () => {
    await insertTicket(firstId);
    const repository = new TicketRepository(env.DB);
    const noEvidence: TicketProposal = {
      category: "OTHER",
      priority: "LOW",
      evidence_status: "INSUFFICIENT_EVIDENCE",
      summary: "No se encontró una política aplicable para responder con seguridad.",
      draft_reply: "",
      cited_policy_keys: [],
      rationale:
        "Revisión manual necesaria: la base de conocimiento no aporta evidencia suficiente.",
    };
    expect(
      await repository.saveProposal(
        String(firstId),
        noEvidence,
        "e".repeat(64),
        "ticketpilot-v1",
        [],
        date,
      ),
    ).toBe(true);
    const row = await repository.getPhase2Ticket(String(firstId));
    expect(row?.state).toBe("NEEDS_MANUAL_REVIEW");
    expect(row?.ai_call_attempts).toBe(0);
  });

  it("persists an explicit no-model prompt version for deterministic unsupported cases", async () => {
    await insertTicket(firstId);
    const repository = new TicketRepository(env.DB);
    const noDocsProposal = unsupportedProposal("en");
    expect(
      await repository.saveProposal(
        String(firstId),
        noDocsProposal,
        "f".repeat(64),
        NO_MODEL_PROMPT_VERSION,
        [],
        date,
      ),
    ).toBe(true);
    expect((await repository.getProposal(String(firstId)))?.promptVersion).toBe(
      "ticketpilot-v1/no-model",
    );
  });
});
