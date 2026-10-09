# Operations

This is a synthetic demonstration, not a customer-mail service. Never change a recipient from ticket text, increase permissions to hide an authentication error, or enable paid billing to make a test pass.

## Inspect without disclosing content

Commands below use the installed Wrangler 4.149.0 syntax. Resource names refer to this demo only.

```sh
npx wrangler workflows list
npx wrangler workflows instances list ticketpilot-workflow --per-page 5 --json
npx wrangler workflows instances describe ticketpilot-workflow INSTANCE_ID --no-step-output
npx wrangler d1 execute ticketpilot-db --remote --command "SELECT state, COUNT(*) AS count FROM tickets GROUP BY state;"
npx wrangler d1 execute ticketpilot-db --remote --command "SELECT utc_day, accepted_ticket_count FROM daily_usage ORDER BY utc_day DESC LIMIT 3;"
npx wrangler secret list --name ticketpilot-api
```

List secret **names**, never values. Do not select the email payload, draft text or full recipient into terminal logs. Raw Workflow step outputs may contain synthetic ticket/policy content; use `--no-step-output` during routine inspection. In Wrangler 4.149.0, `--json` still includes step outputs despite that flag: capture and parse privately, emitting only allowlisted status/step-success metadata, never the raw JSON. Local tests use local D1, not the remote demo database.

## Release and authentication

```sh
npm run typecheck
npm run lint
npm test
npm run db:migrate:remote
npm run deploy
```

The last two commands mutate the remote demo and require authenticated, scoped access. A deployment is verified by actual success, `/health`, bindings and scenario evidence, not an expected URL. GitHub Actions only deploys from `master` after quality gates and when the explicit deployment switch is enabled. Keep that switch false while its credential is missing or revoked; never upload Wrangler's local OAuth token as a CI workaround.

If a provider returns 401/403, confirm the correct demo account and existing least-privilege grants. A Resend send-only key cannot list domains: that failure is not a reason to broaden it. Notion root sharing and Slack bot channel membership are separate from token validity. Redact provider error bodies and credentials before recording diagnostics.

## Bounded recovery

Duplicate polling must reuse the unique ticket row and deterministic `ticketpilot-<HubSpot ID>` instance. Admission counters must not be decremented or reset to admit more than the daily cap. A lost Workflow-create response is reconciled by its deterministic ID; exhausted attempts stop for manual review rather than running indefinitely.

Seed reruns use their ignored manifests and exact markers. After an uncertain create result, reconcile existing objects first. Never remove a manifest to force another create. Multiple matching objects require manual investigation, not arbitrary selection.

Once a real email has been accepted, recovery may write or verify **the HubSpot audit note only**. Do not restart the sending path to fix a note.

`SEND_UNKNOWN` means the request could have been accepted. Inspect provider evidence manually; do not automatically resend. Resend's finite idempotency window does not prove permanent exactly-once delivery. A 409 is not a receipt. Record a provider ID only from verified acceptance evidence; inbox delivery requires the owner separately.

## Workflow restart caveat

Wrangler supports the following operator command:

```sh
npx wrangler workflows instances restart ticketpilot-workflow INSTANCE_ID
```

Restart erases Workflow intermediate execution state and replays it. It is **not** a general retry command. During development the supervisor may restart a specific seed instance whose verified output is the phase-1 safe placeholder, before any draft/message/email side effects. Never use this command for `SEND_IN_PROGRESS`, `SEND_UNKNOWN`, an accepted email or unresolved external writes. Durable D1 guards still need to be checked before any permitted replay.

## Pause and cleanup

Disable the release switch first so CI cannot redeploy unexpectedly. To stop intake, remove this Worker's Cron expression from `wrangler.jsonc` and deploy the reviewed configuration. Existing Workflow instances are independent: stop or inspect them separately before removing credentials or resources. A missing critical runtime secret stops configured intake; do not treat that as a complete emergency-stop mechanism for already-running work.

Remove only known fictional seed pages/tickets or known disposable setup objects, preferably using recoverable trash/archive operations. Confirm the exact IDs from manifests before action. Do not recursively delete a vault/workspace, reset unrelated Git changes, drop a database with unreviewed evidence or delete all account Workflows. Retain redacted acceptance evidence before teardown.

## Windows unattended execution

The operator requested a temporary `SetThreadExecutionState` display/system wake request for this build. It does not change the power plan. Keep that helper alive during work, and release it before the final response; its exact PID/session recovery information is in `artifacts/EXECUTION_STATE.md`. Closing the laptop lid or manually selecting Suspend is outside this automatic-idle protection.
