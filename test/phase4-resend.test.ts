import { describe, expect, it, vi } from "vitest";
import { buildImmutableEmailPayload, hashEmailPayload, ResendClient } from "../src/adapters/resend";
import type { StoredProposal } from "../src/domain/contracts";

const proposal: StoredProposal = {
  category: "BILLING",
  priority: "MEDIUM",
  evidence_status: "SUPPORTED",
  summary: "Review the duplicate charge.",
  draft_reply: "We can review the two charges under the billing policy.",
  cited_policy_keys: ["billing-double-charge"],
  rationale: "The cited policy permits a billing review.",
  proposalHash: "a".repeat(64),
  revision: 1,
  promptVersion: "ticketpilot-v1",
  policyEvidence: [
    {
      key: "billing-double-charge",
      title: "Duplicate billing",
      url: "https://www.notion.so/policy",
      contentHash: "b".repeat(64),
    },
  ],
};

describe("Phase 4 Resend adapter", () => {
  it("freezes a plain-text body for only the configured recipient and hashes deterministically", async () => {
    const payload = buildImmutableEmailPayload(
      "12345",
      proposal,
      "owner@example.test",
      "[TP-DEMO] Billing question",
    );
    expect(payload).toEqual({
      from: "TicketPilot Demo <onboarding@resend.dev>",
      to: ["owner@example.test"],
      subject: "[TicketPilot DEMO] Ticket 12345 — Billing question",
      text: proposal.draft_reply,
    });
    expect(payload).not.toHaveProperty("html");
    expect(await hashEmailPayload(payload)).toBe(await hashEmailPayload(payload));
    expect(await hashEmailPayload({ ...payload, text: `${payload.text}\nchanged` })).not.toBe(
      await hashEmailPayload(payload),
    );
    expect(() =>
      buildImmutableEmailPayload(
        "12",
        { ...proposal, evidence_status: "INSUFFICIENT_EVIDENCE" },
        "owner@example.test",
      ),
    ).toThrow("email_requires_supported_proposal");
  });

  it("sanitizes ticket subjects and excludes internal proposal metadata from the body hash", async () => {
    const payload = buildImmutableEmailPayload(
      "12345",
      proposal,
      "owner@example.test",
      "[TP-DEMO] Billing\r\n\u0000question",
    );
    expect(payload.subject).toBe("[TicketPilot DEMO] Ticket 12345 — Billing question");
    expect(
      Array.from(payload.subject).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 31 || (code >= 127 && code <= 159);
      }),
    ).toBe(false);
    expect(payload.subject.length).toBeLessThanOrEqual(240);
    expect(
      buildImmutableEmailPayload("12345", proposal, "owner@example.test", "x".repeat(500)).subject,
    ).toHaveLength(240);
    expect(buildImmutableEmailPayload("12345", proposal, "owner@example.test", "").subject).toBe(
      "[TicketPilot DEMO] Ticket 12345 — Response",
    );

    const changedMetadata = {
      ...proposal,
      category: "OTHER" as const,
      priority: "HIGH" as const,
      summary: "Different internal summary",
      rationale: "Different internal rationale",
      cited_policy_keys: [],
      policyEvidence: [],
    };
    const changedPayload = buildImmutableEmailPayload(
      "12345",
      changedMetadata,
      "owner@example.test",
      "[TP-DEMO] Billing\r\n\u0000question",
    );
    expect(changedPayload).toEqual(payload);
    expect(await hashEmailPayload(changedPayload)).toBe(await hashEmailPayload(payload));
  });

  it("uses exact immutable body and idempotency key, and parses accepted IDs", async () => {
    const payload = buildImmutableEmailPayload("12345", proposal, "owner@example.test");
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      Response.json({ id: "aB_123" }, { status: 200 }),
    );
    const result = await new ResendClient(`re_${"x".repeat(24)}`, fetcher).send(
      payload,
      "ticketpilot/12345/v1",
    );
    expect(result).toEqual({ kind: "accepted", messageId: "aB_123" });
    expect(String(fetcher.mock.calls[0]?.[0])).toBe("https://api.resend.com/emails");
    const init = fetcher.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("Idempotency-Key")).toBe("ticketpilot/12345/v1");
    expect(JSON.parse(String(init?.body))).toEqual(payload);
    expect(JSON.parse(String(init?.body)).text).toBe(proposal.draft_reply);
  });

  it.each([
    ["provider conflict", 409, {}, "unknown"],
    ["request timeout", 408, {}, "unknown"],
    ["server failure", 503, {}, "unknown"],
    ["bad API key", 401, {}, "rejected"],
    ["invalid request", 422, {}, "rejected"],
    ["rate limit", 429, { "Retry-After": "2" }, "rate_limited"],
    ["oversized Retry-After", 429, { "Retry-After": "900" }, "rate_limited"],
  ] as const)("classifies %s without exposing provider response text", async (_name, status, headers, expected) => {
    const client = new ResendClient(
      `re_${"x".repeat(24)}`,
      async () => new Response("raw-provider-private-body", { status, headers }),
    );
    const result = await client.send(
      buildImmutableEmailPayload("12345", proposal, "owner@example.test"),
      "ticketpilot/12345/v1",
    );
    expect(result.kind).toBe(expected);
    expect(JSON.stringify(result)).not.toContain("raw-provider-private-body");
  });

  it("treats malformed success and network failures as unknown", async () => {
    const payload = buildImmutableEmailPayload("12345", proposal, "owner@example.test");
    const invalidSuccess = new ResendClient(`re_${"x".repeat(24)}`, async () =>
      Response.json({ ok: true }),
    );
    await expect(invalidSuccess.send(payload, "ticketpilot/12345/v1")).resolves.toEqual({
      kind: "unknown",
    });
    const lost = new ResendClient(`re_${"x".repeat(24)}`, async () => {
      throw new Error("network failure details must not escape");
    });
    await expect(lost.send(payload, "ticketpilot/12345/v1")).resolves.toEqual({ kind: "unknown" });
  });
});
