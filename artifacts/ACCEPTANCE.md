# Acceptance evidence

This report records observed results, not predicted outcomes. All implementation and live acceptance gates have evidence: `DONE`. The owner physically approved Premium and rejected password reset in Slack, confirmed the particular Premium email arrived, and authorized the extra Cloudflare permission required for actual GitHub CD. Historical pending observations below are superseded by this final gate record.

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
| Tests | Supervisor full Istanbul run:20 files,124 tests; typecheck/lint/diff-check | Passed |
| Branch coverage | Domain/adapters391/450=86.88%; every module above80%, no artificial exclusions | Measured; CI enforces80% per file |
| Admission / recovery | Local real D1 constraints, duplicate overlap, daily quota, deterministic create recovery, bounded retries | UNIT / INTEGRATION_MOCKED |
| HubSpot setup | Read and disposable associated note verified | LIVE_PROVIDER, passed |
| HubSpot seed | Five fictitious tickets created/read back; repeat `--apply` reused all five | LIVE_PROVIDER, passed |
| Notion setup | Shared root read; disposable child created/read/trashed | LIVE_PROVIDER, passed; not final KB processing |
| Notion application KB | Five policy pages created/read back; repeated seed verified all five without duplication | LIVE_PROVIDER, passed |
| Grounded application proposals | Four supported seeds each retrieved real Notion content and invoked Workers AI once; unknown office-parking seed persisted insufficient evidence with zero AI calls | LIVE_PROVIDER, passed; reused immutably for Slack/send |
| Workers AI setup | Small real structured inference | LIVE_PROVIDER, passed; not grounded application proposal |
| Slack setup | Workspace authentication, channel post and cleanup | LIVE_PROVIDER, passed; not secured application decision |
| Slack application proposals | All five posted once; unknown has no Approve option | LIVE_PROVIDER, passed |
| Signed decision/repeat actions | Simulated approve and reject each returned200 twice; one persisted decision/event delivery each | LIVE_PROVIDER + SIGNED_SLACK_SIMULATOR, not human |
| Actual approved delivery | Ticket…9587, one Resend attempt/receipt…af1e; COMPLETED Workflow/no error | Provider accepted, not inbox confirmed |
| Actual CRM audit | Note…7743: one create, candidate stored, direct marker/receipt/association and unique associated marker readback passed | LIVE_PROVIDER, passed |
| Reject/manual cases | Rejected ticket…4759 and insufficient-evidence ticket…0283 both zero Resend attempts | LIVE_PROVIDER, passed |
| Slack transport | Socket Mode disabled; signed HTTP interactivity URL saved and persisted after reload | LIVE_PROVIDER, passed |
| Read-only smoke | Health, unsigned401, five eligible HubSpot seeds, five unique Notion policies and five ledger rows | LIVE_PROVIDER, passed; no new AI/mail/post |
| Resend setup | Prior owner-only setup mail accepted and inbox confirmed | Setup only, does not satisfy application E2E |
| Hosting | Actual Worker upload/triggers, `/health` 200 configured true | LIVE_PROVIDER, passed |
| Remote D1 | Migrations0001–0006 applied | LIVE_PROVIDER, passed |
| Event retention | 30-day event-only history/max 100 per hour; four local tests; actual hourly cron pruned zero old events | Local and LIVE_PROVIDER passed; durable receipts retained |
| Production discovery | Actual cron admitted five once; next cron found same five, claimed/started zero; ledger/count remained five, attempts1 | LIVE_PROVIDER, passed including repeat polling |
| CI | Phase 5–6 PR/push runs 37873027894 / 37873044328 and master CI 37873158000 passed, including coverage gate | Passed |
| CD | Actual GitHub run37874057267 attempt2: quality, migrations, deployment and health passed | LIVE_PROVIDER, passed; prior skips do not count |
| Real human approval | Owner confirmed personal mobile Slack actions; Premium…9928 COMPLETED, password…3588 REJECTED/zero sends; readback corroborated | LIVE_HUMAN_CLICK, owner testimony plus ledger |
| Application inbox | Owner identified billing…9587 email and separately confirmed NEW Premium…9928 email after physical approval | INBOX_CONFIRMED, owner testimony, not mailbox API telemetry |

The read-only preflight repeated at01:03:41Z passed all attempted authentication/read checks and Free-plan checks. Its overall `incomplete` result reflects intentionally unrun disposable-write and setup-inference probes; the original phase0 smoke evidence remains separate. It did not send another email or regenerate application proposals.

Manual inspection of these four actual drafts found corresponding-policy suggestions and no claim that account/payment changes had already been performed. English seed inputs nevertheless yielded Spanish drafts, and some access cases were classified generically as TECHNICAL. That is an observed language/classification limitation, not an accuracy benchmark. Future prompts receive an explicit trusted language instruction; immutable existing proposals are not silently regenerated.

## Deployment

- Verified URL: https://ticketpilot-api.herrerogusano-ticketpilot.workers.dev
- Current CD-verified version: `c9e8c65c-aae1-428e-804a-5e1a993e8ff5`, source master`82fe92c`, uploaded by GitHub run37874057267 attempt2. Local protected bootstrap versions remain historical evidence.
- Actual deploy job and health verification succeeded; Worker startup25ms is startup time, not request CPU or Workflow step CPU.
- D1, AI, Workflow and `*/5 * * * *` scheduled bindings were returned by actual deployment. The scheduled configuration was also read back from the authenticated API.
- Secured phase-3 decision handling is deployed; actual unsigned POST returned401. Health returned200/configuredtrue. The transient protected plaintext deployment file was removed and its absence verified.
- Observed health request: 2 ms CPU / 3 ms wall time. This is only that health invocation, not processing CPU evidence.
- Phase-1 source initially failed without an HTTP response. A receiver-safe global Fetch wrapper fixed the runtime issue; diagnostic version `2513722f-01c4-4e9e-9cd2-55fb272f8591` observed actual successful scheduled processing at 00:45:32Z (CPU24ms, wall4320ms, outcome ok). This is measured, not a claim that every invocation stays below 10ms. No paid upgrade occurred.
- Free's nominal CPU allowance is10ms; official documentation describes flexibility for infrequent bursts, not guaranteed higher capacity. Intake was reduced and deployed at one ticket per poll to leave headroom (daily cap20 unchanged); targeted15 regression tests passed. Associated-note reconciliation is capped at10 to bound worst-case retry traffic. The revised intake's production peak CPU is not yet measured.
- Phase2 tail observed five successful Workflow invocations at aggregate CPU37–47ms (not per-step measurements), and repeat cron CPU12/14ms with outcome ok. Those cron invocations exceed the nominal Free10ms, so this demonstration does not establish sustained CPU-limit compliance. No automatic Paid change is permitted; quota/runtime failures must remain explicit blockers rather than be hidden.
- Phase3 repeat cron observations were11ms and4ms/outcomeok. The manual-only Workflow is waiting without error on its durable human-decision step. A canceled tail lifecycle entry during a long wait is not treated as failure when the authenticated instance status remains waiting; it also does not prove completed acceptance.
- Final deployed repeat cron observed14ms/outcomeok before simulator decisions; five found/zero admitted/started. Tail subsequently observed completed application Workflow invocations at aggregate43ms and12ms/outcomeok (not per-step CPU). No paid upgrade occurred; nominal Free compliance is not guaranteed.
- Simulator HTTP round trips were232/66ms for Approve and230/63ms for Reject, below3s in those four calls. This is measured client latency, not a worst-case guarantee.
- The 02:00:32Z production cron completed with 7 ms CPU / 447 ms wall time, pruned zero expired events, found five tickets and claimed/started zero. Subsequent remote reads confirmed five distinct tickets/Workflow IDs, admission count five, four AI reservations and maximum one Slack post attempt. One prior read returned Cloudflare7403; the next bounded read and subsequent smoke passed without changing credentials or permissions.
- Final local gates: 119 tests across 19 files, 79 selected integration tests across 11 files, typecheck/lint/diff-check passed. The 80% per-file branch threshold passed locally and in GitHub. PR5 merged as master `089b6e4`; master CI37873158000 and release37873158017 quality succeeded. Its deploy job was skipped, and repository secret names remained empty with deployment switch false. This is explicitly not verified CD.
- Phase4 source review fixed same-day ISO/SQLite cutoff comparisons, per-attempt cached429 reads, immutable retries/window limits, candidate-ID direct note verification and early approval-after-post continuation. Negative cases and real local Workflow executions are tested. Splitting a combined fixture removed test-only workerd cancellations; deliberate timeout diagnostic remains in its negative test with successful suite exit.

## Final external and human gate evidence

The owner authorized CD. The dedicated token was created and transferred directly from the authenticated Cloudflare UI into the private repository's encrypted Actions secret without printing or committing its value; no broad local OAuth was uploaded. The initial individual-Worker editor grant failed on the exact Workflows API with10000 while D1 migrations passed. Deployment was disabled during diagnosis. Official [Workflow update permissions](https://developers.cloudflare.com/api/resources/workflows/methods/update/) require Workers Scripts Write. The owner explicitly authorized that additional account-level permission, retaining November9 expiry, D1 Write and Account Settings Read, with no billing grant. Token scope now allows other Workers in this same account; do not describe it as Worker-only. The exact failed job was rerun after this correction and passed.

Slack HTTP interactivity is registered. The owner completed the reserved physical actions from mobile, and real ledger reads showed Premium…9928 COMPLETED with one Resend attempt/receipt…a8b1 and note…1399; password…3588 REJECTED with zero attempts/receipts. The owner separately confirmed the particular Premium message arrived. Actual verify:e2e returned LIVE_ACCEPTANCE_PASSED with source owner_chat_confirmation and directly verified unique note associations for both approved cases. The ignored local testimony is bound to ticket, receipt and decision time; its source is not falsely labeled interactive-terminal or independent mailbox telemetry. Five new negative/provenance tests cover the checker. Do not replay completed emails to reproduce the demo.

Read-only smoke and exact in-memory configured-secret/recipient audit passed after real deployment (82 unignored/tracked files checked). This audit is not a guarantee about unknown historical credentials. The current secret-value configuration remains outside this synced repository; transient deployment plaintext was deleted and absence checked.

## Scope and cost

Cloudflare Free and included usage limits were reviewed. No paid upgrade, purchased domain or billing setting change occurred. GitHub Free included Actions capacity was verified sufficient for the bounded checks. Slack's signup trial is not evidence of a permanent Free subscription; implementation must remain Free-compatible.

Only known synthetic demo resources are in scope. No secrets or full recipient address belong in this report. Provider accepted, inbox delivered, simulated approval and real human approval remain distinct outcomes.
