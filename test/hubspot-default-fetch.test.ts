import { afterEach, expect, it, vi } from "vitest";
import { HubSpotClient } from "../src/adapters/hubspot";

afterEach(() => vi.unstubAllGlobals());

it("calls the default global fetch with its runtime receiver, not the adapter instance", async () => {
  let requests = 0;
  vi.stubGlobal("fetch", async function (this: unknown) {
    if (this !== globalThis) throw new TypeError("Illegal invocation");
    requests += 1;
    return Response.json({ results: [] });
  });
  await expect(
    new HubSpotClient("test-token").searchDemoTickets("2026-10-09T00:09:06Z"),
  ).resolves.toEqual([]);
  expect(requests).toBe(1);
});
