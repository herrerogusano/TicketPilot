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

## Stack and scope

- One TypeScript Cloudflare Worker: native Fetch API, Workflows, D1 and Workers AI.
- HubSpot Service Key; five fictitious Notion policies; one Slack workspace/channel/human approver; Resend onboarding sender to the account owner's verified address only.
- Zod validates external data. Vitest and the official Cloudflare testing helper exercise real local D1 constraints.
- No frontend, vector database, MCP, autonomous tool selection, AWS or additional agent runtime. Workflows coordinates a fixed process and durable human wait; Mastra would add machinery this one-shot process does not need. Five short policies need bounded direct retrieval, not embeddings.

The complete implementation and acceptance contract is in [PLAN.md](PLAN.md). Operational boundaries are in [AGENTS.md](AGENTS.md).

## Current verified status

Implementation is in progress. The demo Worker [health endpoint](https://ticketpilot-api.herrerogusano-ticketpilot.workers.dev/health) is deployed. Provider credential smoke checks succeeded; they do **not** certify the application's end-to-end flow. See `artifacts/EXECUTION_STATE.md` and the phase evidence files for current facts.

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

## Hosting and release

The private repository's release branch is `master`. GitHub Actions checks types, lint and tests before the gated release job applies remote D1 migrations and deploys. The dedicated Cloudflare credential and `TICKETPILOT_DEPLOY_ENABLED=true` must be configured before calling CD operational. A passing quality job with a skipped deployment is **not** a successful release.

Local protected bootstrap deployment is separate from verified CD. Configure account/resource IDs in `wrangler.jsonc`; use Wrangler secrets for provider keys and the immutable recipient. No public administration, seed, debug approval or send endpoint is allowed.

## Safety and limitations

- Maximum 20 admitted tickets per UTC day; bounded polling, retries, inference and policy excerpts. Counters are reserved atomically before work, not inferred from success logs.
- Free-tier-first does not mean unlimited. No paid upgrade, domain purchase or automatic billing is authorized. Account-wide usage by other applications can consume the same quotas.
- Slack signature verification, actor/workspace/channel allowlists and first-wins persistence protect decisions. A signed simulator is an integration test, not a real human click.
- No claim of permanent exactly-once email delivery: uncertain provider outcomes stop automated sends, and Resend's idempotency window is finite. Audit-note recovery must never resend an accepted email.
- Only synthetic material is suitable for this demo. It is not a production customer-email service or a benchmark of general answer accuracy.

Final presentation requires separately recorded live provider evidence, a real authorized Slack click, and owner confirmation of inbox arrival. Setup mail or mock tests do not satisfy those gates.
