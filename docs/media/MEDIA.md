# Presentation media

These assets explain TicketPilot; they are not substitutes for the acceptance report.

## Real walkthrough capture session

Captured on 2026-10-09 from synthetic ticket `436734313687`, created at `16:00:15.004Z` with marker `TP_CAPTURE_20261009_01`. The normal scheduled workflow posted original revision 1 to Slack at approximately `16:05Z`. The owner authorized this new test. Captures are genuine provider UI screenshots with no reconstructed interface or rewritten content.

| Asset | Actual view |
| --- | --- |
| `live-hubspot-ticket.jpg` | Source ticket title and creation activity |
| `live-hubspot-description.jpg` | Expanded synthetic request description |
| `live-slack-original.jpg` | Same ticket, original AI proposal, policy link and Edit response / Approve / Reject controls |
| `live-slack-edit-modal.jpg` | Owner-written reply, assistant-refined internal summary/reason at owner request, before saving |
| `live-slack-edited.jpg` | Saved revision 2 with the exact owner-written reply and approval controls |
| `live-slack-approved.jpg` | Same Slack message after approval, showing the recorded allowlisted actor; the UI replaces the proposal, so correlate its timestamp with the earlier captures |
| `live-gmail-received.jpg` | Actual Gmail inbox message for ticket436734313687, with the exact revised body; recipient details remain collapsed |

The owner opened and edited the modal; the assistant refined the internal explanation and aligned the summary with manual investigation, then saved revision 2. Following the owner approval handoff, the same Slack message (`1791561929.133279`) showed a recorded approval. Approval was recorded at `2026-10-09T16:11:36.621Z`. The owner opened the received email, and the assistant independently inspected the matching Gmail subject and exact body. The read-only `verify:edit` check passed for approved/sent revision 2, exact latest text/payload hash, and original plus edited versions in one associated HubSpot note. The captures show states, not a continuous recording of the physical click.

The screenshots contain no full email address or credentials; normal provider account/channel chrome remains visible. Gmail recipient details are collapsed, and its sender address is naturally truncated in the captured viewport. No image content was generated or rewritten. Earlier edited-delivery acceptance below belongs to a different ticket.

## Earlier media

| Asset | Provenance | What it establishes |
| --- | --- | --- |
| `architecture.svg` | Original code-native architecture diagram | Components and control boundaries; not runtime evidence |
| `slack-manual-review.jpg` | Actual Slack UI, captured on 2026-10-09 from the existing synthetic no-evidence case | Manual-review warning and no Approve button; not proof of edited delivery or inbox arrival |
| `walkthrough.gif` | Original six-scene, 24-second illustrative animation using fictional English copy | Intake → evidence → review → edit → explicit approval → send/audit; not a provider screencast |
| `walkthrough.mp4` | H.264 version of the same illustration, without audio | Downloadable video explainer; not a live recording |
| `walkthrough-poster.png` | Still from the illustrated edit scene | Static accessible preview |

The screenshot excludes the account contact/profile panel and shows no credentials, full email address or customer ticket content. Slack's account/channel chrome remains visible. No new ticket, inference, approval, message or email was created to obtain it. The existing completed acceptance ticket was not reopened. The illustrated reply is not copied from the owner's real edited message.

The diagram and animation reflect implemented behavior: a save is not an approval, old revisions cannot send, internal metadata stays out of the email, no evidence means no send, and the recipient is fixed server-side. A human edit is not a new AI inference or automatic validation of a changed solution. The animation compresses timing; actual intake is a five-minute poll and reviews expire after 48 hours. Only the successful illustrated path is shown; unknown send outcomes require separate reconciliation rather than blind resend.

Actual edited-delivery evidence is in [ACCEPTANCE.md](../../artifacts/ACCEPTANCE.md), with owner inbox testimony labeled separately from provider readback.

## Rebuild the illustration

Optional media tooling is separate from the application and does not change its npm dependencies. Use Python with Pillow and `imageio-ffmpeg==0.6.0` installed in an isolated environment:

```sh
python docs/media/render.py
```

The renderer uses installed Windows Segoe UI fonts. On another OS, adjust `FONT_DIR` and font filenames to an installed TTF equivalent. `imageio-ffmpeg` supplies its encoder; it is not a deployed Worker dependency. The renderer only writes its four generated presentation files in this directory; it makes no provider/network calls and does not regenerate the genuine Slack screenshot or the architecture SVG.

The files may be viewed locally or in this repository. Publishing the repository publicly is a separate owner decision; this task does not change visibility.
