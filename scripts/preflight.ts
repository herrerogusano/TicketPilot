import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  associatedHubSpotObjectIds,
  isVerifiedHubSpotMarkerNote,
  sameNotionPageId,
} from "./preflight-helpers";

type CheckStatus =
  | "pass"
  | "fail"
  | "not_configured"
  | "manual_check"
  | "not_run"
  | "not_supported_by_send_only_key";
type ApiResponse = Record<string, unknown> & {
  data?: unknown;
  errors?: unknown;
  has_more?: unknown;
  id?: unknown;
  next_cursor?: unknown;
  object?: unknown;
  ok?: unknown;
  properties?: unknown;
  result?: unknown;
  results?: unknown;
  success?: unknown;
  team_id?: unknown;
};
type ProviderReport = { status: CheckStatus; checks: Record<string, CheckStatus> };
type PreflightReport = {
  generatedAt: string;
  mode: "read_only" | "disposable_smoke_writes_enabled";
  overall: "pass" | "incomplete" | "blocked";
  providers: Record<string, ProviderReport>;
};
type SmokeManifest = {
  version: 1;
  hubspot?: { noteId?: string; status: "create_in_progress" | "verified" };
  notion?: { pageId?: string; status: "create_in_progress" | "verified" | "archived" };
};

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reportPath = resolve(projectRoot, "artifacts", "preflight-redacted.json");
const manifestPath = resolve(projectRoot, "artifacts", "preflight-smoke-manifest.json");
const resendEvidencePath =
  configured("RESEND_PRIOR_EVIDENCE_PATH") ??
  configured("PREFLIGHT_RESEND_EVIDENCE_PATH") ??
  resolve(projectRoot, "artifacts", "preflight-resend.json");
const smokeWritesEnabled = process.argv.includes("--smoke-writes");
const marker = "TP_PREFLIGHT_TICKETPILOT_PHASE0_V1";
const notionTitle = `TicketPilot disposable preflight ${marker}`;
const hubspotTicketId = configured("HUBSPOT_PREFLIGHT_TICKET_ID") ?? "436702952643";
const notionVersion = "2026-03-11";
const hubspotAssociationApiVersion = "2026-09";

function configured(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value && !/^replace-/i.test(value) ? value : undefined;
}

function provider(status: CheckStatus, checks: Record<string, CheckStatus>): ProviderReport {
  return { status, checks };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function requestJson(
  url: string,
  method: "GET" | "POST" | "PATCH",
  headers: HeadersInit,
  body?: unknown,
): Promise<{ status: number; body: ApiResponse | null }> {
  const requestHeaders = new Headers(headers);
  if (body !== undefined) requestHeaders.set("Content-Type", "application/json");
  const response = await fetch(url, {
    method,
    headers: requestHeaders,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
  const parsed: unknown = await response.json().catch(() => null);
  return {
    status: response.status,
    body: isRecord(parsed) ? (parsed as ApiResponse) : null,
  };
}

async function readManifest(): Promise<SmokeManifest> {
  try {
    const parsed: unknown = JSON.parse(await readFile(manifestPath, "utf8"));
    if (!isRecord(parsed) || parsed.version !== 1) throw new Error("invalid manifest");
    return parsed as SmokeManifest;
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { version: 1 };
    if (error instanceof Error && error.message === "invalid manifest") throw error;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return { version: 1 };
    throw new Error("Smoke manifest is unreadable; refusing to create disposable resources again.");
  }
}

async function writeManifest(manifest: SmokeManifest): Promise<void> {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function probeCloudflare(): Promise<ProviderReport> {
  const checks: Record<string, CheckStatus> = {
    wrangler_authentication: "not_configured",
    workers_ai_json_inference: "not_run",
    workers_d1_workflows_and_free_quotas: "manual_check",
  };
  const wranglerEntry = resolve(projectRoot, "node_modules", "wrangler", "bin", "wrangler.js");
  try {
    execFileSync(process.execPath, [wranglerEntry, "whoami"], {
      cwd: projectRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 12_000,
      windowsHide: true,
    });
    checks.wrangler_authentication = "pass";
  } catch {
    checks.wrangler_authentication = "not_configured";
  }

  const token = configured("CLOUDFLARE_API_TOKEN");
  const accountId = configured("CLOUDFLARE_ACCOUNT_ID") ?? "5e5f582388aee168349c2074d3ea9ee1";
  if (smokeWritesEnabled && token) {
    try {
      const result = await requestJson(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/@cf/meta/llama-3.3-70b-instruct-fp8-fast`,
        "POST",
        { Authorization: `Bearer ${token}` },
        {
          messages: [
            {
              role: "system",
              content: "Return only the JSON object required by the response schema.",
            },
            { role: "user", content: "Return { ok: true }." },
          ],
          max_tokens: 64,
          temperature: 0,
          response_format: {
            type: "json_schema",
            json_schema: {
              type: "object",
              properties: { ok: { type: "boolean" } },
              required: ["ok"],
              additionalProperties: false,
            },
          },
        },
      );
      const resultBody = result.body?.result;
      const candidate = isRecord(resultBody) ? resultBody.response : undefined;
      let decoded: unknown = candidate;
      if (typeof candidate === "string") decoded = JSON.parse(candidate);
      checks.workers_ai_json_inference =
        result.status === 200 &&
        result.body?.success === true &&
        isRecord(decoded) &&
        decoded.ok === true
          ? "pass"
          : "fail";
    } catch {
      checks.workers_ai_json_inference = "fail";
    }
  }

  if (
    configured("CLOUDFLARE_FREE_PLAN_CONFIRMED") === "true" &&
    configured("CLOUDFLARE_BUDGETS_CONFIRMED") === "true"
  ) {
    checks.workers_d1_workflows_and_free_quotas = "pass";
  }
  const status = Object.values(checks).every((check) => check === "pass")
    ? "pass"
    : Object.values(checks).includes("fail")
      ? "fail"
      : "manual_check";
  return provider(status, checks);
}

async function probeHubSpot(manifest: SmokeManifest): Promise<ProviderReport> {
  const token = configured("HUBSPOT_SERVICE_KEY");
  if (!token) {
    return provider("not_configured", {
      ticket_read: "not_configured",
      note_to_ticket_association_discovery: "not_configured",
      idempotent_note_create_and_association: smokeWritesEnabled ? "not_configured" : "not_run",
    });
  }
  const headers = { Authorization: `Bearer ${token}` };
  try {
    const ticket = await requestJson(
      `https://api.hubapi.com/crm/v3/objects/tickets/${encodeURIComponent(hubspotTicketId)}?properties=subject,createdate`,
      "GET",
      headers,
    );
    const ticketProperties = ticket.body?.properties;
    const subject = isRecord(ticketProperties) ? ticketProperties.subject : undefined;
    const ticketRead =
      ticket.status === 200 && typeof subject === "string" && subject.startsWith("[TP-DEMO]");
    const labels = await requestJson(
      `https://api.hubapi.com/crm/associations/${hubspotAssociationApiVersion}/notes/tickets/labels`,
      "GET",
      headers,
    );
    const associationTypes = Array.isArray(labels.body?.results) ? labels.body.results : [];
    const defaultAssociations = associationTypes.filter(
      (item) =>
        isRecord(item) &&
        item.category === "HUBSPOT_DEFINED" &&
        item.label === null &&
        typeof item.typeId === "number",
    );
    const defaultAssociation = defaultAssociations[0];
    const associationDiscovery =
      labels.status === 200 && defaultAssociations.length === 1 && isRecord(defaultAssociation);
    let noteStatus: CheckStatus = "not_run";
    if (smokeWritesEnabled && ticketRead && associationDiscovery && isRecord(defaultAssociation)) {
      noteStatus = await verifyOrCreateHubSpotNote(
        token,
        hubspotTicketId,
        defaultAssociation.typeId as number,
        manifest,
      );
    }
    const checks = {
      ticket_read: ticketRead ? "pass" : "fail",
      note_to_ticket_association_discovery: associationDiscovery ? "pass" : "fail",
      idempotent_note_create_and_association: noteStatus,
    } satisfies Record<string, CheckStatus>;
    const status = Object.values(checks).includes("fail")
      ? "fail"
      : Object.values(checks).every((check) => check === "pass")
        ? "pass"
        : "manual_check";
    return provider(status, checks);
  } catch {
    return provider("fail", {
      ticket_read: "fail",
      note_to_ticket_association_discovery: "fail",
      idempotent_note_create_and_association: "fail",
    });
  }
}

async function getHubSpotNote(
  token: string,
  noteId: string,
): Promise<{ status: number; body: ApiResponse | null }> {
  return requestJson(
    `https://api.hubapi.com/crm/v3/objects/notes/${encodeURIComponent(noteId)}?properties=hs_note_body&associations=tickets`,
    "GET",
    { Authorization: `Bearer ${token}` },
  );
}

async function findAssociatedHubSpotMarkerNote(
  token: string,
  ticketId: string,
): Promise<string | null> {
  const associations = await requestJson(
    `https://api.hubapi.com/crm/v4/objects/tickets/${encodeURIComponent(ticketId)}/associations/notes?limit=100`,
    "GET",
    { Authorization: `Bearer ${token}` },
  );
  const noteIds =
    associations.status === 200 ? associatedHubSpotObjectIds(associations.body) : null;
  if (!noteIds) throw new Error("HubSpot ticket-to-note association lookup failed");
  const paging = associations.body?.paging;
  if (isRecord(paging) && isRecord(paging.next)) {
    throw new Error("HubSpot ticket associations exceed the bounded reconciliation page");
  }

  const markerNoteIds: string[] = [];
  for (const noteId of noteIds) {
    const note = await getHubSpotNote(token, noteId);
    if (note.status !== 200) throw new Error("HubSpot associated note read failed");
    if (isVerifiedHubSpotMarkerNote(note.body, marker, ticketId)) {
      markerNoteIds.push(noteId);
    }
  }
  if (markerNoteIds.length > 1) throw new Error("Multiple associated HubSpot marker notes exist");
  return markerNoteIds[0] ?? null;
}

async function verifyHubSpotNoteById(
  token: string,
  noteId: string,
  ticketId: string,
): Promise<boolean> {
  const note = await getHubSpotNote(token, noteId);
  return note.status === 200 && isVerifiedHubSpotMarkerNote(note.body, marker, ticketId);
}

async function verifyOrCreateHubSpotNote(
  token: string,
  ticketId: string,
  associationTypeId: number,
  manifest: SmokeManifest,
): Promise<CheckStatus> {
  try {
    if (manifest.hubspot?.noteId) {
      const manifestNoteIsValid = await verifyHubSpotNoteById(
        token,
        manifest.hubspot.noteId,
        ticketId,
      );
      if (manifestNoteIsValid) {
        manifest.hubspot = { noteId: manifest.hubspot.noteId, status: "verified" };
        await writeManifest(manifest);
        return "pass";
      }
    }

    const existingNoteId = await findAssociatedHubSpotMarkerNote(token, ticketId);
    if (existingNoteId) {
      manifest.hubspot = { noteId: existingNoteId, status: "verified" };
      await writeManifest(manifest);
      return "pass";
    }
    if (manifest.hubspot?.noteId || manifest.hubspot?.status === "create_in_progress") {
      return "manual_check";
    }

    manifest.hubspot = { status: "create_in_progress" };
    await writeManifest(manifest);
    const create = await requestJson(
      "https://api.hubapi.com/crm/v3/objects/notes",
      "POST",
      { Authorization: `Bearer ${token}` },
      {
        properties: {
          hs_timestamp: new Date().toISOString(),
          hs_note_body: `Disposable TicketPilot preflight check ${marker}. Synthetic only.`,
        },
        associations: [
          {
            to: { id: ticketId },
            types: [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId }],
          },
        ],
      },
    );
    const noteId = typeof create.body?.id === "string" ? create.body.id : null;
    if (create.status < 200 || create.status >= 300 || !noteId) return "manual_check";
    manifest.hubspot = { noteId, status: "create_in_progress" };
    await writeManifest(manifest);
    if (!(await verifyHubSpotNoteById(token, noteId, ticketId))) return "manual_check";
    manifest.hubspot = { noteId, status: "verified" };
    await writeManifest(manifest);
    return "pass";
  } catch {
    return "manual_check";
  }
}

async function probeNotion(manifest: SmokeManifest): Promise<ProviderReport> {
  const token = configured("NOTION_TOKEN");
  const pageId = configured("NOTION_PARENT_PAGE_ID");
  if (!token || !pageId) {
    return provider("not_configured", {
      root_page_read: "not_configured",
      root_children_read: "not_configured",
      idempotent_disposable_child_create_read_archive: smokeWritesEnabled
        ? "not_configured"
        : "not_run",
    });
  }
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": notionVersion };
  try {
    const root = await requestJson(
      `https://api.notion.com/v1/pages/${encodeURIComponent(pageId)}`,
      "GET",
      headers,
    );
    const children = await requestJson(
      `https://api.notion.com/v1/blocks/${encodeURIComponent(pageId)}/children?page_size=100`,
      "GET",
      headers,
    );
    const rootRead = root.status === 200 && root.body?.object === "page";
    const childrenRead = children.status === 200 && Array.isArray(children.body?.results);
    let smokeStatus: CheckStatus = "not_run";
    if (smokeWritesEnabled && rootRead && childrenRead) {
      smokeStatus = await verifyOrCreateNotionChild(token, pageId, manifest);
    }
    const checks = {
      root_page_read: rootRead ? "pass" : "fail",
      root_children_read: childrenRead ? "pass" : "fail",
      idempotent_disposable_child_create_read_archive: smokeStatus,
    } satisfies Record<string, CheckStatus>;
    const status = Object.values(checks).includes("fail")
      ? "fail"
      : Object.values(checks).every((check) => check === "pass")
        ? "pass"
        : "manual_check";
    return provider(status, checks);
  } catch {
    return provider("fail", {
      root_page_read: "fail",
      root_children_read: "fail",
      idempotent_disposable_child_create_read_archive: "fail",
    });
  }
}

async function findNotionMarkerChild(token: string, parentId: string): Promise<string | null> {
  const result = await requestJson(
    `https://api.notion.com/v1/blocks/${encodeURIComponent(parentId)}/children?page_size=100`,
    "GET",
    { Authorization: `Bearer ${token}`, "Notion-Version": notionVersion },
  );
  if (result.status !== 200 || !Array.isArray(result.body?.results)) {
    throw new Error("Notion child lookup failed");
  }
  const children = result.body.results.filter((item) => {
    if (!isRecord(item) || item.type !== "child_page" || !isRecord(item.child_page)) return false;
    return item.child_page.title === notionTitle;
  });
  if (children.length > 1) throw new Error("More than one Notion preflight child marker exists");
  return isRecord(children[0]) && typeof children[0].id === "string" ? children[0].id : null;
}

function titleFromNotionPage(page: ApiResponse | null): string | null {
  const properties = page?.properties;
  if (!isRecord(properties)) return null;
  const titleProperty = properties.title ?? properties.Name;
  if (!isRecord(titleProperty) || !Array.isArray(titleProperty.title)) return null;
  const first = titleProperty.title.find(
    (item) => isRecord(item) && typeof item.plain_text === "string",
  );
  return isRecord(first) && typeof first.plain_text === "string" ? first.plain_text : null;
}

function isNotionPageUnderParent(
  page: ApiResponse | null,
  pageId: string,
  parentId: string,
): boolean {
  const pageParent = page?.parent;
  return (
    page?.object === "page" &&
    sameNotionPageId(page.id, pageId) &&
    titleFromNotionPage(page) === notionTitle &&
    isRecord(pageParent) &&
    sameNotionPageId(pageParent.page_id, parentId)
  );
}

async function verifyOrCreateNotionChild(
  token: string,
  parentId: string,
  manifest: SmokeManifest,
): Promise<CheckStatus> {
  const headers = { Authorization: `Bearer ${token}`, "Notion-Version": notionVersion };
  try {
    let childId = manifest.notion?.pageId;
    if (!childId) {
      childId = (await findNotionMarkerChild(token, parentId)) ?? undefined;
      if (childId) {
        manifest.notion = { pageId: childId, status: "create_in_progress" };
        await writeManifest(manifest);
      }
      if (!childId) {
        if (manifest.notion?.status === "create_in_progress") return "manual_check";
        manifest.notion = { status: "create_in_progress" };
        await writeManifest(manifest);
        const created = await requestJson("https://api.notion.com/v1/pages", "POST", headers, {
          parent: { type: "page_id", page_id: parentId },
          properties: {
            title: { title: [{ type: "text", text: { content: notionTitle } }] },
          },
        });
        childId = typeof created.body?.id === "string" ? created.body.id : undefined;
        if (created.status < 200 || created.status >= 300 || !childId) return "manual_check";
        manifest.notion = { pageId: childId, status: "create_in_progress" };
        await writeManifest(manifest);
      }
    }

    const page = await requestJson(
      `https://api.notion.com/v1/pages/${encodeURIComponent(childId)}`,
      "GET",
      headers,
    );
    if (page.status !== 200 || !isNotionPageUnderParent(page.body, childId, parentId)) {
      return "manual_check";
    }

    if (page.body?.in_trash === true) {
      manifest.notion = { pageId: childId, status: "archived" };
      await writeManifest(manifest);
      return "pass";
    }

    manifest.notion = { pageId: childId, status: "verified" };
    await writeManifest(manifest);
    const trashed = await requestJson(
      `https://api.notion.com/v1/pages/${encodeURIComponent(childId)}`,
      "PATCH",
      headers,
      { in_trash: true },
    );
    if (trashed.status < 200 || trashed.status >= 300 || trashed.body?.in_trash !== true) {
      return "manual_check";
    }

    const archivedReadback = await requestJson(
      `https://api.notion.com/v1/pages/${encodeURIComponent(childId)}`,
      "GET",
      headers,
    );
    if (
      archivedReadback.status !== 200 ||
      archivedReadback.body?.in_trash !== true ||
      !isNotionPageUnderParent(archivedReadback.body, childId, parentId)
    ) {
      return "manual_check";
    }
    manifest.notion = { pageId: childId, status: "archived" };
    await writeManifest(manifest);
    return "pass";
  } catch {
    return "manual_check";
  }
}

async function probeSlack(): Promise<ProviderReport> {
  const token = configured("SLACK_BOT_TOKEN");
  if (!token) {
    return provider("not_configured", {
      auth_test: "not_configured",
      configured_workspace: "not_configured",
      post_and_cleanup_message: smokeWritesEnabled ? "not_configured" : "not_run",
    });
  }
  try {
    const auth = await requestJson(
      "https://slack.com/api/auth.test",
      "POST",
      {
        Authorization: `Bearer ${token}`,
      },
      {},
    );
    const authOk = auth.status === 200 && auth.body?.ok === true;
    const teamId = configured("SLACK_TEAM_ID");
    const teamOk = authOk && (!teamId || auth.body?.team_id === teamId);
    let postStatus: CheckStatus = "not_run";
    if (smokeWritesEnabled && teamOk) {
      const channelId = configured("SLACK_CHANNEL_ID");
      postStatus = channelId ? await runSlackPostSmoke(token, channelId) : "not_configured";
    }
    const checks = {
      auth_test: authOk ? "pass" : "fail",
      configured_workspace: teamOk ? "pass" : "fail",
      post_and_cleanup_message: postStatus,
    } satisfies Record<string, CheckStatus>;
    const status = Object.values(checks).includes("fail")
      ? "fail"
      : Object.values(checks).every((check) => check === "pass")
        ? "pass"
        : "manual_check";
    return provider(status, checks);
  } catch {
    return provider("fail", {
      auth_test: "fail",
      configured_workspace: "fail",
      post_and_cleanup_message: "fail",
    });
  }
}

async function runSlackPostSmoke(token: string, channel: string): Promise<CheckStatus> {
  let timestamp: string | null = null;
  try {
    const post = await requestJson(
      "https://slack.com/api/chat.postMessage",
      "POST",
      { Authorization: `Bearer ${token}` },
      { channel, text: `TicketPilot disposable preflight check ${marker}.` },
    );
    timestamp = typeof post.body?.ts === "string" ? post.body.ts : null;
    if (post.status !== 200 || post.body?.ok !== true || !timestamp) return "manual_check";
  } catch {
    return "manual_check";
  }
  try {
    const deleted = await requestJson(
      "https://slack.com/api/chat.delete",
      "POST",
      { Authorization: `Bearer ${token}` },
      { channel, ts: timestamp },
    );
    return deleted.status === 200 && deleted.body?.ok === true ? "pass" : "fail";
  } catch {
    return "fail";
  }
}

const resendEvidenceSchema = z.object({
  success: z.literal(true),
  inbox_confirmed: z.literal(true),
});

async function probeResend(): Promise<ProviderReport> {
  if (!configured("RESEND_API_KEY")) {
    return provider("not_configured", {
      send_only_key_configured: "not_configured",
      idempotent_test_send: "not_configured",
      owner_inbox_confirmed: "not_configured",
      recipient_is_owner: "not_configured",
    });
  }
  try {
    const evidence = JSON.parse(await readFile(resendEvidencePath, "utf8")) as unknown;
    const validated = resendEvidenceSchema.safeParse(evidence);
    const hasRecipient = Boolean(configured("TEST_RECIPIENT_EMAIL"));
    const deliveryConfirmed = configured("RESEND_TEST_DELIVERY_CONFIRMED") === "true";
    const evidenceConfirmed = validated.success && deliveryConfirmed;
    const checks = {
      send_only_key_configured: "pass",
      send_only_key_read_probe: "not_supported_by_send_only_key",
      idempotent_test_send: evidenceConfirmed ? "pass" : "manual_check",
      owner_inbox_confirmed: evidenceConfirmed ? "pass" : "manual_check",
      recipient_is_owner: evidenceConfirmed && hasRecipient ? "pass" : "manual_check",
    } satisfies Record<string, CheckStatus>;
    const status = Object.values(checks).every(
      (check) => check === "pass" || check === "not_supported_by_send_only_key",
    )
      ? "pass"
      : "manual_check";
    return provider(status, checks);
  } catch {
    return provider("manual_check", {
      send_only_key_configured: "pass",
      send_only_key_read_probe: "not_supported_by_send_only_key",
      idempotent_test_send: "manual_check",
      owner_inbox_confirmed: "manual_check",
      recipient_is_owner: "manual_check",
    });
  }
}

async function main(): Promise<void> {
  const manifest = smokeWritesEnabled ? await readManifest() : { version: 1 as const };
  const providers = {
    cloudflare: await probeCloudflare(),
    hubspot: await probeHubSpot(manifest),
    notion: await probeNotion(manifest),
    slack: await probeSlack(),
    resend: await probeResend(),
  } satisfies PreflightReport["providers"];
  const statuses = Object.values(providers).map(({ status }) => status);
  const overall = statuses.every((status) => status === "pass")
    ? "pass"
    : statuses.includes("fail")
      ? "blocked"
      : "incomplete";
  const report: PreflightReport = {
    generatedAt: new Date().toISOString(),
    mode: smokeWritesEnabled ? "disposable_smoke_writes_enabled" : "read_only",
    overall,
    providers,
  };

  await mkdir(dirname(reportPath), { recursive: true });
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = overall === "pass" ? 0 : overall === "incomplete" ? 2 : 1;
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    `TicketPilot preflight
Usage: npm run preflight [-- --smoke-writes]
Default mode performs read-only provider checks.
--smoke-writes enables only the bounded, idempotent disposable checks documented by the project.
--help prints this message without reading credentials or contacting providers.
`,
  );
} else {
  await main();
}
