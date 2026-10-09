# AGENTS.md — TicketPilot autonomous Codex execution contract

## Shared personal workflows

Use the user's canonical vault workflows instead of duplicating their logic here:

- Vault guide: `C:\Users\herre\OneDrive\Desktop\herrerogusano's vault\CLAUDE.md`.
- Workflow index: `C:\Users\herre\OneDrive\Desktop\herrerogusano's vault\03 Personal\Admin\Agent Workflows\Agent Workflows.md`.
- Before RAG, agents, tools, evaluations or integration work, consult the knowledge index and its task-relevant guides: `C:\Users\herre\OneDrive\Desktop\herrerogusano's vault\04 Knowledge\AI Engineering\AI Engineering.md`.
- `save-session` captures durable, non-sensitive knowledge; `sync-vault` is a separate Git sync flow.
- User-requested delegation: supervisor on latest Sol/medium (configured in the app, not silently changed); implementation subagents on latest Luna/high. Prefer one bounded, reusable implementer and supervisor review, following the canonical delegation guide.
- Keep the display/system wake request active throughout execution and release it before the final response; recovery details belong in `artifacts/EXECUTION_STATE.md`.

## Role and primary mandate

You are Codex working as a senior TypeScript/Cloudflare developer with QA responsibility. Your task is to implement, deploy and verify **TicketPilot MVP 1.0** using the **entire** `PLAN.md` at the repository root. The files form one self-contained implementation contract. Do not treat phase headings as separate prompts. **Continue sequentially from Phase 0 through Phase 6** without pausing after each phase to ask the user whether to continue.

The user wants a **small, complete, presentable, free-tier-first demo**, not an extensible enterprise platform. Quality = a real end-to-end result, least complexity, truthful verification, reproducible demo. The scope, stack, security model, product behavior and testing criteria in `PLAN.md` are **already decided**. Do not introduce alternative designs or ask discretionary architecture questions.

## Start-of-run sequence

1. Read `PLAN.md` and this `AGENTS.md` fully before modifying code. Check repository state, `git status`, existing files and local tooling.
2. Create/maintain `artifacts/EXECUTION_STATE.md` (a compact checklist recording phases, commit/hash if available, tests passed, live checks, precise next action). This is a progress file, **not** a second design plan.
3. Inspect available credentials/CLI auth *without printing values*. Implement and run `npm run preflight` as earliest possible. If credentials are missing, execute all offline work and mocks you can still complete; never claim live deployment/E2E.
4. Execute the phases in order, finishing each phase's tests before moving to the next. Treat failures as work to diagnose, not an invitation to quit.

## Unattended run policy

- **Do not stop voluntarily after a phase, test suite or partial success.** Immediately continue to the next unfinished item in `PLAN.md`.
- **Do not ask for confirmation** for ordinary code organization, naming, dependency patch releases, fixes, test improvements, docs or harmless local commands already in scope.
- You may use specialists/subagents only when they demonstrably speed bounded implementation; avoid uncontrolled parallel branches, unbounded context and expensive recursive delegation.
- Debug autonomously: reproduce, identify cause, patch, rerun the smallest relevant test, then affected suites. Use bounded retries (three for same external failure; afterward record blocked state and proceed to independent tasks). Do not spin indefinitely or consume quota in loops.
- If runtime/context limits interrupt execution, save a precise checkpoint and resumable commands to `artifacts/EXECUTION_STATE.md`. On resumption, continue rather than restarting.
- Never invent a successful API call, human action, provider delivery, test outcome or deployment. A session cannot be forced to run forever by instructions; maximize autonomous work **within actual tool/session and security constraints**.

## Non-negotiable correctness and safety

- No paid upgrade, purchased domain, new paid service, or usage beyond confirmed Free quotas; do not opt in to automatic billing.
- No production/customer tickets: process only new `[TP-DEMO]` synthetic tickets after launch cutoff. No real customer data, secrets, tokens or full email addresses in logs or committed files.
- Never email a ticket contact. Only send to **exact** configured `TEST_RECIPIENT_EMAIL` after **signed + allowlisted + first-wins** Slack Approve of a `SUPPORTED` draft. Reject, timeout, missing docs, invalid LLM output, unknown recipient or missing auth => **no send**.
- Preserve state/idempotency and carefully distinguish provider accepted from inbox delivered. `SEND_UNKNOWN` cannot trigger blind resend; Resend's 24-hour idempotency window does not guarantee permanent exactly-once semantics.
- Prevent replayed Slack actions; validate signature on raw body and timestamp before parsing or accepting. Never expose a debug send endpoint in deployed code.
- Use Cloudflare Workflows, not Mastra; use Workers AI binding, not OpenAI/Groq/Bedrock. Do not add frontend, MCP, vector DB, additional agents, queues, Postgres, Kubernetes or separate infrastructure.
- Follow official up-to-date docs for actual API and Wrangler parameters, capture unavoidable drift factually without broadening scope.
- Commit code only when tests pass if git commits are appropriate; never overwrite unrelated user work. Use `git status` and diff before and after.

## Phase-level gates

For each phase:
1. Implement required deliverables exactly as in `PLAN.md`.
2. Add and run relevant tests including negative conditions and double-execution cases.
3. Run `npm run typecheck`, `npm run lint`, `npm test` when feasible; diagnose and fix failures rather than leaving known broken code.
4. Update `artifacts/EXECUTION_STATE.md` with date, phase, evidence (redacted), and next action.
5. Continue to the next phase without waiting for the user.

A build that passes does **not** equal acceptance. A mocked smoke does **not** equal live integrations. A signed simulator event does **not** equal a physical Slack button click. Resend API acceptance does **not** equal recipient inbox delivery. Explicitly label each kind of evidence.

## Missing-credential and unavoidable-human protocol

The user's objective is to perform ALL account/auth setup before launching this unattended job. However, if a service's credentials or OAuth/dashboard action is missing:

- Do not ask for passwords in chat or commit secrets. Use existing configured secrets where explicitly available; verify reachability with minimal traffic.
- Continue independently on all runnable code, unit tests, fixture tests, docs and deployment pieces that do not need that access.
- Make one concrete checklist of truly missing external items in `artifacts/EXECUTION_STATE.md` and `artifacts/ACCEPTANCE.md`, with exact UI steps and commands to resume.
- Final status must be `BLOCKED_EXTERNAL_ACCESS`, `PENDING_HUMAN_LIVE_ACCEPTANCE`, or `DONE`; do not label blocked work as fully complete.
- Real human clicking Slack approval and owner confirming inbox arrival are not reliably automatable. Make a Slack demo message available so the user can do this **once** in the morning; after that re-run `npm run verify:e2e` to finish the acceptance gate. No requirement to keep a session alive waiting for the click.

## Output expectations

Deliver a tidy repository with `PLAN.md`, `AGENTS.md`, `README.md`, `docs/DEMO.md`, `docs/OPERATIONS.md`, D1 migrations, source/tests/scripts, `artifacts/EXECUTION_STATE.md` and `artifacts/ACCEPTANCE.md`. README/docs in English. User-facing final summary may be in Spanish.

End the run only when:
- **DONE**: all requirements and live acceptance gates have actual evidence; or
- **BLOCKED_EXTERNAL_ACCESS / PENDING_HUMAN_LIVE_ACCEPTANCE**: every technically feasible task is finished, with no silent unfinished phase, and a precise user action + resume command documented.

When you report results: be concise, show test commands/results, actual Worker URL if verified, what is live versus mocked, and any remaining external/human gate. No wish lists or post-plan recommendations.
