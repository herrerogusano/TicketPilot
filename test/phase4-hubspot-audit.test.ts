import { describe, expect, it } from "vitest";
import { HubSpotClient } from "../src/adapters/hubspot";

const marker = `[TICKETPILOT-AUDIT:12345:${"a".repeat(64)}]`;

describe("Phase 4 HubSpot audit verification", () => {
  it("verifies the persisted candidate note by direct read, exact marker, and ticket association", async () => {
    let requested = "";
    const client = new HubSpotClient("test-token", async (input) => {
      requested = String(input);
      return Response.json({
        id: "67890",
        properties: { hs_note_body: `Audit record ${marker}` },
        associations: { tickets: { results: [{ id: "12345" }] } },
      });
    });
    await expect(client.verifyAssociatedNote("12345", "67890", marker)).resolves.toBe(true);
    expect(requested).toContain(
      "/crm/v3/objects/notes/67890?properties=hs_note_body&associations=tickets",
    );
  });

  it("rejects wrong marker, wrong ticket association, or a mismatched note ID", async () => {
    const wrongAssociation = new HubSpotClient("test-token", async () =>
      Response.json({
        id: "67890",
        properties: { hs_note_body: marker },
        associations: { tickets: { results: [{ id: "54321" }] } },
      }),
    );
    await expect(wrongAssociation.verifyAssociatedNote("12345", "67890", marker)).resolves.toBe(
      false,
    );
    const wrongMarker = new HubSpotClient("test-token", async () =>
      Response.json({
        id: "67890",
        properties: { hs_note_body: "different audit marker" },
        associations: { tickets: { results: [{ id: "12345" }] } },
      }),
    );
    await expect(wrongMarker.verifyAssociatedNote("12345", "67890", marker)).resolves.toBe(false);
    const wrongId = new HubSpotClient("test-token", async () =>
      Response.json({
        id: "11111",
        properties: { hs_note_body: marker },
        associations: { tickets: { results: [{ id: "12345" }] } },
      }),
    );
    await expect(wrongId.verifyAssociatedNote("12345", "67890", marker)).resolves.toBe(false);
  });

  it("fails closed when multiple associated notes match the same audit marker", async () => {
    const client = new HubSpotClient("test-token", async (input) => {
      const url = String(input);
      if (url.endsWith("/crm/v3/objects/tickets/12345?associations=notes")) {
        return Response.json({
          associations: { notes: { results: [{ id: "67890" }, { id: "67891" }] } },
        });
      }
      const id = url.includes("67890") ? "67890" : "67891";
      return Response.json({
        id,
        properties: { hs_note_body: `duplicate ${marker}` },
        associations: { tickets: { results: [{ id: "12345" }] } },
      });
    });
    await expect(client.findAssociatedNote("12345", marker)).rejects.toThrow(
      "duplicate_audit_marker_matches",
    );
  });
});
