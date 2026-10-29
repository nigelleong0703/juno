---
name: agent-reach
description: Read a GitHub repo's README, or an issue or pull request with its comments. Use for github.com issue, PR or repo links.
---
## GitHub

```
agent-reach github read <owner/repo>                              # description and README (first 50,000 characters)
agent-reach github read https://github.com/<owner>/<repo>/issues/<n>   # an issue or a pull request, with its first 50 comments
agent-reach github search "<query>" --limit 5                     # repositories
```

- An issue or pull request comes back as its title, state and labels (`raw`), the body and the comments in `text`. A pull request's diff and review comments are not included; say so if the person asks about the code change.
- Public repositories only. Without a sign-in GitHub allows about 60 requests an hour from this computer: `RATE_LIMITED` means stop and tell the person, not retry.
- For a file in a repository, `web_fetch` on its raw address is the right tool, not Reach.
