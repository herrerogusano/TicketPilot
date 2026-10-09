import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HubSpotClient, type HubSpotTicketPipeline } from "../src/adapters/hubspot";

const seedCases = [
  {
    key: "premium-activation",
    subject: "[TP-DEMO] Premium plan activation question",
    content:
      "TP_SEED_HUBSPOT_PREMIUM_ACTIVATION_V1\nA fictional customer asks when premium features become available after an upgrade.",
  },
  {
    key: "duplicate-charge",
    subject: "[TP-DEMO] Question about a duplicate subscription charge",
    content:
      "TP_SEED_HUBSPOT_DUPLICATE_CHARGE_V1\nA fictional customer reports seeing two charges for one subscription period and asks how billing review works.",
  },
  {
    key: "csv-export",
    subject: "[TP-DEMO] CSV export stops before completion",
    content:
      "TP_SEED_HUBSPOT_CSV_EXPORT_V1\nA fictional customer says a CSV export stops before it finishes and asks what troubleshooting details are useful.",
  },
  {
    key: "password-reset",
    subject: "[TP-DEMO] Password reset link has expired",
    content:
      "TP_SEED_HUBSPOT_PASSWORD_RESET_V1\nA fictional customer cannot use an expired password-reset link and asks for the safe next step.",
  },
  {
    key: "unknown-unrelated",
    subject: "[TP-DEMO] Unrelated question about office parking",
    content:
      "TP_SEED_HUBSPOT_UNKNOWN_UNRELATED_V1\nA fictional customer asks whether the company validates parking at its office.",
  },
] as const;

type ManifestEntry = { status: "create_in_progress" | "created"; ticketId?: string };
type Manifest = { version: 1; cases: Record<string, ManifestEntry> };

const projectRoot = resolve(import.meta.dirname, "..");
const manifestPath = resolve(projectRoot, "seed-manifest-hubspot.json");

async function main(): Promise<void> {
  const apply = process.argv.includes("--apply");
  const token = configured("HUBSPOT_SERVICE_KEY");
  const cutoff = configured("DEMO_START_AT");
  if (process.env.TICKETPILOT_ENV !== "demo" || token === undefined || cutoff === undefined) {
    throw new Error("demo_configuration_required");
  }
  if (!Number.isFinite(Date.parse(cutoff))) throw new Error("valid_demo_cutoff_required");
  if (apply && Date.now() < Date.parse(cutoff)) throw new Error("demo_cutoff_not_reached");

  const client = new HubSpotClient(token);
  const manifest = await readManifest();
  const existing = await client.searchDemoTickets(cutoff);
  const located = new Map<string, string>();
  for (const seed of seedCases) {
    const marker = seedMarker(seed.content);
    const matchId = findUniqueSeedTicket(existing, marker);
    if (matchId !== undefined) located.set(seed.key, matchId);
  }

  const pipeline: HubSpotTicketPipeline | undefined = apply
    ? await client.getFirstActivePipeline(
        configured("HUBSPOT_PIPELINE_ID"),
        configured("HUBSPOT_PIPELINE_STAGE_ID"),
      )
    : undefined;

  for (const seed of seedCases) {
    const prior = manifest.cases[seed.key];
    let ticketId = prior?.ticketId;
    if (ticketId !== undefined) {
      const ticket = await client.getTicket(ticketId);
      const marker = seedMarker(seed.content);
      if (ticket?.content.includes(marker)) {
        await recordCreated(manifest, seed.key, ticketId);
        console.log(`${seed.key}: verified existing ticket`);
        continue;
      }
    }

    const recoveredId = located.get(seed.key);
    if (recoveredId !== undefined) {
      await recordCreated(manifest, seed.key, recoveredId);
      console.log(`${seed.key}: reconciled existing ticket`);
      continue;
    }

    if (prior !== undefined) {
      throw new Error(`manual_reconciliation_required:${seed.key}`);
    }
    if (!apply) {
      console.log(`${seed.key}: would create ${seed.subject}`);
      continue;
    }

    await recordInProgress(manifest, seed.key);
    try {
      ticketId = await client.createTicket({
        subject: seed.subject,
        content: seed.content,
        pipelineId: pipeline?.id ?? "",
        stageId: pipeline?.stageId ?? "",
      });
    } catch {
      throw new Error(`create_outcome_unknown_reconcile_before_retry:${seed.key}`);
    }
    const createdTicket = await client.getTicket(ticketId);
    if (
      createdTicket === null ||
      createdTicket.subject !== seed.subject ||
      !createdTicket.content.includes(seedMarker(seed.content)) ||
      Date.parse(createdTicket.createdAt) < Date.parse(cutoff)
    ) {
      throw new Error(`created_ticket_readback_failed:${seed.key}`);
    }
    await recordCreated(manifest, seed.key, ticketId);
    console.log(`${seed.key}: created and recorded ticket id`);
  }
}

async function readManifest(): Promise<Manifest> {
  try {
    const data: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isManifest(data)) throw new Error("invalid_seed_manifest");
    return data;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return { version: 1, cases: {} };
    throw error;
  }
}

async function recordInProgress(manifest: Manifest, key: string): Promise<void> {
  manifest.cases[key] = { status: "create_in_progress" };
  await persistManifest(manifest);
}

async function recordCreated(manifest: Manifest, key: string, ticketId: string): Promise<void> {
  manifest.cases[key] = { status: "created", ticketId };
  await persistManifest(manifest);
}

async function persistManifest(manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value === undefined || value === "" || /^replace-/i.test(value) ? undefined : value;
}

function seedMarker(content: string): string {
  const marker = content.split("\n", 1)[0];
  if (marker === undefined) throw new Error("seed_marker_missing");
  return marker;
}

export function findUniqueSeedTicket(
  tickets: readonly { id: string; content: string }[],
  marker: string,
): string | undefined {
  const matches = tickets.filter((ticket) => ticket.content.includes(marker));
  if (matches.length > 1) throw new Error("ambiguous_seed_marker_manual_reconciliation_required");
  return matches[0]?.id;
}

function isManifest(value: unknown): value is Manifest {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { version?: unknown; cases?: unknown };
  if (candidate.version !== 1 || typeof candidate.cases !== "object" || candidate.cases === null) {
    return false;
  }
  return Object.values(candidate.cases).every((entry) => {
    if (typeof entry !== "object" || entry === null) return false;
    const status = (entry as { status?: unknown }).status;
    const ticketId = (entry as { ticketId?: unknown }).ticketId;
    return (
      (status === "created" || status === "create_in_progress") &&
      (ticketId === undefined || (typeof ticketId === "string" && /^\d+$/.test(ticketId)))
    );
  });
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : "seed_failed";
    console.error(`HubSpot seed stopped safely: ${message}`);
    process.exitCode = 1;
  });
}

export { seedCases };
