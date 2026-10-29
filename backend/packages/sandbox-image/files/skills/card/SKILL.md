---
name: card
description: Turn an HTML design into a PNG image card (share card, poster) or a short animated MP4 video.
---
# Image cards and short videos

1. Write one self-contained HTML file in `/workspace` (inline CSS, no network; local images by absolute path; fonts: Inter, Noto Sans CJK, Noto Color Emoji). Size the page to the output, e.g. `body{margin:0;width:1080px;height:1350px}`.
2. PNG: `/opt/juno/skills/card/card_tool.py png /workspace/card.html /workspace/card.png --width 1080 --height 1350`
3. MP4: animate with CSS animations/transitions (or JS timers); `card_tool.py mp4 /workspace/card.html /workspace/card.mp4 --width 1080 --height 1350 --seconds 3 --fps 10` renders it frame by frame (max 15 s, 30 fps; about 1 s of work per 4 frames).
4. Look at the PNG (or a frame) before delivering; deliver with `artifact_publish {path, title}`.
