---
id: tool.artifact_publish
placement: T
vars: []
---
Publish a finished file from this computer as an artifact in the chat. Supported: .html/.htm (an interactive page shown in a sandboxed frame; it must be one self-contained file, and may only load scripts, styles, fonts and data from https origins you list in a sibling <name>.csp.json as {"resourceDomains": ["https://cdn.jsdelivr.net"]}), .pdf/.docx/.pptx/.xlsx/.md (a file card with preview), .png/.jpg/.jpeg/.webp/.gif (image), .mp4/.webm (video). To change something already published (the "Published in this chat" note and earlier results list artifactIds and files), edit that file and publish it again with its artifactId: that adds a new version of the same artifact. Never publish a new artifact for the same thing. Anything else: use send_file. Never paste the file into your reply.
