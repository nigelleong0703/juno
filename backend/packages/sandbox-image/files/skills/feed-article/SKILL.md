---
name: feed-article
description: Research a topic and publish a complete illustrated Feed article with images between the prose sections, each with a caption and its source next to it.
---
# Illustrated Feed articles

This skill covers the Feed article with pictures BETWEEN the paragraphs, not just a cover thumbnail. It applies whenever the article form is wanted: an explicit user request, or a proactive or routine post the owner authorized. It also applies to text-only articles: follow everything below except the image steps.

The article must stand on its own: everything the user needs is in the post, nothing points back to this chat.

## Research first, then write

- Substantive research belongs in a background helper: child_spawn with notify true. The child starts fresh and does not see this chat, so its prompt must be self-contained: the topic, what to find, this skill name (skill_read feed-article), and exactly what to hand back (see the handoff section below).
- If you are yourself an assigned child or helper, do the research yourself instead of spawning another child; one delegation level is enough.
- Date coverage comes from actual reading: web_search to find stories, then web_fetch on each story page (never the snippet alone). Say which dates the coverage actually spans and name anything requested but missing. A 403 or bot check is not a source: try the AMP, print, or syndicated copy, or the primary announcement it cites; when nothing opens, say so and do not cite the unopened page.
- Uncertainty is explicit: mark what is confirmed, what is inferred, and what remains unknown. Never present a guess as a fact and never claim anything was tested or visited in person.
- When the user explicitly asked for the article but nothing verifiable turned up, do not publish an empty or guessed post: explain in the chat what was missing and what would unblock it. Finishing with an empty reply (which posts nothing) is only for the proactive case where there is genuinely nothing new to report.

## Images between sections, not a thumbnail

- A few images, only where a picture carries information the prose cannot: the subject, a chart, a place, a product. No fixed count, no fixed template; the story decides.
- Each image goes inline in the body with real Markdown, placed next to the paragraph it illustrates, followed by a one-line caption and the standalone source link for that paragraph.
- Sources live next to the paragraph they support as plain Markdown links. Never write see-the-chat or link-in-chat words that send the reader back here.
- Look at every image before using it: web_fetch on the image URL shows the picture. Skip logos, icons, banners that only carry a site name, and anything never looked at. Every URL must be https.
- The cover imageUrl stays optional and separate: one thumbnail for the card, with its own caption, never a substitute for the inline pictures. Leave the cover out rather than attaching a picture that belongs to an unrelated paragraph.

## Supported authoring syntax

- Inline images and reference images (with the reference defined in the same body). Code fences and inline code spans are examples, never published pictures: anything that looks like an image inside them is not verified and not rendered.
- HTML img tags are not supported: write Markdown images instead. The server verifies every rendered inline image and refuses the post when one is unavailable, private, non-https, or not a real picture, so check each URL first.

## What the child hands back

- The finished body Markdown (images already interleaved, captions and source links in place), the title, the two-sentence summary, and the optional cover imageUrl with its caption.
- One line per image: what it shows and the page it came from. Results longer than the handoff limit arrive truncated with a note that the full result is kept as an artifact: in that case read the full result with output_read before publishing and never publish from the summarized head alone.
- The parent's only remaining step is the feed_post call; it does not research again and does not ask the user for anything the child already resolved.

## Finish truthfully

- Publish only when there is something new, specific, and sourced. Never paste the article into the chat and never claim a published article the tool did not confirm.
- The reply here stays short: what was posted and what was left out.
