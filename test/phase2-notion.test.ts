import { describe, expect, it, vi } from "vitest";
import {
  NOTION_VERSION,
  NotionClient,
  NotionError,
  type NotionPageRef,
  normalizeNotionId,
} from "../src/adapters/notion";

const parentId = "3f3d34323f1a80b48e71c5860aeccc45";
const pageId = "81a11db788847711b1b89fd6bd612436";

function page(inTrash = false): unknown {
  return {
    id: pageId,
    url: "https://www.notion.so/ticketpilot-policy",
    in_trash: inTrash,
    parent: { type: "page_id", page_id: "3f3d3432-3f1a-80b4-8e71-c5860aeccc45" },
    properties: {
      title: {
        type: "title",
        title: [{ type: "text", plain_text: "[TP-KB:billing-double-charge] Duplicate billing" }],
      },
    },
  };
}

function blockResponse(text: string): unknown {
  return {
    results: [
      {
        id: "block-1",
        type: "paragraph",
        paragraph: { rich_text: [{ type: "text", plain_text: text }] },
      },
    ],
    has_more: false,
    next_cursor: null,
  };
}

describe("Phase 2 Notion adapter", () => {
  it("normalizes UUIDs and validates direct, active child pages using current version headers", async () => {
    expect(normalizeNotionId("3f3d3432-3f1a-80b4-8e71-c5860aeccc45")).toBe(parentId);
    const calls: Array<{ url: string; headers: Headers }> = [];
    const times: number[] = [];
    let now = 0;
    const client = new NotionClient(
      "not-a-real-token",
      async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return String(input).includes("/pages/")
          ? Response.json(page())
          : Response.json(blockResponse("Fictional duplicate billing policy."));
      },
      () => now,
      async (ms) => {
        times.push(ms);
        now += ms;
      },
    );
    const ref: NotionPageRef = {
      id: pageId,
      key: "billing-double-charge",
      title: "[TP-KB:billing-double-charge] Duplicate billing",
      url: "",
    };
    const result = await client.retrievePolicy(ref, parentId);
    expect(result.key).toBe("billing-double-charge");
    expect(result.content).toContain("Fictional duplicate billing policy.");
    expect(result.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(calls[0]?.headers.get("Notion-Version")).toBe(NOTION_VERSION);
    expect(times).toEqual([350]);
  });

  it("fails closed on trashed or non-child pages", async () => {
    const trashed = new NotionClient("x", async () => Response.json(page(true)));
    await expect(
      trashed.retrievePolicy(
        {
          id: pageId,
          key: "billing-double-charge",
          title: "[TP-KB:billing-double-charge] Duplicate billing",
          url: "",
        },
        parentId,
      ),
    ).rejects.toBeInstanceOf(NotionError);
    const wrongParent = new NotionClient("x", async (input) =>
      String(input).includes("/pages/")
        ? Response.json({
            ...(page() as Record<string, unknown>),
            parent: { type: "page_id", page_id: "00000000000000000000000000000000" },
          })
        : Response.json(blockResponse("should not read")),
    );
    await expect(
      wrongParent.retrievePolicy(
        {
          id: pageId,
          key: "billing-double-charge",
          title: "[TP-KB:billing-double-charge] Duplicate billing",
          url: "",
        },
        parentId,
      ),
    ).rejects.toBeInstanceOf(NotionError);
  });

  it("uses bounded cursor pagination for root child-page listings", async () => {
    let calls = 0;
    const client = new NotionClient(
      "x",
      async () => {
        calls += 1;
        return Response.json(
          calls === 1
            ? { results: [], has_more: true, next_cursor: "next" }
            : {
                results: [
                  {
                    id: pageId,
                    type: "child_page",
                    child_page: { title: "[TP-KB:billing-double-charge] Duplicate billing" },
                  },
                ],
                has_more: false,
                next_cursor: null,
              },
        );
      },
      () => calls * 350,
      async () => undefined,
    );
    const refs = await client.listChildPages(parentId);
    expect(calls).toBe(2);
    expect(refs.map((ref) => ref.key)).toEqual(["billing-double-charge"]);
  });

  it("paginates policy blocks but fails closed above the fifty-block ceiling", async () => {
    let blockCalls = 0;
    const blocks = (start: number) =>
      Array.from({ length: 25 }, (_, index) => ({
        id: `block-${start + index}`,
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", plain_text: `Policy clause ${start + index}` }],
        },
      }));
    const client = new NotionClient(
      "x",
      async (input) => {
        const url = String(input);
        if (url.includes("/pages/")) return Response.json(page());
        blockCalls += 1;
        return Response.json({
          results: blocks((blockCalls - 1) * 25),
          has_more: blockCalls === 1,
          next_cursor: blockCalls === 1 ? "next-page" : null,
        });
      },
      () => 1_000,
      async () => undefined,
    );
    const result = await client.retrievePolicy(
      {
        id: pageId,
        key: "billing-double-charge",
        title: "[TP-KB:billing-double-charge] Duplicate billing",
        url: "",
      },
      parentId,
    );
    expect(blockCalls).toBe(2);
    expect(result.content).toContain("Policy clause 49");

    let overflowCalls = 0;
    const overflow = new NotionClient(
      "x",
      async (input) => {
        if (String(input).includes("/pages/")) return Response.json(page());
        overflowCalls += 1;
        return Response.json({
          results: blocks((overflowCalls - 1) * 25),
          has_more: true,
          next_cursor: "next",
        });
      },
      () => 1_000,
      async () => undefined,
    );
    await expect(
      overflow.retrievePolicy(
        {
          id: pageId,
          key: "billing-double-charge",
          title: "[TP-KB:billing-double-charge] Duplicate billing",
          url: "",
        },
        parentId,
      ),
    ).rejects.toMatchObject({ code: "policy_block_limit" });
    expect(overflowCalls).toBe(2);
  });

  it("uses receiver-safe global fetch when no test fetcher is injected", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      expect(String(input)).toContain("api.notion.com/v1/blocks/");
      return Response.json({ results: [], has_more: false });
    });
    vi.stubGlobal("fetch", fetcher);
    try {
      await new NotionClient("x").listChildPages(parentId);
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses the shared rate-gate hook for every Notion request", async () => {
    let slots = 0;
    const client = new NotionClient(
      "x",
      async (input) =>
        String(input).includes("/pages/")
          ? Response.json(page())
          : Response.json(blockResponse("Fictional duplicate billing policy.")),
      () => 0,
      async () => {
        throw new Error("local pacing should be disabled with a shared gate");
      },
      async () => {
        slots += 1;
      },
    );
    await client.retrievePolicy(
      {
        id: pageId,
        key: "billing-double-charge",
        title: "[TP-KB:billing-double-charge] Duplicate billing",
        url: "",
      },
      parentId,
    );
    expect(slots).toBe(2);
  });
});
