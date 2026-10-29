---
name: agent-reach
description: Get a YouTube video's subtitles (web_fetch cannot) to summarise or quote it. Use when the person pastes a YouTube link or asks what a video says.
---
## YouTube

```
agent-reach youtube subtitle <link or 11-character id> [--lang zh-Hans,zh,en,en-orig]
agent-reach youtube read <link or id>
agent-reach youtube search "<query>" --limit 5
```

- `subtitle` returns the full subtitle text (the person's or the channel's own captions, else automatic ones) in the first language you list that exists; `items[0].raw.lang` says which. Put the language you expect first.
- To summarise or quote a video: `read` for the title, channel, date and description, `subtitle` for what is said. Summarise from the subtitles; name the title and channel.
- `NOT_FOUND` "no subtitles in ..." means no captions in those languages. Try another `--lang`; if the video has none, say so. A summary from the description alone must say that it comes from the description only. Speech-to-text of the audio is not available here.
- `PLATFORM_BLOCKED` ("sign in to confirm you are not a bot") is YouTube's verification, not a sign-in the person can give. Stop and say so.
- A long video's subtitles can run to tens of thousands of characters: save them to a file and read them in parts.
- Comments are not available through this app.
