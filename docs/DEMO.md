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
