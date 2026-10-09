"""Rebuild illustrative presentation media only. No provider/network calls.

Optional tooling: Pillow and imageio-ffmpeg. See MEDIA.md. This does not render
provider UI or manufacture acceptance evidence. It creates original diagrams.
"""

from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import imageio_ffmpeg

OUT = Path(__file__).resolve().parent
WIDTH, HEIGHT = 1200, 676
BG, PANEL, BORDER = '#0b1728', '#15253b', '#30445e'
WHITE, MUTED, MINT, AMBER = '#eef3fa', '#a9b9cf', '#79e4bc', '#f1c6a2'
FONT_DIR = Path('C:/Windows/Fonts')


def font(size, bold=False):
    # Set these to equivalent installed TTF fonts when rebuilding off Windows.
    return ImageFont.truetype(str(FONT_DIR / ('segoeuib.ttf' if bold else 'segoeui.ttf')), size)


def text(draw, xy, value, size=22, color=WHITE, bold=False):
    draw.text(xy, value, font=font(size, bold), fill=color)


SCENES = [
    ('Intake', 'A ticket, not a blank check.', 'Only new, tagged synthetic tickets enter the workflow.',
     'HUBSPOT / FICTIONAL TICKET', 'Premium activation',
     ['[TP-DEMO] Premium activation', 'I have paid, but Premium features are not available.', '',
      'A five-minute poll finds eligible tickets.', 'D1 claims each ticket once and reserves the budget.'],
     'DISCOVERED', 'No historical tickets. No real customer data.'),
    ('Evidence', 'Ground the reply in policy.', 'Short Notion policies are retrieved before the model drafts.',
     'NOTION + WORKERS AI', 'Evidence before an answer',
     ['Selected policy: premium-activation', 'Direct retrieval from the fictional support knowledge base.', '',
      'Workers AI proposes a bounded, structured draft.', 'The backend validates schema and policy references.'],
     'SUPPORTED', 'No evidence? Manual review. No Approve. No email.'),
    ('Review', 'Put a person in control.', 'Slack shows the proposed response and linked policy evidence.',
     'SLACK / REVIEW', 'Revision 1 · AI draft',
     ['Internal summary: Premium features are not available.', '', 'Proposed response:',
      'Please sign out and back in to refresh your Premium access.', '',
      'Edit response          Approve          Reject'],
     'AWAITING_APPROVAL', 'Category, priority and summary stay internal.'),
    ('Edit', 'Change the words. Keep the history.', 'A human may adjust the reply and the internal summary.',
     'SLACK / EDIT RESPONSE', 'Save a new revision',
     ['Response: Sign out and back in to refresh Premium access.', 'If it is still unavailable, tell us what you see.', '',
      'Internal summary: Refresh access; review if unresolved.', 'Reason: Clarify the next step when access remains missing.', '',
      'Save revision          Cancel'],
     'SAVE ONLY', 'Cancel keeps the original. Saving sends nothing.'),
    ('Approve', 'Approve the latest version.', 'The refreshed card requires an explicit decision.',
     'SLACK / REFRESHED REVIEW', 'Revision 2 · human edited',
     ['Sign out and back in to refresh Premium access.', 'If it is still unavailable, tell us what you see.', '',
      'Approve response revision 2?          Approve / Cancel', '',
      'Stale revision 1 buttons and forms fail closed.'],
     'CONFIRM APPROVAL', 'First decision wins. Editing is locked after a decision.'),
    ('Audit', 'Send the approved text. Record it.', 'Resend acceptance and the CRM audit are separate outcomes.',
     'RESEND + HUBSPOT + D1', 'Exact text. Durable provenance.',
     ['Email subject: Ticket reason + demo marker + ticket ID', 'Body: exactly the approved revision 2 response', 'Recipient: fixed configured test recipient only', '',
      'Audit: original, edit reason, actor, time and final text', 'D1: revision hashes, decision, payload and provider receipt'],
     'COMPLETED', 'Inbox delivery requires separate owner confirmation.'),
]


def frame(index, progress=1.0):
    image = Image.new('RGB', (WIDTH, HEIGHT), BG)
    d = ImageDraw.Draw(image)
    stage, title, subtitle, label, card_title, lines, status, footer = SCENES[index]
    text(d, (44, 27), 'TICKETPILOT', 20, MINT, True)
    text(d, (885, 29), 'AI DRAFTS. HUMAN DECIDES.', 15, MUTED)
    for i, scene in enumerate(SCENES):
        x = 44 + i * 187
        color = MINT if i <= index else BORDER
        d.rounded_rectangle((x, 78, x + 167, 117), radius=9, fill=PANEL, outline=color, width=2)
        text(d, (x + 12, 85), f'{i + 1:02d}  {scene[0]}', 17, color, True)
    text(d, (44, 143), title, 36, WHITE, True)
    text(d, (44, 195), subtitle, 21, MUTED)
    d.rounded_rectangle((44, 249, 1156, 546), radius=16, fill=PANEL, outline=BORDER, width=2)
    text(d, (68, 265), label, 14, MINT, True)
    text(d, (68, 294), card_title, 25, WHITE, True)
    for i, line in enumerate(lines):
        text(d, (68, 340 + i * 25), line, 19, MUTED if i == 0 else WHITE)
    d.rounded_rectangle((912, 269, 1132, 305), radius=8, fill='#163c3b')
    text(d, (926, 276), status, 15, MINT, True)
    text(d, (44, 566), footer, 21, AMBER, True)
    d.rounded_rectangle((44, 612, 1156, 617), radius=2, fill=BORDER)
    d.rounded_rectangle((44, 612, 44 + int(1112 * (index + progress) / 6), 617), radius=2, fill=MINT)
    text(d, (44, 637), 'ILLUSTRATIVE ANIMATION / SYNTHETIC DATA / NOT A LIVE RECORDING', 14, MUTED)
    text(d, (1092, 637), f'{index + 1} / 6', 14, MUTED)
    return image


def main():
    # GIF embeds directly in a GitHub README; MP4 is the smaller playback version.
    frames = [frame(i, (j + 1) / 8) for i in range(6) for j in range(8)]
    frames[0].save(OUT / 'walkthrough.gif', save_all=True, append_images=frames[1:],
                   duration=500, loop=0, optimize=True)
    frame(3).save(OUT / 'walkthrough-poster.png')
    writer = imageio_ffmpeg.write_frames(str(OUT / 'walkthrough.mp4'), (WIDTH, HEIGHT),
        fps=12, codec='libx264', pix_fmt_out='yuv420p', macro_block_size=1,
        output_params=['-movflags', '+faststart', '-crf', '22'], ffmpeg_log_level='error')
    writer.send(None)
    try:
        for picture in frames:
            for _ in range(6):
                writer.send(picture.tobytes())
    finally:
        writer.close()
    print('Presentation media generated: 24 seconds; no provider calls.')


if __name__ == '__main__':
    main()
