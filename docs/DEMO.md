# Demo

This walkthrough uses fictional HubSpot tickets, fictional Notion support policies, one Slack reviewer and the Resend account owner's test mailbox. No customer contacts are mail recipients.

## Before presenting

Check `artifacts/ACCEPTANCE.md` first. Do not present an unfinished phase, mock, setup email or skipped deployment as a working application. Confirm that the secured Worker, final policy seed, scenario Slack messages and verification CLI have actual evidence.

Use the recorded seed manifest rather than creating another set of tickets. The five cases are premium activation, duplicate charge, CSV export, expired password-reset link and an unrelated office-parking question. Only the tagged tickets created after the immutable launch cutoff may be processed.

## Three scenarios

1. **Supported / approve:** Open the duplicate-charge or premium-activation synthetic ticket in HubSpot. Read its proposed Slack reply and linked Notion evidence. The allowlisted human clicks **Approve** once. Verify a durable decision, a provider acceptance ID and one associated HubSpot audit note. Ask the owner to confirm that specific email arrived in the inbox; only then claim delivery.
2. **Supported / reject:** Open a different supported seed case. The same human clicks **Reject**. Verify the persisted terminal rejection and zero email requests. A repeat click must not replace the first decision or send a message.
3. **Unknown policy:** Open the office-parking case. Relevant support evidence should be absent: show the manual-review warning and lack of an Approve button. No email is sent. A fabricated or simulated approve payload cannot override that evidence restriction.

Allow for the five-minute poll interval and provider timing. The 48-hour decision deadline is not a reason to leave a Codex session running merely waiting for a human.

For newly reserved emails, inspect the subject for the original ticket reason (without the `[TP-DEMO]` intake tag), alongside the demo marker and ticket ID. The body must match the approved Slack draft exactly, with no appended category, priority or internal summary. Previously reserved/delivered messages retain their original immutable format; do not resend them to demonstrate the new presentation.

## Current operator acceptance

The existing demonstration has already exercised real providers using clearly labeled signed test callbacks: duplicate charge (`436649189587`) is completed with one accepted email and one verified note; CSV export (`437259884759`) is rejected with zero email attempts. The unknown parking case (`437245230283`) is manual-only. Repeated callbacks did not duplicate decisions or sends. These are **not** human clicks or inbox proof.

In [the demo Slack channel](https://app.slack.com/client/T0C7S09984V/C0C7X4Y182E), the owner physically clicked **Approve** on premium activation (`437231559928`) and **Reject** on password reset (`436737423588`). Approval sent one real demo email to the configured owner only, and the particular mailbox message whose subject contains `Ticket 437231559928` was confirmed received. Current immutable English-input drafts are in Spanish, an explicitly recorded limitation.

The review deadline is48hours from the posted message, not from when this document is opened. If the proposal is expired, do not reset or replay an accepted/ambiguous operation; inspect its durable state first.

These reserved actions have now been completed by the owner on mobile, and the NEW Premium email was confirmed received. Actual verification passed with explicit owner_chat_confirmation bound to the directly verified ticket/receipt/decision timestamp. The earlier billing inbox confirmation was separately recorded and did not turn its simulator approval into a human click. Do not click/replay completed operations to trigger additional emails.

Run `npm run verify:e2e` with protected credentials to recheck evidence. Missing human/inbox testimony returns a pending report and nonzero exit. For a genuinely new authorized acceptance, the operator may use `--record-human-evidence` only after personally clicking/checking the particular email. Explicit owner confirmation in chat may also be recorded with its actual source, never falsely described as interactive-terminal or independent inbox telemetry.

For this Windows installation, the existing protected launcher loads DPAPI credentials without printing them:

```powershell
& 'C:\Users\herre\Documents\Codex\2026-10-09\nu\work\launch-ticketpilot.ps1' -Task 'verify:e2e'
# Owner only, after the physical click and inbox check:
& 'C:\Users\herre\Documents\Codex\2026-10-09\nu\work\launch-ticketpilot.ps1' -Task 'verify:e2e' -TaskArguments @('--record-human-evidence')
```

## What to show

- HubSpot: a `[TP-DEMO]` ticket and its final internal audit note, not a claimed outbound CRM email.
- Notion: the actual fictitious policy page cited by the proposal.
- Slack: category, priority, bounded draft, citations and permitted buttons; later the recorded first decision.
- Cloudflare: sanitized Workflow status and D1 state counts; hide secrets and raw payloads.
- Mailbox: the one message corresponding to the accepted provider ID, with the recipient address cropped or masked in screenshots.

Optional screenshot checklist: ticket, evidence page, Slack review, terminal state, associated audit note and inbox message. Screenshots are presentation assets, not replacements for API readback. During implementation, browser work stays hidden unless the operator must act.

## Evidence language

Say “local integration test” for controlled mocks, “provider accepted” for a Resend success response, and “inbox confirmed” only after human confirmation. Signed test callbacks do not qualify as human approval. Record rejected and insufficient-evidence cases as **no send**, not failed delivery.

## Reproduction safeguards

Do not delete seed manifests or reset the daily quota to force another presentation. Do not restart a completed sending Workflow. Use the operational reconciliation flow for an audit failure or uncertain provider outcome. See [OPERATIONS.md](OPERATIONS.md) and the acceptance report for validated commands and remaining gates.
