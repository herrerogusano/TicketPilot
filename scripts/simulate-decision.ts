import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { SLACK_ACTION_IDS } from "../src/adapters/slack";
import {
  configured,
  projectRoot,
  readDemoLedger,
  requireDemo,
  seedIds,
  workerUrl,
} from "./live-inspection";

function argument(name: string): string | undefined {
  const at = process.argv.indexOf(name);
  return at < 0 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  requireDemo();
  const id = z
    .string()
    .regex(/^\d{1,20}$/)
    .parse(argument("--ticket"));
  const decision = z.enum(["APPROVE", "REJECT"]).parse(argument("--decision"));
  const repeat = Number(argument("--repeat") ?? "1");
  if (![1, 2].includes(repeat)) throw new Error("repeat_max_two");
  if (decision === "APPROVE" && !process.argv.includes("--allow-demo-email")) {
    throw new Error("explicit_demo_email_flag_required");
  }
  const ids = await seedIds();
  if (!Object.values(ids).includes(id)) throw new Error("known_synthetic_seed_required");
  const row = readDemoLedger([id])[0];
  if (
    !row ||
    row.state !== "AWAITING_APPROVAL" ||
    row.evidence_status !== "SUPPORTED" ||
    row.slack_post_status !== "POSTED" ||
    row.slack_post_attempts !== 1 ||
    row.decision !== null ||
    row.resend_attempts !== 0
  ) {
    throw new Error("fresh_supported_posted_proposal_required");
  }
  const target = z
    .object({
      ticket_id: z.string(),
      proposal_hash: z.string().regex(/^[a-f0-9]{64}$/),
      proposal_revision: z.number().int().positive().max(10_000),
    })
    .parse({
      ticket_id: id,
      proposal_hash: row.proposal_hash,
      proposal_revision: row.proposal_revision,
    });
  const messageTs = z
    .string()
    .regex(/^\d{1,20}\.\d{1,10}$/)
    .parse(row.slack_message_ts);
  const payload = {
    type: "block_actions",
    team: { id: configured("SLACK_TEAM_ID") },
    user: { id: configured("SLACK_APPROVER_USER_ID") },
    channel: { id: configured("SLACK_CHANNEL_ID") },
    message: { ts: messageTs },
    actions: [
      {
        action_id: decision === "APPROVE" ? SLACK_ACTION_IDS.approve : SLACK_ACTION_IDS.reject,
        value: JSON.stringify(target),
      },
    ],
  };
  const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
  const secret = configured("SLACK_SIGNING_SECRET");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const path = resolve(projectRoot, `artifacts/simulation-${id}.json`);
  const report = {
    ticket_id: id,
    decision,
    source: "SIGNED_SLACK_SIMULATOR",
    human_click: false,
    inbox_confirmed: false,
    requested_callbacks: repeat,
    created_at: new Date().toISOString(),
    outcome: "DISPATCH_RESERVED",
    statuses: [] as number[],
    round_trip_ms: [] as number[],
  };
  // Never silently repeat an uncertain simulator run. A first-wins server remains authoritative.
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  try {
    for (let count = 0; count < repeat; count += 1) {
      const timestamp = String(Math.floor(Date.now() / 1_000));
      const bytes = await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`v0:${timestamp}:${body}`),
      );
      const signature = `v0=${Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const started = Date.now();
      const response = await fetch(`${workerUrl}/slack/actions`, {
        method: "POST",
        body,
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          "X-Slack-Request-Timestamp": timestamp,
          "X-Slack-Signature": signature,
        },
        signal: AbortSignal.timeout(8_000),
      });
      report.round_trip_ms.push(Date.now() - started);
      report.statuses.push(response.status);
      if (response.status !== 200) throw new Error("simulated_action_not_acknowledged");
    }
    report.outcome = "ACKNOWLEDGED_NOT_PROVIDER_OR_INBOX_PROOF";
  } catch {
    report.outcome = "OUTCOME_UNKNOWN_OR_REJECTED_NO_AUTOMATIC_RETRY";
    throw new Error("simulator_failed");
  } finally {
    await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
    console.log(JSON.stringify(report));
  }
}

main().catch(() => {
  console.error("simulator_failed_no_sensitive_details_logged");
  process.exitCode = 1;
});
