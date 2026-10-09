import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { configured, projectRoot, requireDemo } from "./live-inspection";

async function main(): Promise<void> {
  requireDemo();
  const protectedValues = [
    "HUBSPOT_SERVICE_KEY",
    "NOTION_TOKEN",
    "SLACK_BOT_TOKEN",
    "SLACK_SIGNING_SECRET",
    "RESEND_API_KEY",
    "TEST_RECIPIENT_EMAIL",
  ].map(configured);
  const raw = execFileSync(
    "git",
    ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    {
      cwd: projectRoot,
      encoding: "utf8",
      timeout: 8_000,
      maxBuffer: 1_048_576,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const files = [...new Set(raw.split("\0").filter(Boolean))];
  let checked = 0;
  for (const file of files) {
    if (/(?:^|\/)(?:\.dev\.vars|\.env|[^/]+\.dpapi)$/.test(file)) {
      throw new Error("credential_file_not_ignored");
    }
    const content = await readFile(resolve(projectRoot, file), "utf8");
    if (protectedValues.some((value) => content.includes(value))) {
      throw new Error("protected_value_in_repository");
    }
    checked += 1;
  }
  console.log(
    JSON.stringify({
      status: "passed",
      files_checked: checked,
      method: "exact_in_memory_configured_secret_and_recipient_comparison",
      note: "Does not prove absence of unknown historical credentials; no secret values logged.",
    }),
  );
}

main().catch(() => {
  console.error("security_audit_failed_no_sensitive_details_logged");
  process.exitCode = 1;
});
