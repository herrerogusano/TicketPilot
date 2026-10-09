# Acceptance evidence

This report records observed results, not predicted outcomes. Implementation remains in progress; it is not yet DONE.

## Evidence labels

- `UNIT`: deterministic domain/adapter checks with fixtures.
- `INTEGRATION_MOCKED`: local Workers runtime/D1 with controlled provider or event doubles.
- `LIVE_PROVIDER`: actual authenticated provider calls or deployed runtime observations.
- `LIVE_HUMAN_CLICK`: a real allowlisted human physically selects a Slack button; not a signed simulator.
- `INBOX_CONFIRMED`: the owner confirms the application's particular accepted message arrived; not an earlier setup email.

## Current observations

| Gate | Observed evidence | Result |
| --- | --- | --- |
| Types / lint | Supervisor `npm run typecheck`, `npm run lint` | Passed |
| Tests | Supervisor `npm test`: 8 files, 50 tests | Passed at phase 2 |
| Admission / recovery | Local real D1 constraints, duplicate overlap, daily quota, deterministic create recovery, bounded retries | UNIT / INTEGRATION_MOCKED |
| HubSpot setup | Read and disposable associated note verified | LIVE_PROVIDER, passed |
| HubSpot seed | Five fictitious tickets created/read back; repeat `--apply` reused all five | LIVE_PROVIDER, passed |
| Notion setup | Shared root read; disposable child created/read/trashed | LIVE_PROVIDER, passed; not final KB processing |
| Notion application KB | Five policy pages created/read back; repeated seed verified all five without duplication | LIVE_PROVIDER, passed |
| Grounded application proposals | Four supported seeds each retrieved real Notion content and invoked Workers AI once; unknown office-parking seed persisted insufficient evidence with zero AI calls | LIVE_PROVIDER, passed; no approval/email yet |
| Workers AI setup | Small real structured inference | LIVE_PROVIDER, passed; not grounded application proposal |
| Slack setup | Workspace authentication, channel post and cleanup | LIVE_PROVIDER, passed; not secured application decision |
| Resend setup | Prior owner-only setup mail accepted and inbox confirmed | Setup only, does not satisfy application E2E |
| Hosting | Actual Worker upload/triggers, `/health` 200 configured true | LIVE_PROVIDER, passed |
| Remote D1 | Migrations 0001, 0002 and 0003 applied | LIVE_PROVIDER, passed |
| Production discovery | Actual cron admitted five once; next cron found same five, claimed/started zero; ledger/count remained five, attempts1 | LIVE_PROVIDER, passed including repeat polling |
| CI | Phase-0 CI and both phase-1 PR/push checks succeeded | Passed |
| CD | Release quality passed; deploy job deliberately skipped | Pending scoped credential authorization |
| Real human approval | No application Slack proposal/button gate yet | Not run |
| Application inbox | No application email sent | Not run |

## Deployment

- Verified URL: https://ticketpilot-api.herrerogusano-ticketpilot.workers.dev
- Current phase-2 version: `9827444f-6f71-40df-8e90-aa4f27c1b769`.
- Local protected Wrangler bootstrap, not verified GitHub CD.
- D1, AI, Workflow and `*/5 * * * *` scheduled bindings were returned by actual deployment. The scheduled configuration was also read back from the authenticated API.
- Unsigned Slack requests still reject by default; phase-3 decision handling is not deployed yet.
- Observed health request: 2 ms CPU / 3 ms wall time. This is only that health invocation, not processing CPU evidence.
- Phase-1 source initially failed without an HTTP response. A receiver-safe global Fetch wrapper fixed the runtime issue; diagnostic version `2513722f-01c4-4e9e-9cd2-55fb272f8591` observed actual successful scheduled processing at 00:45:32Z (CPU24ms, wall4320ms, outcome ok). This is measured, not a claim that every invocation stays below 10ms. No paid upgrade occurred.
- Free's nominal CPU allowance is10ms; official documentation describes flexibility for infrequent bursts, not guaranteed higher capacity. Intake was reduced and deployed at one ticket per poll to leave headroom (daily cap20 unchanged); targeted15 regression tests passed. Associated-note reconciliation is capped at10 to bound worst-case retry traffic. The revised intake's production peak CPU is not yet measured.

## External blockers and human gates

The separate GitHub Actions deployment token has not been created. The prepared Cloudflare grant is limited to the existing `ticketpilot-api` Worker editor plus account D1 Write and Account Settings Read, with 30-day expiry. Await the operator's explicit confirmation before creating access. Capture it through the protected terminal, never chat; save only as the private repository's encrypted Actions secret, then enable and verify an actual deploy job. Do not substitute broad local OAuth or claim the skipped job deployed anything.

After the secured application is deployed, register its Slack Interactivity request URL, post the scenario proposals, and request the human approval/rejection and message-specific inbox confirmation once. Record exact resume commands when the corresponding CLI verification is implemented; no placeholder command counts as a verified script.

## Scope and cost

Cloudflare Free and included usage limits were reviewed. No paid upgrade, purchased domain or billing setting change occurred. GitHub Free included Actions capacity was verified sufficient for the bounded checks. Slack's signup trial is not evidence of a permanent Free subscription; implementation must remain Free-compatible.

Only known synthetic demo resources are in scope. No secrets or full recipient address belong in this report. Provider accepted, inbox delivered, simulated approval and real human approval remain distinct outcomes.
