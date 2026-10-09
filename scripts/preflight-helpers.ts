function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeNotionPageId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.replaceAll("-", "").toLowerCase();
  return /^[a-f0-9]{32}$/.test(normalized) ? normalized : null;
}

export function sameNotionPageId(left: unknown, right: unknown): boolean {
  const normalizedLeft = normalizeNotionPageId(left);
  const normalizedRight = normalizeNotionPageId(right);
  return normalizedLeft !== null && normalizedLeft === normalizedRight;
}

export function isVerifiedHubSpotMarkerNote(
  note: unknown,
  marker: string,
  ticketId: string,
): boolean {
  if (!isRecord(note) || !isRecord(note.properties)) return false;
  const body = note.properties.hs_note_body;
  const associations = note.associations;
  const tickets = isRecord(associations) ? associations.tickets : undefined;
  const results = isRecord(tickets) ? tickets.results : undefined;
  return (
    typeof body === "string" &&
    body.includes(marker) &&
    Array.isArray(results) &&
    results.some((item) => isRecord(item) && String(item.id) === ticketId)
  );
}

export function associatedHubSpotObjectIds(response: unknown): string[] | null {
  if (!isRecord(response) || !Array.isArray(response.results)) return null;
  const ids: string[] = [];
  for (const result of response.results) {
    if (!isRecord(result) || (typeof result.id !== "string" && typeof result.id !== "number")) {
      return null;
    }
    ids.push(String(result.id));
  }
  return ids;
}
