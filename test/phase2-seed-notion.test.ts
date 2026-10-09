import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { policySeeds, seedNotion } from "../scripts/seed-notion";
import { NotionClient } from "../src/adapters/notion";

const parentId = "3f3d34323f1a80b48e71c5860aeccc45";
type SeededPage = { id: string; title: string; url: string; children: Record<string, unknown>[] };

function fakeNotion(): {
  client: NotionClient;
  pages: Map<string, SeededPage>;
  createCount: () => number;
} {
  const pages = new Map<string, SeededPage>();
  let creates = 0;
  let pageNumber = 0;
  let now = 1_000;
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === `/v1/blocks/${parentId}/children`) {
      return Response.json({
        results: [...pages.values()].map((page) => ({
          id: page.id,
          type: "child_page",
          child_page: { title: page.title },
        })),
        has_more: false,
        next_cursor: null,
      });
    }
    if (path === "/v1/pages" && init?.method === "POST") {
      creates += 1;
      pageNumber += 1;
      const requestBody = record(JSON.parse(String(init.body)) as unknown);
      const properties = record(requestBody.properties);
      const titleProperty = record(properties.title);
      const titleRichText = array(titleProperty.title);
      const titleItem = record(titleRichText[0]);
      const titleText = record(titleItem.text);
      const title = string(titleText.content);
      const createdChildren = array(requestBody.children).map((block) => record(block));
      const id = `00000000-0000-4000-8000-${String(pageNumber).padStart(12, "0")}`;
      const page: SeededPage = {
        id,
        title,
        url: `https://www.notion.so/${id}`,
        children: createdChildren,
      };
      pages.set(id, page);
      return Response.json({
        id,
        url: page.url,
        in_trash: false,
        parent: { type: "page_id", page_id: parentId },
        properties: { title: { title: [{ type: "text", plain_text: title }] } },
      });
    }
    const pageMatch = /^\/v1\/pages\/([^/]+)$/.exec(path);
    if (pageMatch !== null) {
      const page = pages.get(pageMatch[1] ?? "");
      if (page === undefined) return Response.json({ error: "not_found" }, { status: 404 });
      return Response.json({
        id: page.id,
        url: page.url,
        in_trash: false,
        parent: { type: "page_id", page_id: parentId },
        properties: { title: { title: [{ type: "text", plain_text: page.title }] } },
      });
    }
    const blocksMatch = /^\/v1\/blocks\/([^/]+)\/children$/.exec(path);
    if (blocksMatch !== null) {
      const page = pages.get(blocksMatch[1] ?? "");
      if (page === undefined) return Response.json({ error: "not_found" }, { status: 404 });
      const results = page.children.map((block, index) => {
        const type = string(block.type);
        return { id: `block-${index}`, type, [type]: record(block[type]) };
      });
      return Response.json({ results, has_more: false, next_cursor: null });
    }
    return Response.json({ error: "unexpected_request" }, { status: 500 });
  };
  const client = new NotionClient(
    "fake-test-token",
    fetcher,
    () => now,
    async (ms) => {
      now += ms;
    },
  );
  return { client, pages, createCount: () => creates };
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function string(value: unknown): string {
  return typeof value === "string" ? value : "";
}

describe("Phase 2 Notion policy seed safety", () => {
  it("creates five fictitious pages once, then verifies without duplicate writes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketpilot-notion-"));
    const manifestPath = join(directory, "seed-manifest-notion.json");
    const fake = fakeNotion();
    try {
      const first = await seedNotion(fake.client, parentId, true, manifestPath);
      expect(first).toEqual({ verified: 5, wouldCreate: 5 });
      expect(fake.createCount()).toBe(5);
      expect(fake.pages.size).toBe(5);
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
        pages: Record<string, { status: string; pageId?: string }>;
      };
      expect(
        Object.values(manifest.pages).every((page) => page.status === "verified" && page.pageId),
      ).toBe(true);
      const second = await seedNotion(fake.client, parentId, false, manifestPath);
      expect(second).toEqual({ verified: 5, wouldCreate: 0 });
      expect(fake.createCount()).toBe(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(policySeeds).toHaveLength(5);
  });

  it("fails closed rather than overwriting a page changed after its seed", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ticketpilot-notion-edit-"));
    const manifestPath = join(directory, "seed-manifest-notion.json");
    const fake = fakeNotion();
    try {
      await seedNotion(fake.client, parentId, true, manifestPath);
      const first = fake.pages.values().next().value as SeededPage | undefined;
      if (first === undefined) throw new Error("missing_fixture_page");
      first.children[1] = {
        ...first.children[1],
        paragraph: { rich_text: [{ type: "text", text: { content: "Owner-edited policy text" } }] },
      };
      await expect(seedNotion(fake.client, parentId, true, manifestPath)).rejects.toThrow(
        "existing_policy_content_differs_no_overwrite",
      );
      expect(fake.createCount()).toBe(5);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
