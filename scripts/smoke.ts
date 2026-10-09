import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { HubSpotClient } from "../src/adapters/hubspot";
import { NotionClient } from "../src/adapters/notion";
import {
  assertHealth,
  configured,
  projectRoot,
  readDemoLedger,
  readJson,
  requireDemo,
  seedIds,
  workerUrl,
} from "./live-inspection";

async function main(): Promise<void> {
  requireDemo();
  assertHealth(await readJson(`${workerUrl}/health`));
  const unsigned = await fetch(`${workerUrl}/slack/actions`, {
    method: "POST",
    body: "payload={}",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    signal: AbortSignal.timeout(8_000),
  });
  if (unsigned.status !== 401) throw new Error("unsigned_action_not_rejected");
  const ids = await seedIds();
  const hubspot = new HubSpotClient(configured("HUBSPOT_SERVICE_KEY"));
  const eligible = await hubspot.searchDemoTickets(configured("DEMO_START_AT"));
  if (!Object.values(ids).every((id) => eligible.some((ticket) => ticket.id === id))) {
    throw new Error("seed_eligibility_not_verified");
  }
  const notion = new NotionClient(configured("NOTION_TOKEN"));
  const pages = await notion.listChildPages(configured("NOTION_PARENT_PAGE_ID"));
  if (pages.length !== 5 || new Set(pages.map((page) => page.key)).size !== 5) {
    throw new Error("five_unique_policies_required");
  }
  const ledger = readDemoLedger(Object.values(ids));
  if (ledger.length !== 5) throw new Error("seed_ledger_incomplete");
  const report = {
    generated_at: new Date().toISOString(),
    evidence_label: "LIVE_PROVIDER",
    mode: "read_only_no_ai_no_email_no_slack_post",
    health: "passed",
    unsigned_action_status: unsigned.status,
    eligible_seeds: 5,
    policy_pages: 5,
    ledger,
    human_click_verified: false,
    inbox_verified: false,
  };
  await writeFile(
    resolve(projectRoot, "artifacts/smoke-redacted.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  console.log(
    JSON.stringify({
      health: "passed",
      unsigned_action_status: 401,
      eligible_seeds: 5,
      policy_pages: 5,
      ledger_rows: ledger.length,
      evidence_label: "LIVE_PROVIDER",
    }),
  );
}

main().catch(() => {
  console.error("smoke_failed_no_sensitive_details_logged");
  process.exitCode = 1;
});
