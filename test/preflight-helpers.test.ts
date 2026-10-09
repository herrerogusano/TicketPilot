import { describe, expect, it } from "vitest";
import {
  associatedHubSpotObjectIds,
  isVerifiedHubSpotMarkerNote,
  normalizeNotionPageId,
  sameNotionPageId,
} from "../scripts/preflight-helpers";

describe("preflight provider verification helpers", () => {
  it("compares Notion page IDs regardless of UUID hyphenation or case", () => {
    expect(normalizeNotionPageId("3f4d3432-3f1a-817b-9e0d-c8af55e0984e")).toBe(
      "3f4d34323f1a817b9e0dc8af55e0984e",
    );
    expect(
      sameNotionPageId("3f3d34323f1a80b48e71c5860aeccc45", "3f3d3432-3f1a-80b4-8e71-c5860aeccc45"),
    ).toBe(true);
    expect(normalizeNotionPageId("not-a-page-id")).toBeNull();
  });

  it("verifies a HubSpot note only when its marker and ticket association match", () => {
    const note = {
      properties: { hs_note_body: "Disposable test TP_PREFLIGHT_TICKETPILOT_PHASE0_V1." },
      associations: { tickets: { results: [{ id: "436702952643" }] } },
    };
    expect(
      isVerifiedHubSpotMarkerNote(note, "TP_PREFLIGHT_TICKETPILOT_PHASE0_V1", "436702952643"),
    ).toBe(true);
    expect(isVerifiedHubSpotMarkerNote(note, "missing-marker", "436702952643")).toBe(false);
    expect(
      isVerifiedHubSpotMarkerNote(note, "TP_PREFLIGHT_TICKETPILOT_PHASE0_V1", "other-ticket"),
    ).toBe(false);
    expect(associatedHubSpotObjectIds({ results: [{ id: 123 }, { id: "456" }] })).toEqual([
      "123",
      "456",
    ]);
    expect(associatedHubSpotObjectIds({ results: [{ no_id: true }] })).toBeNull();
  });
});
