---
name: agent-reach
description: Search Xiaohongshu (小红书) notes, read one note and its comments. Use for 小红书 or Xiaohongshu questions and xiaohongshu.com / xhslink.com links. Needs the person's sign-in on this computer.
---
## Xiaohongshu

```
agent-reach xiaohongshu search "<query>" --limit 5
agent-reach xiaohongshu read <full note link, with the xsec_token that search returned>
agent-reach xiaohongshu comments <full note link, with the xsec_token> --limit 20
```

- Every action needs the person to be signed in to Xiaohongshu on this computer. If the first call answers `NEED_LOGIN`, follow "Signing in" in the common rules, then retry the same command once.
- `search` gives each note's title, author, likes, date and link. Use a note's link for `read` and `comments`; the link must keep its `xsec_token`, or the note will not open.
- `read` gives the note's text and its engagement numbers. You get the text only: say so when the note is mostly pictures or video.
- `comments` gives the top-level comments that have loaded, up to 50, without replies. It is not a complete list; say so.
- Results are in Chinese as the platform wrote them; translate or summarise in the person's language when they ask.
