import { describe, expect, it } from "vitest";
import { HubSpotClient, HubSpotError } from "../src/adapters/hubspot";
import { NotionClient, NotionError, type NotionPageRef } from "../src/adapters/notion";
import { buildImmutableEmailPayload, ResendClient } from "../src/adapters/resend";
import type { StoredProposal } from "../src/domain/contracts";

const parentId = "3f3d34323f1a80b48e71c5860aeccc45";
const pageId = "81a11db788847711b1b89fd6bd612436";
const ref: NotionPageRef = {
  id: pageId,
  key: "billing-double-charge",
  title: "[TP-KB:billing-double-charge] Duplicate billing",
  url: "",
};

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

function validPage(overrides: Record<string, unknown> = {}): unknown {
  return {
    id: pageId,
    url: "https://www.notion.so/policy",
    parent: { page_id: parentId },
    properties: {
      title: { title: [{ plain_text: ref.title }] },
    },
    ...overrides,
  };
}

function notionClient(fetcher: typeof fetch): NotionClient {
  let now = 0;
  return new NotionClient(
    "test-token",
    fetcher,
    () => {
      now += 350;
      return now;
    },
    async () => undefined,
  );
}

describe("Phase 5 bounded provider edge cases", () => {
  it("fails closed for invalid HubSpot cutoff, ticket details, IDs, and absent records", async () => {
    const notFound = new HubSpotClient(
      "test-token",
      async () => new Response("missing", { status: 404 }),
    );
    await expect(notFound.searchDemoTickets("not-a-date")).rejects.toMatchObject({
      message: "invalid_cutoff",
    });
    await expect(notFound.getTicket("not-numeric")).rejects.toMatchObject({
      message: "invalid_ticket_id",
    });
    await expect(notFound.getTicket("123")).resolves.toBeNull();

    const invalidShape = new HubSpotClient("test-token", async () => Response.json({ id: "bad" }));
    await expect(invalidShape.getTicket("123")).rejects.toMatchObject({
      message: "invalid_ticket_response",
    });
    const incomplete = new HubSpotClient("test-token", async () =>
      Response.json({
        id: "123",
        createdAt: "2026-10-09T00:00:00Z",
        properties: { subject: "[TP-DEMO] Missing date", content: "body", createdate: "bad" },
      }),
    );
    await expect(incomplete.getTicket("123")).rejects.toMatchObject({
      message: "incomplete_ticket_response",
    });
  });

  it("rejects invalid HubSpot pipeline overrides and does not guess a note association type", async () => {
    const pipeline = new HubSpotClient("test-token", async () =>
      Response.json({
        results: [
          { id: "archived", archived: true, displayOrder: 0, stages: [] },
          {
            id: "active",
            displayOrder: 1,
            stages: [{ id: "archived-stage", archived: true, displayOrder: 0 }],
          },
        ],
      }),
    );
    await expect(pipeline.getFirstActivePipeline()).rejects.toMatchObject({
      message: "no_active_ticket_pipeline",
    });
    await expect(pipeline.getFirstActivePipeline("unknown")).rejects.toBeInstanceOf(HubSpotError);

    let calls = 0;
    const noAssociation = new HubSpotClient("test-token", async () => {
      calls += 1;
      return Response.json({
        results: [{ category: "USER_DEFINED", label: "General", typeId: 500 }],
      });
    });
    await expect(noAssociation.createNote("123", "safe marker")).rejects.toMatchObject({
      message: "note_association_type_unavailable",
    });
    expect(calls).toBe(1);

    const malformedAssociation = new HubSpotClient("test-token", async () => Response.json({}));
    await expect(malformedAssociation.createNote("123", "safe marker")).rejects.toMatchObject({
      message: "note_association_type_unavailable",
    });
  });

  it("bounds HubSpot response bytes and returns no associated note when associations are absent", async () => {
    const oversized = new HubSpotClient(
      "test-token",
      async () => new Response("{}", { headers: { "Content-Length": "600000" } }),
    );
    await expect(oversized.searchDemoTickets("2026-10-09T00:00:00Z")).rejects.toMatchObject({
      message: "response_too_large",
    });

    const noAssociations = new HubSpotClient("test-token", async () => Response.json({}));
    await expect(noAssociations.findAssociatedNote("123", "marker")).resolves.toBeNull();
    await expect(noAssociations.verifyAssociatedNote("123", "456", "marker")).resolves.toBe(false);
  });

  it("fails closed on malformed Notion child results and missing pagination cursors", async () => {
    const invalid = notionClient(async () => Response.json({ results: "not-an-array" }));
    await expect(invalid.listChildPages(parentId)).rejects.toMatchObject({
      code: "invalid_children_response",
    });

    const missingCursor = notionClient(async () =>
      Response.json({ results: [], has_more: true, next_cursor: null }),
    );
    await expect(missingCursor.listChildPages(parentId)).rejects.toMatchObject({
      code: "missing_pagination_cursor",
    });

    const ignoredResults = notionClient(async () =>
      Response.json({
        results: [
          { id: "ordinary-block", type: "paragraph", paragraph: {} },
          { id: "unknown-page", type: "child_page", child_page: { title: "Unmanaged" } },
        ],
        has_more: false,
      }),
    );
    await expect(ignoredResults.listChildPages(parentId)).resolves.toEqual([]);
    expect(() => new NotionClient("x").listChildPages("invalid-id")).toBeDefined();
  });

  it("validates Notion titles, keys, cursors, and extracts text-content fallbacks", async () => {
    const missingTitle = notionClient(async () => Response.json(validPage({ properties: {} })));
    await expect(missingTitle.retrievePolicy(ref, parentId)).rejects.toMatchObject({
      code: "policy_page_title_missing",
    });

    const wrongTitle = notionClient(async (input) =>
      String(input).includes("/pages/")
        ? Response.json(
            validPage({
              properties: {
                title: { title: [{ text: { content: "[TP-KB:password-reset] Reset" } }] },
              },
            }),
          )
        : Response.json({ results: [], has_more: false }),
    );
    await expect(wrongTitle.retrievePolicy(ref, parentId)).rejects.toMatchObject({
      code: "policy_key_mismatch",
    });

    let calls = 0;
    const noBlockCursor = notionClient(async (input) => {
      if (String(input).includes("/pages/")) return Response.json(validPage());
      calls += 1;
      return Response.json({ results: [], has_more: true, next_cursor: null });
    });
    await expect(noBlockCursor.retrievePolicy(ref, parentId)).rejects.toMatchObject({
      code: "missing_policy_block_cursor",
    });
    expect(calls).toBe(1);

    const textFallback = notionClient(async (input) =>
      String(input).includes("/pages/")
        ? Response.json(validPage())
        : Response.json({
            results: [
              { id: "heading", type: "heading_2", heading_2: { rich_text: [] } },
              {
                id: "paragraph",
                type: "paragraph",
                paragraph: { rich_text: [{ text: { content: "Policy text fallback" } }] },
              },
            ],
            has_more: false,
          }),
    );
    await expect(textFallback.retrievePolicy(ref, parentId)).resolves.toMatchObject({
      content: "Policy text fallback",
    });
  });

  it("fails safely on Notion provider errors, empty bodies, malformed JSON, and streamed overflow", async () => {
    const notFound = notionClient(async () => new Response("private", { status: 429 }));
    await expect(notFound.listChildPages(parentId)).rejects.toMatchObject({
      code: "notion_request_failed",
      status: 429,
    });

    const emptyBody = notionClient(async () => new Response(null));
    await expect(emptyBody.listChildPages(parentId)).rejects.toMatchObject({
      code: "notion_invalid_json",
    });

    const invalidJson = notionClient(async () => new Response("{"));
    await expect(invalidJson.listChildPages(parentId)).rejects.toBeInstanceOf(NotionError);

    const oversized = notionClient(
      async () => new Response(new Uint8Array(256 * 1024 + 1).fill(0x20)),
    );
    await expect(oversized.listChildPages(parentId)).rejects.toMatchObject({
      code: "notion_response_too_large",
    });
  });

  it("classifies Resend retry headers, unrecognized errors, and response-size failures", async () => {
    const payload = buildImmutableEmailPayload("123", proposal, "owner@example.test");
    const send = (fetcher: typeof fetch) =>
      new ResendClient("re_test", fetcher).send(payload, "ticketpilot/123/v1");

    await expect(send(async () => new Response("limited", { status: 429 }))).resolves.toEqual({
      kind: "rate_limited",
      retryAfterMs: null,
    });
    await expect(
      send(
        async () =>
          new Response("limited", { status: 429, headers: { "Retry-After": "not-a-date" } }),
      ),
    ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: null });
    await expect(
      send(async () => new Response("limited", { status: 429, headers: { "Retry-After": "0" } })),
    ).resolves.toEqual({ kind: "rate_limited", retryAfterMs: 100 });
    const futureDate = new Date(Date.now() + 2_000).toUTCString();
    const dateResult = await send(
      async () => new Response("limited", { status: 429, headers: { "Retry-After": futureDate } }),
    );
    expect(dateResult.kind).toBe("rate_limited");
    if (dateResult.kind === "rate_limited") expect(dateResult.retryAfterMs).toBeGreaterThan(100);

    await expect(send(async () => new Response("opaque", { status: 418 }))).resolves.toEqual({
      kind: "unknown",
    });
    await expect(
      send(async () => new Response("{}", { headers: { "Content-Length": String(70 * 1024) } })),
    ).resolves.toEqual({ kind: "unknown" });
    await expect(send(async () => new Response(new Uint8Array(64 * 1024 + 1)))).resolves.toEqual({
      kind: "unknown",
    });
  });
});
