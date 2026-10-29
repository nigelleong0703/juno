---
name: agent-reach
description: Search Bilibili, see what is trending, read a video's details. Use for Bilibili (B站) questions or bilibili.com and b23.tv links.
---
## Bilibili

```
agent-reach bilibili search "<query>" --limit 5
agent-reach bilibili hot --limit 10
agent-reach bilibili read <BV id or link>
agent-reach bilibili subtitle <BV id or link>
```

- `search` and `hot` need no sign-in and are the reliable ones; each item has the title, uploader and link (`hot` also a description).
- `read` returns one video's title, uploader, description and stats (`raw`). Bilibili sometimes refuses a computer's video-detail requests with a risk-control block (HTTP 412, which shows up as `UPSTREAM_BROKEN`). Then say that Bilibili is not giving video details to this computer right now, give what search or the hot list already showed, and do not retry.
- `subtitle` needs the person's Bilibili sign-in on this computer. On `NEED_LOGIN`, follow "Signing in" in the common rules (the login page is in the error's hint), then retry once. Bilibili may still refuse this computer's subtitle request even when signed in (`UPSTREAM_BROKEN`, a risk-control page): then say Bilibili is not giving subtitles to this computer right now. Do not say the video has no subtitles unless `NOT_FOUND` says so.
- A `b23.tv` short link is fine as a target.
- Results are in Chinese as the platform wrote them; translate or summarise in the person's language when they ask.
