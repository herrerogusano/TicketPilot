# TicketPilot

A small, synthetic-only support automation demo with a human between a grounded AI draft and every outgoing email.

## Process

```text
HubSpot tagged demo tickets → five-minute Cron → atomic D1 admission
  → Cloudflare Workflow → Notion policy retrieval → Workers AI draft
  → Slack review → signed, allowlisted first decision
      ├─ Reject / expiry / insufficient evidence → no email
      └─ Approve supported draft → Resend acceptance → HubSpot audit note
```

Only tickets beginning with literal `[TP-DEMO]` and created after the configured launch cutoff are eligible. The backend, not the model or ticket content, chooses the sole test recipient. A provider acceptance is not evidence of inbox delivery.

Outgoing email keeps the ticket reason in its subject (the sanitized original ticket title, without its intake tag). Its plain-text body is exactly the approved draft reply. Category, priority, summary and policy metadata remain internal to Slack review and the CRM audit; they are not appended to the email. The mandatory demo marker and ticket ID remain in the subject.

Supported pending proposals can be edited in a signed Slack modal. Saving creates a new audited revision, not an approval: review the refreshed card and explicitly approve that version. Old buttons and stale forms cannot approve or overwrite a newer revision. Editing is unavailable after a decision or send reservation, and cannot make an unsupported proposal sendable. Original and human-edited versions remain in D1; the final HubSpot audit identifies the approved/sent revision and text. See [the demo](docs/DEMO.md) for the manual edit scenario and evidence limits.

## Stack and scope

- One TypeScript Cloudflare Worker: native Fetch API, Workflows, D1 and Workers AI.
- HubSpot Service Key; five fictitious Notion policies; one Slack workspace/channel/human approver; Resend onboarding sender to the account owner's verified address only.
- Zod validates external data. Vitest and the official Cloudflare testing helper exercise real local D1 constraints.
- No frontend, vector database, MCP, autonomous tool selection, AWS or additional agent runtime. Workflows coordinates a fixed process and durable human wait; Mastra would add machinery this one-shot process does not need. Five short policies need bounded direct retrieval, not embeddings.

The complete implementation and acceptance contract is in [PLAN.md](PLAN.md). Operational boundaries are in [AGENTS.md](AGENTS.md).

## Current verified status

The demo Worker [health endpoint](https://ticketpilot-api.herrerogusano-ticketpilot.workers.dev/health) and complete technical process are deployed. Five real synthetic tickets and Notion policies were verified. Live signed-simulator scenarios produced one accepted Resend email plus one directly verified associated HubSpot note, a rejection with zero sends, and an insufficient-evidence manual case. Duplicate callbacks did not duplicate side effects.

The owner subsequently approved Premium in Slack, rejected password reset and confirmed the particular Premium email arrived. Both associated notes were directly verified; rejected and manual cases sent nothing. A further owner-approved manual ticket also completed with one send/associated note and confirmed inbox arrival. Supervisor checks now pass 149 tests across 21 files, with 85.50% domain/adapter branch coverage including response revisions, customer-email presentation and legacy payload compatibility. The new Slack editing scenario still requires its own human modal/approval/inbox confirmation; earlier acceptance cannot substitute for that gate. Actual GitHub CD run37874057267 (attempt2) migrated, deployed and verified health successfully; subsequent releases are recorded in Actions. See [acceptance evidence](artifacts/ACCEPTANCE.md) for evidence provenance and limitations.

## Local development

Use Node.js 24 and npm. Dependencies are pinned in `package-lock.json`.

```sh
npm ci
npm run generate:types
npm run typecheck
npm run lint
npm test
npm run db:migrate:local
npx wrangler dev
```

Copy `.dev.vars.example` to an ignored `.dev.vars` only on a nonsynced, access-restricted machine, or supply secrets through a protected process environment. Never paste credentials into chat, Git, logs or synced notes. The Windows operator uses current-user DPAPI storage outside this repository and a protected launcher; that local storage is not a portable project dependency.

`npm run preflight -- --help` performs no probes. Normal preflight uses read-only checks; `--smoke-writes` explicitly allows disposable setup checks. `npm run seed:hubspot` is a dry run; add `-- --apply` to create at most five fictional tickets. Preserve the ignored seed manifest to reconcile reruns or uncertain creation outcomes instead of cloning objects.

`npm run seed:notion -- --help` also performs no probes. `npm run seed:notion` verifies existing policies or reports missing pages; `-- --apply` creates only missing fictional pages under the configured root. It verifies content and refuses duplicate keys or changed content rather than overwriting existing pages. Preserve its ignored manifest too.

Additional verification commands, with configured demo process credentials:

```sh
npm run test:integration
npm run test:coverage
npm run smoke
npm run security:audit
npm run verify:e2e
npm run verify:edit -- --ticket <synthetic-ticket-id>
```

`test:integration` selects real local Workers/D1/Workflow tests with controlled external providers; it is not a live-provider test. Coverage uses Istanbul, compatible with the Workers test runtime. `smoke` performs real read-only health, HubSpot eligibility, Notion page and D1 checks, plus an unsigned action rejection; it creates no inference, Slack post or email. `security:audit` compares tracked and unignored project files against configured secrets/recipient in memory, without printing them; it is not a guarantee about unknown historical credentials.

`verify:e2e` checks persisted scenario outcomes and directly reads the actual HubSpot note association. Missing scenarios or human evidence produce a pending report and nonzero exit. Provider receipts, signed simulations, physical clicks and inbox confirmation are never conflated. The owner may run `npm run verify:e2e -- --record-human-evidence` after actually clicking and inspecting the particular email. An explicit owner confirmation in this chat may also be recorded, labeled `owner_chat_confirmation`, and bound to the directly verified ticket/receipt/decision timestamp. These are owner testimony, not independent inbox telemetry; simulator or incomplete evidence cannot pass.

`simulate:decision` is CLI-only and excluded from production. It accepts only a fresh posted supported seed from the ignored manifest; Approve additionally requires `--allow-demo-email`. It records `SIGNED_SLACK_SIMULATOR`, not human testimony, and refuses reruns of an uncertain existing simulator record. The already tested approval/rejection must not be replayed to send another demonstration email.

## Hosting and release

The private repository's release branch is `master`. GitHub Actions checks types, lint and coverage before remote D1 migrations, deployment and actual health verification. The dedicated encrypted Actions secret is configured and `TICKETPILOT_DEPLOY_ENABLED=true`. The real deploy job passed; prior skipped jobs remain historical CI-only evidence. At the owner's explicit request, the replacement token has no expiration; revoke it if compromised or no longer needed. Workflows required owner-authorized account-level Workers Scripts Write in addition to D1 Write and Account Settings Read; its scope is not limited to this Worker. No billing grants were added.

Local protected bootstrap deployment is separate from verified CD. Configure account/resource IDs in `wrangler.jsonc`; use Wrangler secrets for provider keys and the immutable recipient. No public administration, seed, debug approval or send endpoint is allowed.

## Safety and limitations

- Maximum 20 admitted tickets per UTC day; bounded polling, retries, inference and policy excerpts. Counters are reserved atomically before work, not inferred from success logs.
- Free-tier-first does not mean unlimited. No paid upgrade, domain purchase or automatic billing is authorized. Account-wide usage by other applications can consume the same quotas.
- Slack signature verification, actor/workspace/channel allowlists and first-wins persistence protect decisions. A signed simulator is an integration test, not a real human click.
- No claim of permanent exactly-once email delivery: uncertain provider outcomes stop automated sends, and Resend's idempotency window is finite. Audit-note recovery must never resend an accepted email.
- Only synthetic material is suitable for this demo. It is not a production customer-email service or a benchmark of general answer accuracy.
- Redacted event history has 30-day retention, pruned in batches of at most 100 on the hourly cron slot. Durable ticket approvals, immutable payloads, provider receipts and usage reservations are not deleted. Recent/high-volume backlogs drain over bounded passes; this is not an exact immediate TTL guarantee.
- Actual repeat cron occasionally exceeded the nominal Free10ms CPU allowance while reporting success. This demonstrates observed behavior, not guaranteed sustained Free capacity. Current immutable English-input drafts are in Spanish; future prompts have tested language instructions, not a measured accuracy guarantee.

Live provider evidence, a real authorized Slack click and particular application inbox confirmation are now separately recorded. Setup mail and mocks are not substituted for those gates.
