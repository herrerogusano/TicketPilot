# TicketPilot — Master Implementation Plan (MVP 1.0)

**Status:** implementation-ready specification, subject only to the external access preflight below.  
**Date:** 2026-10-09  
**Execution:** complete phases 0–6 in sequence; no other architectural or product choices are delegated to the implementation agent.  
**Companion file:** `AGENTS.md` (mandatory execution contract).

## 1. Mission and done definition

Build and deploy a **small, real, free-tier-first AI support automation**, not a general-purpose agent platform. A synthetic ticket created in a free HubSpot CRM is detected by a Cloudflare Cron Trigger; a Cloudflare Workflow reads relevant synthetic support policies from Notion, invokes Cloudflare Workers AI **once** to classify the ticket and propose a grounded reply, posts a human-approval message in Slack, and, **only after authorized approval**, calls Resend to send a real message to the sole allowlisted test email address. Finally it records the email acceptance and audit metadata on the originating HubSpot ticket and in Cloudflare D1.

**Definition of DONE (all required):**
1. TypeScript source builds and all unit/contract/integration tests pass.
2. The production Worker, D1 database, Workflows binding, scheduled trigger, AI binding, and Slack action endpoint are actually deployed under an HTTPS `workers.dev` URL; deployment verified, not assumed.
3. At least one synthetic HubSpot ticket is processed through **actual HubSpot + Notion + Workers AI + Slack message posting + Resend + HubSpot note** integrations. A signed Slack-action simulator may exercise the handler during unattended testing; it does **not** qualify as a real human click.
4. A **real Slack button click by an allowlisted user** is separately verified as a live acceptance gate. This requires the user's participation if an independent authorized human is unavailable; do not pretend an automated simulator equals this gate.
5. Approved ticket results in **one** Resend API acceptance and **one** HubSpot audit note, subject to tested retry scenarios; rejected tickets send **zero** emails. Test email must be verifiably received in the owner's inbox for a delivery claim. API acceptance alone means **accepted by provider**, not inbox delivered.
6. Insufficient evidence produces a cautious draft/manual-review warning, never a fabricated answer or automatic send; any email action still requires explicit human approval (but the default for insufficient evidence is **no Approve button**, only Reject/Manual review).
7. A clear README, example redacted traces, a compact architecture diagram, scenario demo script, and truthful evidence report exist.
8. No secrets, real customer data, paid subscription, purchased domain, or unapproved external destinations.

If external credentials or the human-click acceptance gate are unavailable, finish every possible other phase and mark final status **BLOCKED_EXTERNAL_ACCESS** or **PENDING_HUMAN_LIVE_ACCEPTANCE**, not DONE. Record the exact missing item and resumption command.

## 2. Frozen product scope

### Included
- **HubSpot CRM Free:** ticket source, sample synthetic tickets, and a final internal audit note associated with each ticket. Do **not** use HubSpot as the email sender.
- **Notion Free:** five short, synthetic support procedures maintained as five pages under one shared root page. Read content with the official Notion API; no embeddings/vector database.
- **Cloudflare Workers + Workflows + D1 + Workers AI:** HTTP endpoint, polling, orchestration, persistent states, and inference.
- **Slack Free:** a single channel receives a concise proposed answer with category, priority, Notion evidence and **Approve / Reject** buttons, signed interactions and allowlisted approver.
- **Resend Free:** real outgoing email from `TicketPilot Demo <onboarding@resend.dev>` to **one verified test recipient**, which must be the Resend account owner's email while using the onboarding sender. `TEST_RECIPIENT_EMAIL` is an immutable server-side configuration; ignore ticket contact emails for delivery.
- Deterministic happy-path and adverse-path demo fixtures plus strong tests.

### Explicitly excluded
Mastra, MCP, Zendesk, Cloudflare Pages/frontend/dashboard, custom domain, inbound-email processing, threaded replies, replying through HubSpot Conversations, multi-tenant support, general CRM sync, personal data enrichment, analytics product, RAG/embeddings, autonomous tool selection, user sign-up, production-ready deliverability, customer-facing email to arbitrary recipients, more than one approver, new billable providers, and additional channels/features.

**One-shot agent policy:** This is a structured single LLM call inside a predefined Workflow, **not** an autonomous agent. The backend controls all side effects.

## 3. Architecture and ownership

```
HubSpot CRM (only tickets with [TP-DEMO] subject + created after launch cutoff)
       | Cloudflare Cron: */5 * * * *
       v
Worker scheduled handler -----> D1 (unique ticketId claim; budgets; status)
       | starts deterministic Workflow instance for new ticket
       v
Cloudflare Workflow
       +--> HubSpot get ticket (revalidate eligibility)
       +--> Notion list block children of 5 synthetic policy pages
       +--> Deterministic relevant-page selection; max 3 short excerpts
       +--> Workers AI (Llama 3.3 70B FP8 Fast; 1 structured request)
       +--> Validate output and policy references against retrieved docs
       +--> Slack chat.postMessage with interactive Approve/Reject
       +--> Durable waitForEvent('ticket-decision', timeout 48 hours)
                  ^
                  | signed POST /slack/actions -> authorized ID -> D1 CAS -> sendEvent
       +--> If rejected/expired: record outcome; no email
       +--> If approved/evidence sufficient: Resend -> HubSpot audit note
       +--> D1 final state, observability / evidence
```

- Runtime: TypeScript strict, current maintained Node LTS for tools, standard Workers runtime for deployment, `wrangler`, lightweight native Fetch API (no Express/Bolt/Hono), D1 prepared statements, Workers AI binding, Workflows binding, `crypto.subtle` for HMAC. Use `zod` only for external runtime response validation. `vitest` and official Cloudflare testing helpers for unit/integration tests.
- Exactly **one Worker deployment** with both `fetch` and `scheduled` handlers, plus the Workflow class exported from the same repository (Wrangler bindings). No second service required.
- Wrangler config in `wrangler.jsonc`; D1 migrations, Workflows binding, Workers AI binding, `workers_dev = true`, Cron every 5 minutes; local `wrangler dev` for smoke.
- All external services via direct HTTP `fetch` and small typed adapters. Do not add heavyweight SDKs unless a documented unavoidable blocker appears; avoid module/runtime size and CPU surprises.
- Cloudflare `workers.dev` hosts only `/health` and `/slack/actions` publicly. No public send/approve/test endpoint. Any debug utility is **CLI-only**, uses local credentials, and is excluded from production code.
- No arbitrary user input may ever select an email destination or provider credentials.

## 4. Fixed functional contract

### Ticket eligibility
- Only process tickets whose subject starts with literal `[TP-DEMO]` and whose creation time is at/after `DEMO_START_AT` (UTC ISO8601 set during setup). Do **not** process older or other tickets, even if permitted by the HubSpot key.
- Source only HubSpot ticket properties actually available through the verified free account (such as `subject`, `content`, `createdate`); use ID and ISO timestamps. Text length cap: title 160 chars, body 3,000 chars. No attachment ingestion.
- Use `POST /crm/v3/objects/tickets/search` (or the current equivalent **only after official API verification**), with createdate filter, recent-first sort, pagination up to three pages and budget. Do not trust search results without eligibility revalidation.
- Poll every 5 minutes; if a poll fails retry at the next trigger and log appropriately. Only new eligible tickets not already claimed start a Workflow. Maximum 20 new tickets **per UTC day** in a D1 atomic admission gate; overflow remains eligible for later processing, do not drop it permanently. Seed at most five demo tickets.

### Policies in Notion
- Create root `TicketPilot — Demo Support KB`, give the integration access, and seed exactly **five** policy pages, with deterministic logical keys: `billing-double-charge`, `premium-activation`, `password-reset`, `export-csv`, `incident-escalation`.
- Each contains: heading, what applies, allowed actions, constraints and a concrete sample response. Mark all as fictitious. No real user credentials or personal information.
- The developer seed script must be **safe to rerun**: persist page IDs in a local gitignored seed manifest; check existing children/keys before creation; do not duplicate pages.
- Each ticket requests page/block contents through Notion's versioned API. Implement cursor pagination, conservative API request rate limits and bounded blocks (e.g. 50 per page). Fail closed if Notion is unavailable, not silently use fabricated docs.
- Select 0–3 documents deterministically using fixed keyword overlap (title and a small synonyms table). **Do not** ask the model to call Notion, and do not implement vector search. When none meet minimal relevance threshold, classify `INSUFFICIENT_EVIDENCE`, never propose a confident resolution.

### LLM
- Bind `AI` to Cloudflare Workers AI; model exactly `@cf/meta/llama-3.3-70b-instruct-fp8-fast` for MVP.
- One inference per ticket, temperature 0, `max_tokens` <= 450, input <= ~3,000 tokens; request JSON Mode with schema if supported by verified runtime; always validate locally with Zod. Zero/one bounded repair attempt **only for invalid format** if budget allows; never auto-escalate models or buy tokens. Do not claim JSON Mode guarantees conformance.
- Result fields: `category` enum `BILLING|ACCESS|TECHNICAL|OTHER`; `priority` `LOW|MEDIUM|HIGH`; `evidence_status` `SUPPORTED|INSUFFICIENT_EVIDENCE`; `summary` <= 240 chars; `draft_reply` <= 1,500 chars; `cited_policy_keys` array (0–3) limited to selected retrieved docs; `rationale` <= 300 chars. Use all strings in Spanish or English consistently with ticket input (default Spanish) but stable machine enums in English.
- Prompt is static/versioned (`prompt_version = ticketpilot-v1`), strictly treats ticket and Notion material as untrusted, explicitly forbids obeying embedded instructions, tool use, PII disclosure and fabricated source references. Model never selects recipient, sends email, writes to CRM or authorizes its own action.
- Backend checks evidence status, citations, length, JSON/schema. Any invalid/unsupported citation -> `NEEDS_MANUAL_REVIEW`; Slack may show warning but **no Approve option** until there is a supported draft. No auto-email path under any circumstance.

### Slack review
- Single channel ID; single `SLACK_APPROVER_USER_ID` allowlist (more users are out of scope); bot scope only `chat:write` and any additional scope demonstrably needed during setup. Use **HTTP interactivity**, not Socket Mode. Request URL: `https://<worker>.<subdomain>.workers.dev/slack/actions`.
- Verify `X-Slack-Signature` (`v0` HMAC-SHA256 on raw body) using the signing secret and `X-Slack-Request-Timestamp` age <= 5 minutes, using constant-time comparison; reject malformed, unauthorized, missing, replayed and duplicate decisions.
- Body may be `application/x-www-form-urlencoded` with a `payload` JSON field. Verify before parsing. Check team, channel, user, ticket ID, proposal ID and decision revision against server-side persisted values. Do not trust user-supplied proposal text.
- Acknowledge within 3 seconds: verify, D1 conditional atomic approval transition, enqueue Workflow event in `ctx.waitUntil` after persistence, return HTTP 200 immediately. Guarantee eventual event delivery by a lightweight retry/reconciliation on the next Cron trigger for approved/rejected decisions that still await an event. Cloudflare `waitForEvent` buffers early events; do not add sleeps as a race workaround.
- Only first authorized Approve/Reject action wins (`UPDATE ... WHERE status='AWAITING_APPROVAL' AND decision IS NULL`). Replay/second click is a no-op, not a new send. Update Slack message status asynchronously (`chat.update`) without relying on it for correctness. Include ticket ID, classification, priority, draft, policy titles/links, buttons.
- `waitForEvent` timeout 48h -> EXPIRED; no email. Approve only available for SUPPORTED responses, never insufficient/invalid ones.

### Resend and HubSpot writeback
- Send after durable approval event only; sender fixed `TicketPilot Demo <onboarding@resend.dev>`; recipient fixed `TEST_RECIPIENT_EMAIL`, configured as the email of the registered Resend owner; subject `[TicketPilot DEMO] Ticket <HubSpot ID> — Response`.
- Render **plain text** content only; preserve fixed payload in D1 before sending, HTML not needed. Guard destination server-side and assert identical to registered/verified test recipient in preflight. No outbound emails to real ticket contacts.
- Stable idempotency key `ticketpilot/<ticketId>/v1`, stable payload across retries, send once. Resend idempotency protection lasts **24 hours only**; do not treat it as an indefinite exactly-once guarantee. Before call persist `SEND_IN_PROGRESS` with fixed idempotency key and immutable payload hash. If successful record Resend email ID and state `EMAIL_ACCEPTED`. If definitive failure -> `SEND_FAILED` with bounded retries (max three within ten minutes) only for known safe retriable errors. If response is ambiguous after request may have reached provider, set `SEND_UNKNOWN`; **do not auto-resend** (no way to promise exactly-once after unknown outcome). Require manual provider reconciliation. Sending is never silently repeated after >24h.
- After `EMAIL_ACCEPTED` create **one** HubSpot internal note containing timestamp, category, priority, source policy keys, approval actor (Slack ID), recipient alias or masked address, Resend email ID, and a short summary. The note is audit evidence, **not** the customer reply channel. Use Notes API and official associations API to associate note to the correct ticket; query correct note-to-ticket association type instead of hardcoding the contact association ID. Save created note ID in D1. HubSpot note-write failures cause `EMAIL_ACCEPTED_PENDING_CRM_AUDIT`; never resend email. Reconcile audit separately with bounded retries and verify association before creating any second note.
- Never mark delivery/receipt confirmed just because Resend returned HTTP 200/202; record `EMAIL_ACCEPTED`, and only mark inbox verified after explicit human confirmation in evidence report.

## 5. Minimal data model and state machine

Tables (D1 migrations, keys/constraints included):

1. `tickets`: `hubspot_ticket_id TEXT PRIMARY KEY`, `workflow_instance_id TEXT UNIQUE`, `created_at`, `updated_at`, `hubspot_created_at`, `subject`, `state`, `category`, `priority`, `evidence_status`, `draft_reply`, `policy_keys_json`, `proposal_hash`, `slack_channel`, `slack_message_ts`, `decision`, `decision_by`, `decision_at`, `approved_payload_hash`, `resend_idempotency_key`, `resend_message_id`, `hubspot_note_id`, `error_code`, `retries`, `correlation_id`.
2. `events`: append-only records `(id PRIMARY KEY, ticket_id, event_type, at, details_redacted_json)`; bounded retention; no credentials, raw emails or token headers.
3. `daily_usage`: `utc_day TEXT PRIMARY KEY`, `accepted_ticket_count INTEGER`; atomic budget checks using D1 conditions/transactions where supported, or a single-statement guarded update. Do not implement read-then-write races.

Allowed state transitions:
`DISCOVERED -> PROCESSING -> AWAITING_APPROVAL -> APPROVED -> SEND_IN_PROGRESS -> EMAIL_ACCEPTED -> COMPLETED`.
Alternate terminal states: `REJECTED`, `EXPIRED`, `NEEDS_MANUAL_REVIEW`.
Recoverable/exception states: `RETRY_PENDING`, `SEND_FAILED`, `SEND_UNKNOWN`, `EMAIL_ACCEPTED_PENDING_CRM_AUDIT`.
Every transition validated in one module, each externally visible side-effect assigned a stable operation key and tested under repetition/concurrency. Workflow instance ID is deterministic (`ticketpilot-<ticketId>`), and a D1 uniqueness claim precedes creation. Define recovery if claiming succeeded but Workflow creation failed.

## 6. Security, privacy, reliability and free-tier policy

- All example people, company, tickets, policies and recipients are fictional except the allowlisted owner email address, stored as a secret/variable (never committed). Avoid any other personal/sensitive data. Prefix seed data `[TP-DEMO]`.
- Secrets must be configured with `wrangler secret put` and in local `.dev.vars` (gitignored); `.env.example` contains names only, fake placeholder values. No keys in logs, Slack bodies, README or report.
- Worker `GET /health` contains version, `ok` and no connection details. Do not expose D1 rows, `/admin`, seed routes or unsigned mutation routes.
- Validate Slack signature *before* trusting payload; minimal HubSpot scopes; Notion root-page sharing only; Resend send-only key if provider supports it; no wildcard destinations. Retry 429/5xx with bounded exponential backoff and jitter; honor `Retry-After` when provided. Do not retry 400/401/403 blindly.
- Cap: 20 admitted tickets per UTC day, 1 AI call each (max 1 additional format repair on invalid result), input <= 3k tokens/output <=450, <=5 seeded policies and <=3 policies selected, 1 Slack approval message, 1 authorized email to allowlisted address. Paused workflows count toward free plan storage; use bounded 48-hour timeout. No infinite loops or mass seeding.
- Free-tier quotas are shared account-wide and change. Preflight must check Workers, D1, Workflows and Workers AI quotas/availability. Workflows Free currently includes 3,000 steps/day and a 10ms active CPU limit per step; Workers AI free allocation is 10,000 Neurons/day. Never enable a paid add-on/upgrade or billing overage automatically. If plan Free cannot support actual CPU/runtime requirements, **do not change to Paid without user consent**; report the blocker and keep code/test deliverables complete.
- Because Workers Free CPU is very tight, use small modules and fetch-oriented code, avoid heavy crypto/hash libraries and expensive synchronous processing. Verify measured CPU and actual deployed compatibility; do not assume network wait time is CPU.
- Never claim production-grade exactly-once delivery. Maintain conservative side effect handling for uncertain provider outcomes. Persist status and request correlation IDs.

## 7. Preflight: all human-controlled items (complete BEFORE unattended Codex run)

**Goal:** separate access preparation from implementation. The operator performs these tasks, not Codex, unless the same accounts are explicitly available through its authenticated CLI environment. Only paste safe non-secret IDs into configuration; keys go directly to CLI secrets, never in chat or git.

- [ ] **Cloudflare:** create/confirm Free account, account ID and `workers.dev` subdomain. Install/authenticate `wrangler` (`wrangler whoami` succeeds). Confirm Workers AI and Workflows show as available under Free and D1 database can be created. Set worker name `ticketpilot-api`. If Slack requires a publicly reachable pre-existing URL during app setup, publish a temporary benign Worker at that name/URL using the Cloudflare dashboard; subsequent deployment replaces it with verified signature handling.
- [ ] **HubSpot:** create free **CRM account** (not merely developer test account), create a Service Key with least privileges to read/search/create test tickets, read/write notes and read associations as supported. Confirm a `GET`/search of tickets and a **disposable** test note associated to a test ticket can succeed with the key. Do not use OAuth or legacy private apps as unplanned fallback. Confirm subject/body property names and IDs for the live account. Operator can remove preflight objects afterward.
- [ ] **Notion:** create a workspace root page `TicketPilot — Demo Support KB`, create an **internal** integration and share the root page with it. Grant read + insert/write only because seed script must create five child policy pages. Confirm token can read parent and create a disposable child. Save `NOTION_PARENT_PAGE_ID`.
- [ ] **Slack:** create free workspace and private/public `#ticketpilot-demo` channel; create app for this one workspace with `chat:write` bot scope, install app, invite bot to channel, enable Interactivity and request URL `https://<worker>.<subdomain>.workers.dev/slack/actions` (can register a stub URL during preflight). Store Bot OAuth token, Signing Secret, channel ID, workspace/team ID and your own Slack User ID. Confirm `chat.postMessage` works with disposable smoke message. Set exactly one approver.
- [ ] **Resend:** create free account **using the precise email that will receive demo messages**. Create an API key with send permission; use onboarding sender `onboarding@resend.dev`. Before implementation, **send one real test email from their playground/API to this account email** and verify arrival. Save exact recipient as `TEST_RECIPIENT_EMAIL`. If onboarding sender/test routing is not available, do **not** silently substitute paid mail or a custom domain: block real-email gate pending access remediation.
- [ ] **Repository/local:** create or choose git repo, install Node LTS/npm and required Wrangler credentials. Decide operator's `DEMO_START_AT` at initialization; set UTC now (not a date in source). Confirm no personal/customer data in tickets. Prefer free quotas; do not enable paid plans.

Preflight variables/secrets contract:

| Name | Type | Purpose |
|---|---|---|
| `HUBSPOT_SERVICE_KEY` | secret | CRM auth |
| `NOTION_TOKEN` | secret | knowledge base API |
| `NOTION_PARENT_PAGE_ID` | variable | root page |
| `SLACK_BOT_TOKEN` | secret | post/update messages |
| `SLACK_SIGNING_SECRET` | secret | signed actions |
| `SLACK_CHANNEL_ID` | variable | sole channel |
| `SLACK_TEAM_ID` | variable | sole workspace |
| `SLACK_APPROVER_USER_ID` | variable | approved actor |
| `RESEND_API_KEY` | secret | email send |
| `TEST_RECIPIENT_EMAIL` | secret | immutable allowlisted recipient |
| `DEMO_START_AT` | variable | no historical tickets |
| `TICKETPILOT_ENV` | variable | `demo` only |

Do not ask for other external accounts. Store Cloudflare account auth in Wrangler's normal local auth, not as a Worker secret. Use `wrangler.jsonc` bindings with actual D1 ID and Workflow class/name; generated D1 IDs are infra configuration, never guessed.

**Before allowing the implementation to begin unattended**, run `npm run preflight` (implemented as first deliverable) to probe services with **safe reads or explicitly disposable writes**, report pass/fail per provider, verify Workers AI sample JSON output and a real Resend test delivery flag set manually by operator. Gate all real sends behind allowlisted recipient + approval. If setup is not available before sleep, Codex may implement all offline work; it cannot honestly certify the live E2E.

## 8. Phase execution (ONE master plan; no separate phase MDs)

### Phase 0 — Repository, safeguards and preflight (must complete first)
Tasks:
1. Initialize TypeScript strict project: `wrangler`, `vitest`, `zod`, lint/format scripts, basic CI workflow, `.gitignore`, `.dev.vars.example`, `wrangler.jsonc`, `src/` modules and `test/` folders.
2. Implement typed Env bindings, env validation, config constants (max requests/lengths/timeouts); prohibit starting cron processing on missing critical values, but health endpoint may report sanitized `not-configured` state.
3. Implement `scripts/preflight.ts` with separate checks for Cloudflare, HubSpot scopes, Notion root read, Slack auth/post availability, Resend sender/recipient constraints; no irreversible writes without an explicit `--smoke-writes` flag. Produce `artifacts/preflight-redacted.json`.
4. D1 migration; minimal Worker `GET /health`, secured `POST /slack/actions` placeholder (reject by default until Phase 3), and Workflow class scaffold; deploy minimal Worker to give final Slack Request URL.
5. Run typecheck, basic tests and confirm URL deployment if credentials present.
Exit: deterministic build/tests, health deployed when possible, explicit preflight report; no deployed insecure approval handler.

### Phase 1 — HubSpot discovery + D1 idempotency
Tasks:
1. Implement HubSpot adapter (`searchDemoTickets`, `getTicket`, `createNote`, `findAssociatedNote`) with typed response validation and bounded pagination/retries.
2. Implement Cron poll with safe eligibility, D1 atomic claim/daily budget, deterministic instance IDs, recoverable create failures. No ticket actions outside `[TP-DEMO]`.
3. `scripts/seed-hubspot.ts` creates at most **five** distinctly worded fictitious tickets; reruns don't clone them (save IDs and reconcile). Test: premium activation, duplicate charge, CSV export, password reset and unknown/unrelated issue.
4. Tests: overlapping cron, duplicate discovery, cutoff, out-of-scope ticket, quota edge, HubSpot 429/503, Workflow creation failure/recovery.
Exit: actual free CRM demo ticket is discoverable exactly once; no AI/email yet.

### Phase 2 — Notion + Workers AI grounded proposal
Tasks:
1. `scripts/seed-notion.ts` safely creates/updates five KB pages under root, verifies Notion API read-back; real Notion content must be used, never internal hardcoded substitute in live mode.
2. Implement Notion adapter with pagination and bounded response, deterministic relevancy, no-policy insufficient-evidence path.
3. Implement strict versioned LLM prompt, Workers AI binding, JSON Mode, Zod validation and citation whitelist; clamp sizes and inference budgets.
4. Add Workflow processing state, redacted logs and policy titles/links; do not let model trigger any side effect.
5. Tests: supported billing/access; irrelevant ticket manual review; malicious instructions inside Notion/ticket ignored; nonexistent citation rejected; invalid JSON; Workers AI 429; no docs -> fail-closed.
Exit: real policy passages in Notion generate a structured, validated proposal in Cloudflare; audit evidence saved, no email.

### Phase 3 — Slack human review
Tasks:
1. Implement `chat.postMessage` with Block Kit Approve/Reject, deterministic proposal ID and field summaries. Persist message timestamp and workflow ID.
2. Implement real `/slack/actions` raw-body signature verification, freshness, allowlisted Slack user/workspace/channel, proposal match, D1 first-decision CAS, enqueue workflow `sendEvent`, 3-second acknowledgment; status update via `chat.update` best-effort.
3. Workflow `waitForEvent` 48h + event persistence/reconciliation; reject and expiry terminal state. Insufficient evidence -> only manual/reject, no Approve.
4. Tests for forged signature, timestamp, replay, user mismatch, duplicate clicks, approve/reject race, approval arriving before wait registration, Slack API error.
Exit: deployed Worker can post actionable Slack messages and receive protected decisions; simulate signed callbacks in integration tests, never mark as actual human approval.

### Phase 4 — Resend delivery + HubSpot audit
Tasks:
1. Implement immutable email payload, server-side allowlist, Resend API idempotency, conservative send state machine with `SEND_UNKNOWN` ambiguity.
2. Implement approved-only send, receipt provider ID storage, idempotent CRM audit note associated to ticket and retry note only (never email) when CRM write fails.
3. Tests: reject/expire=no send; insufficient evidence=no send; 2 approvals=one send; provider 409 handling; duplicate Workflow executions; network timeout unknown=no automated duplicate; failed HubSpot audit never resends email; false recipient override ignored; approval not from Slack rejected.
4. Test with verified own inbox in preflight and collect redacted provider acceptance; human can confirm inbox reception after unattended work.
Exit: sending integration works against real free provider within recipient restriction; HubSpot audit note and D1 event trace verified.

### Phase 5 — Real deployment and scenarios
Tasks:
1. Apply all D1 migrations to remote DB with an explicit safe command; run current Wrangler deploy, confirm cron/Workflow/AI bindings and production endpoint. Audit Cloudflare dashboards/usage against Free budget.
2. Run a real smoke using one seeded eligible HubSpot ticket, real Notion content, real Workers AI, real Slack message and (if approval is available) real Resend email; verify HubSpot note association by readback. Never claim E2E if only mocks or signed simulated Slack callback were used.
3. Test 3 mandatory cases: (A) supported ticket + authorized approval + email accepted + CRM note, (B) reject -> no email, (C) unknown policy -> manual review, no send. Also duplicate poll and repeat-click tests.
4. Keep separate evidence labels: `UNIT`, `INTEGRATION_MOCKED`, `LIVE_PROVIDER`, `LIVE_HUMAN_CLICK`, `INBOX_CONFIRMED`. A live human gate may remain pending until operator clicks the previously posted Slack message.
5. Check no secrets tracked with git, logs redacted, dry-run no paid services, quotas remain reasonable.
Exit: stable live deployment and truthful evidence report. When all external human approvals are available, DONE.

### Phase 6 — Portfolio packaging and handoff
Tasks:
1. Write `README.md` (in English) with problem, exact business process, stack, architecture, scope and tradeoffs (why Workflows instead of Mastra; why no vector DB/MCP); concise setup/teardown, billing limitations, test/accuracy caveats, and demo instructions.
2. Write `docs/DEMO.md`: short reproducible click-path in HubSpot, Slack, recipient mailbox; script for 3 scenarios, screenshot checklist, and how to inspect D1 and Workflows.
3. Write `docs/OPERATIONS.md`: troubleshooting auth/rate limits, retry/reconciliation of ambiguous email outcomes, replay safety, cleanup/reset and how to stop Cron/disable live send safely. Give actual commands validated against installed Wrangler version.
4. Write `artifacts/ACCEPTANCE.md`: actual outcomes (not predicted), test counts, external API coverage, deployment URL, masked IDs, missing human approvals if any, risks and blocker/resumption instructions.
5. Clean obsolete TODOs, report final file changes and git status. Do not introduce new features while polishing.
Exit: another developer can understand, reproduce, and truthfully present the project.

## 9. Project skeleton and scripts

Expected repository structure:
```
AGENTS.md
PLAN.md
README.md
package.json
wrangler.jsonc
tsconfig.json
.gitignore
.dev.vars.example
migrations/0001_init.sql
src/index.ts                  # fetch + scheduled entrypoints
src/workflows/ticket-workflow.ts
src/adapters/{hubspot,notion,slack,resend,ai}.ts
src/domain/{state,contracts,policy-selection,prompt}.ts
src/platform/{db,logging,rate-limit,config}.ts
scripts/{preflight,seed-hubspot,seed-notion,smoke,verify-e2e}.ts
test/{unit,contract,integration}/...
docs/{DEMO,OPERATIONS}.md
artifacts/{preflight-redacted.json,ACCEPTANCE.md}
```
Required package scripts: `typecheck`, `lint`, `test`, `test:integration`, `preflight`, `db:migrate:local`, `db:migrate:remote`, `deploy`, `seed:notion`, `seed:hubspot`, `smoke`, `verify:e2e`. Only implement scripts that work; verify names with `npm run` and put exact usage in README. Script names may not hide fake integrations.

## 10. Mandatory scenario tests / quality gates

| ID | Test | Expected |
|---|---|---|
| TP-01 | New eligible ticket | exactly one Workflow and D1 row |
| TP-02 | Duplicate poll / overlap | still one Workflow; no repeated Slack messages |
| TP-03 | Ticket lacks `[TP-DEMO]` or predates cutoff | never processed |
| TP-04 | Notion evidence available | valid category, priority, cited policy, bounded draft |
| TP-05 | No relevant Notion evidence | `NEEDS_MANUAL_REVIEW`, no Approve/send |
| TP-06 | Prompt injection in ticket/KB | untrusted instructions ignored, no unauthorized effects |
| TP-07 | Slack invalid HMAC/stale timestamp/wrong user | 401/403 or safe rejection, zero decision |
| TP-08 | Authorized approve (single) | exactly one Resend request accepted under stable key |
| TP-09 | Authorized reject / expiry | zero email requests |
| TP-10 | Double click + approve/reject race | first CAS wins, single outcome |
| TP-11 | Resend timeout/unknown outcome | `SEND_UNKNOWN`, no blind retry |
| TP-12 | HubSpot note failure after accepted email | resume **audit note only**, never resend |
| TP-13 | Fake customer email in ticket | ignored; sends only to test allowlist |
| TP-14 | Quota cap and API 429 | bounded work and retries, no runaway billing |
| TP-15 | Real Slack message / Cloudflare deployment | provider evidence, no mocked claims |
| TP-16 | Real human clicks Slack, email in inbox | live acceptance (requires human) |

At least 80% meaningful domain/adapter branch coverage where feasible; prioritize the 16 contract tests above over chasing arbitrary global coverage. No requirement to report invented accuracy percentages. Keep tests deterministic; reserve true external verification for explicit smoke scripts.

## 11. Cost controls / acceptance caveats

- Account intention: **Cloudflare Free, HubSpot Free, Notion Free, Slack Free, Resend Free**. Cloudflare free limits are quotas, not guarantees of unrestricted service. Never upgrade automatically.
- At time of writing official Cloudflare documentation lists Workers Free ~100k requests/day (shared), Workflows Free 3k steps/day, D1 Free quotas, Workers AI 10k Neurons/day. These can change; verify your live plan and log any discrepancy. With 20 tickets/day and small prompts, cost should stay under standard free quotas; **verify rather than promise**.
- Free Workers/Workflow CPU limits (often 10ms active CPU) and Service Key availability may be blockers on a specific account. Diagnose; never circumvent by hiding a Paid dependency.
- Resend onboarding sender is for demonstration to account owner only. Never advertise that this MVP supports sending to arbitrary customer addresses. Real email delivery requires inbox verification; a provider-side accepted message is not proof of delivery.
- Slack messaging and Notion/HubSpot APIs may have account-specific permissions/rate limits. The plan insists on preflight rather than undocumented fallbacks.

## 12. Decision register (closed)

| Question | FINAL decision and rationale |
|---|---|
| Multiple plans? | **One PLAN.md** containing all phases, plus **AGENTS.md** governing execution |
| Core runtime | Cloudflare Workers + TypeScript; tiny native HTTP routes |
| Process coordination | Cloudflare Workflows; reliable wait/retry without extra host |
| AI provider | Workers AI; Llama 3.3 70B FP8 Fast; single grounded classification/draft call |
| Mastra/MCP | **No**; adds more complexity than value for this deterministic MVP |
| Storage | D1 with explicit status transitions and idempotent guards |
| Ticket intake | HubSpot CRM Free, Service Key, 5-minute poll, tagged synthetic tickets only |
| Knowledge source | Five Notion pages; direct retrieval + deterministic selection; no vector DB |
| Human control | Slack single allowlisted approver + signed HTTP buttons, 48-hour expiry |
| Sending | Resend onboard sender -> exact registered recipient, after approval only |
| HubSpot final audit | Associated internal note after Resend accepts email; never imply note is outbound email |
| Hosting | One Worker at free `workers.dev`; no custom domain or AWS |
| Client-facing UI | None; rely on native HubSpot/Slack/Notion UIs |
| Data/privacy | Synthetic only; gitignored secrets; logs sanitized |
| Success evidence | Real deployed provider calls; human Slack-click/inbox-receipt gates explicitly separate |

## 13. Official reference URLs (recheck before writing integrations)

- Cloudflare Workflows pricing: https://developers.cloudflare.com/workflows/reference/pricing/
- Cloudflare Workflows events: https://developers.cloudflare.com/workflows/build/events-and-parameters/
- Cloudflare Workflow limits: https://developers.cloudflare.com/workflows/reference/limits/
- Cloudflare Workers scheduled handler: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
- Workers AI model: https://developers.cloudflare.com/workers-ai/models/llama-3.3-70b-instruct-fp8-fast/
- Workers AI JSON Mode: https://developers.cloudflare.com/workers-ai/features/json-mode/
- HubSpot Service Keys: https://developers.hubspot.com/changelog/service-keys
- HubSpot ticket object: https://developers.hubspot.com/blog/a-developers-guide-to-hubspot-crm-objects-ticket-object
- HubSpot CRM search: https://developers.hubspot.com/docs/api-reference/legacy/crm/objects/objects/search/search-objects
- Notion integrations: https://www.notion.com/help/create-integrations-with-the-notion-api
- Slack interactive endpoint: https://docs.slack.dev/interactivity/handling-user-interaction/
- Slack signature: https://api.slack.com/docs/verifying-requests-from-slack
- Resend with Cloudflare: https://resend.com/cloudflare
- Resend idempotency: https://resend.com/changelog/idempotency-keys

**Instruction to executor:** These URLs are **sources of API detail**, not authorization to change product scope. If an endpoint has evolved, select the current equivalent with the same semantics, capture the doc URL and proof in `artifacts/ACCEPTANCE.md`, and keep all security/cost constraints intact.
